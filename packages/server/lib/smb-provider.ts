import {track,gracefulStop} from './process';
import {AsyncLocalStorage} from 'node:async_hooks';
import {join,dirname,isAbsolute} from 'node:path';
import {existsSync,lstatSync,readdirSync} from 'node:fs';
import {readPrivateJson} from './connectors/private-json';
import {homedir} from 'node:os';
import {validateCommit} from './portable-schema';
import {validateDeletionRecord,validatePublicationIntent,validateRevisionFence,validateArtifactIdentity} from './portable-deletion-schema';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import type {LibraryProvider,RemoteTransaction,TransactionContext,QuotaBudget,PendingRemoteTransaction} from './portable-provider';
import type {PortableCommit,DeletionCapabilities,RemoteInventory} from '@heed/shared';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const HASH=/^[a-f0-9]{64}$/;
const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const encode=(value:unknown)=>Buffer.from(JSON.stringify(value));
export interface SmbIdentity {type:'smbfs';fsid:string;sourceHash:string;mountPath:string;readOnly:boolean}
export interface SmbProbe {identity:SmbIdentity;security:'signed'|'encrypted'|'unknown';dialect:string;authentication:'macOS-session';atomicOperations?:boolean}
export interface SmbBinding {id:string;name:string;root:string;identity:SmbIdentity;destinationId:string;destinationVersion?:1|2;connectionGeneration?:string;readOnly:boolean;security:'signed'|'encrypted'|'unknown'}
export interface SmbRequest {action:'probe'|'library'|'header'|'prepare'|'create'|'test-write'|'list'|'read'|'write'|'transaction';root:string;identity?:SmbIdentity;destinationId?:string;stagingId?:string;path?:string;maxBytes?:number;bytes?:number;sha256?:string;header?:unknown}
export interface SmbNative {
 transaction?(request:SmbTransactionRequest,signal?:AbortSignal):Promise<SmbTransactionNative>;
 json(request:SmbRequest,signal?:AbortSignal):Promise<unknown>;
 read(request:SmbRequest,max:number,signal?:AbortSignal):Promise<Uint8Array>;
 stream(request:SmbRequest,max:number,signal?:AbortSignal):AsyncIterable<Uint8Array>;
 write(request:SmbRequest,source:AsyncIterable<Uint8Array>,signal?:AbortSignal):Promise<void>;
}
export const SMB_UNSUPPORTED_FILESYSTEM_NOTICE='SMB filesystem does not support the required atomic operations. Use a compatible destination; existing files are preserved.';
export function unsupportedSmbFilesystem(){return Object.assign(new Error(SMB_UNSUPPORTED_FILESYSTEM_NOTICE),{code:'unsupported-filesystem'});}
function failure(){return new Error('SMB operation unavailable. Check the mounted destination, access and library integrity.');}
function path(value:string){if(typeof value!=='string'||value.length>512||! /^(meetings|commits|objects)\/[A-Za-z0-9_./-]+$/.test(value)||value.split('/').some(p=>!p||p==='.'||p==='..'))throw new Error('Invalid SMB library path.');return value;}
function count(value:unknown):value is number{return typeof value==='number'&&Number.isSafeInteger(value)&&value>=0&&value<=8_000_000_000_000;}
export function smbProbe(value:unknown):SmbProbe {
 const p=value as SmbProbe;
 if(!p||typeof p!=='object'||Object.keys(p).filter(key=>key!=='atomicOperations').sort().join(',')!=='authentication,dialect,identity,security'||p.atomicOperations!==undefined&&typeof p.atomicOperations!=='boolean'||!p.identity||Object.keys(p.identity).sort().join(',')!=='fsid,mountPath,readOnly,sourceHash,type'||p.identity.type!=='smbfs'||typeof p.identity.fsid!=='string'||!p.identity.fsid.length||!HASH.test(p.identity.sourceHash)||typeof p.identity.mountPath!=='string'||!p.identity.mountPath.startsWith('/')||typeof p.identity.readOnly!=='boolean'||!['signed','encrypted','unknown'].includes(p.security)||typeof p.dialect!=='string'||p.authentication!=='macOS-session')throw failure();
 return structuredClone(p);
}
export function destinationHeader(value:unknown):{format:'heed-portable-library';schemaVersion:1|2;destinationId:string}|null {
 if(value===null)return null;
 const h=value as {format:string;schemaVersion:number;destinationId:string};
 if(!h||typeof h!=='object'||Object.keys(h).sort().join(',')!=='destinationId,format,schemaVersion'||h.format!=='heed-portable-library'||![1,2].includes(h.schemaVersion)||!UUID.test(h.destinationId))throw new Error('Unsupported or corrupt SMB library.');
 return h as {format:'heed-portable-library';schemaVersion:1|2;destinationId:string};
}

interface SmbTransactionNative extends SmbNative {
 command(action:string,value?:Record<string,unknown>,signal?:AbortSignal):Promise<unknown>;
 close():Promise<void>;
}
export interface SmbTransactionRequest extends SmbRequest {action:'transaction';appDir:string;operationId:string;deviceId:string;kind:'read'|'publish'|'delete';readOnly:boolean;security:SmbBinding['security'];connectionGeneration:string}
/** One bounded pipe protocol; its guardian retains native descriptors/locks until reaped. */
class SmbRpcSession implements SmbTransactionNative {
 private buffer=Buffer.alloc(0);private reader:ReadableStreamDefaultReader<Uint8Array>;private sequence=0;
 private busy:Promise<void>|null=null;private closed=false;private checkpointed=false;private dead=false;
 private progress?:()=>void;
 private initialized=false;private completed=false;private closing?:Promise<void>;private signalAbort?:()=>void;private openingAbort?:ReturnType<typeof setTimeout>;
 constructor(private child:ReturnType<typeof Bun.spawn>,private cleanup:()=>void,private abort:()=>void,private signal?:AbortSignal){this.reader=(child.stdout as ReadableStream<Uint8Array>).getReader();this.signalAbort=()=>{if(!this.initialized)this.openingAbort??=setTimeout(()=>void this.finish(),1500);else if(!this.busy)void this.close().catch(()=>{});else void this.finish();};signal?.addEventListener('abort',this.signalAbort,{once:true});if(signal?.aborted)this.signalAbort();}
 private async bytes(count:number){while(this.buffer.length<count){const {done,value}=await this.reader.read();if(done)throw failure();this.progress?.();this.buffer=Buffer.concat([this.buffer,value]);}const value=this.buffer.subarray(0,count);this.buffer=this.buffer.subarray(count);return value;}
 private async frame(max=64_000_000){for(;;){const newline=this.buffer.indexOf(10);if(newline>=0){if(newline>max)throw failure();const line=this.buffer.subarray(0,newline);this.buffer=this.buffer.subarray(newline+1);return JSON.parse(line.toString('utf8'));}if(this.buffer.length>max)throw failure();const {done,value}=await this.reader.read();if(done)throw failure();this.progress?.();this.buffer=Buffer.concat([this.buffer,value]);}}
 async ready(){const deadline=setTimeout(()=>void this.finish(),120_000);try{const frame=await this.frame(4096);if(frame.ok===false)throw Object.assign(new Error(smbNativeMessage(frame.error)),{code:frame.error});if(frame.ok!==true||frame.ready!==true||typeof frame.checkpointed!=='boolean'||frame.completed!==undefined&&frame.completed!==true)throw failure();this.checkpointed=frame.checkpointed;this.completed=frame.completed===true;this.initialized=true;if(this.openingAbort)clearTimeout(this.openingAbort);if(this.signal?.aborted){await this.close();this.signal.throwIfAborted();}}catch(error){await this.finish();throw error;}finally{clearTimeout(deadline);}}
 private async *rpc(action:string,value:Record<string,unknown>={},source?:AsyncIterable<Uint8Array>,signal?:AbortSignal):AsyncGenerator<Uint8Array,unknown>{
  if(this.closed||this.dead||this.completed)throw new Error('SMB transaction is closed.');if(this.busy)throw new Error('SMB transaction I/O is busy.');signal?.throwIfAborted();
  let done!:()=>void;this.busy=new Promise<void>(resolve=>done=resolve);const id=++this.sequence;
  const abort=()=>{this.dead=true;this.abort();};signal?.addEventListener('abort',abort,{once:true});
  let inactivity:ReturnType<typeof setTimeout>|undefined;this.progress=()=>{if(inactivity)clearTimeout(inactivity);inactivity=setTimeout(abort,120_000);};this.progress();
  // Liveness frames keep a healthy slow native hash/fsync alive, but cannot
  // authorize an unbounded blocked filesystem call. Recording abort is separate.
  const declared=Number(value.bytes??value.maxBytes??0);
  const budget=action==='inventory'||action==='list'?600_000:Math.min(1_800_000,120_000+(Number.isSafeInteger(declared)&&declared>0?Math.ceil(declared/1_048_576)*1000:0));
  const deadline=setTimeout(abort,budget);
  let sending:Promise<void>|undefined;let recoverable=false;
  try{
   if(['write','write-deletion','write-fence','write-pending','retire-pending','remove-exact'].includes(action))this.checkpointed=false;
   const request=encode({id,action,...value});if(request.length>2_000_000)throw failure();
   const sink=this.child.stdin as Bun.FileSink;await sink.write(request);await sink.write('\n');await sink.flush();this.progress();
   sending=(async()=>{if(!source)return;let sent=0;for await(const chunk of source){signal?.throwIfAborted();if(this.closed||this.dead)throw failure();sent+=chunk.length;if(sent>Number(value.bytes))throw failure();await sink.write(chunk);await sink.flush();this.progress?.();}if(sent!==value.bytes)throw failure();})().catch(error=>{abort();throw error;});sending.catch(()=>{});
   // Read concurrently so a rejected frame cannot leave a producer blocked on a full pipe.
   for(;;){if(this.closed||this.dead)throw new Error('SMB transaction is closed.');const response=await this.frame();signal?.throwIfAborted();if(response.id!==id)throw failure();if(response.progress===true){if(Object.keys(response).sort().join(',')!=='id,progress')throw failure();continue;}if(response.ok===false){await sending;recoverable=true;throw Object.assign(new Error(smbNativeMessage(response.error)),{code:typeof response.error==='string'?response.error:'transaction-unavailable'});}if(response.bytes!==undefined){if(!Number.isSafeInteger(response.bytes)||response.bytes<1||response.bytes>131072)throw failure();yield await this.bytes(response.bytes);continue;}if(response.ok!==true)throw failure();await sending;if(action==='checkpoint')this.checkpointed=true;return response.value;}
  }catch(error){if(!recoverable||signal?.aborted){await this.finish();if(sending)await Promise.race([sending.catch(()=>{}),this.child.exited]);}signal?.throwIfAborted();throw error;}
  finally{clearTimeout(deadline);if(inactivity)clearTimeout(inactivity);this.progress=undefined;signal?.removeEventListener('abort',abort);done();this.busy=null;}
 }
 async command(action:string,value:Record<string,unknown>={},signal?:AbortSignal){signal?.throwIfAborted();if(this.completed){if(action==='checkpoint'||action==='release')return;throw new Error('Original SMB operation was already released.');}const iterator=this.rpc(action,value,undefined,signal);for(;;){const next=await iterator.next();if(next.done)return next.value;if(next.value.length)throw failure();}}
 json(request:SmbRequest,signal?:AbortSignal){return this.command(request.action,request as unknown as Record<string,unknown>,signal);}
 async *stream(request:SmbRequest,max:number,signal?:AbortSignal){let received=0;for await(const data of this.rpc('read',{path:request.path,maxBytes:max},undefined,signal)){received+=data.length;if(received>max){this.dead=true;this.abort();throw failure();}yield data;}}
 async read(request:SmbRequest,max:number,signal?:AbortSignal){const parts=[];for await(const chunk of this.stream(request,max,signal))parts.push(chunk);return Buffer.concat(parts);}
 async write(request:SmbRequest,source:AsyncIterable<Uint8Array>,signal?:AbortSignal){for await(const chunk of this.rpc('write',{path:request.path,bytes:request.bytes,sha256:request.sha256},source,signal)){if(chunk.length)throw failure();}}
 private finishing?:Promise<void>;
 private finish(){return this.finishing??=this.finishOnce();}
 private async finishOnce(){this.dead=true;if(this.openingAbort)clearTimeout(this.openingAbort);this.abort();try{(this.child.stdin as Bun.FileSink).end();}catch{}await gracefulStop(this.child,1500);this.cleanup();if(this.signalAbort)this.signal?.removeEventListener('abort',this.signalAbort);try{this.reader.releaseLock();}catch{}}
 close(){return this.closing??=this.closeOnce();}
 private async closeOnce(){if(this.closed)return;this.closed=true;if(this.busy){await this.finish();return;}if(this.checkpointed&&!this.dead){this.closed=false;const deadline=setTimeout(()=>void this.finish(),1500);try{await this.command('release');}finally{clearTimeout(deadline);this.closed=true;await this.finish();}}else await this.finish();}
}
function smbNativeMessage(code:unknown){if(code==='unsupported-filesystem')return SMB_UNSUPPORTED_FILESYSTEM_NOTICE;if(code==='canonical-admission-collision'||code==='canonical-collision-noeffect')return 'SMB canonical revision already exists. Create a fresh revision; existing admission cannot be reused safely.';if(code==='v2-coordination-permission-required')return 'SMB v2 requires writable coordination access. A read-only v2 destination cannot be opened.';if(code==='destination-busy'||code==='recovery-required'||code==='transaction-unavailable')return 'SMB transaction is busy or requires original-owner recovery. Preserve configuration and pending copies.';return 'SMB transaction unavailable. Preserve the exact job and verify destination integrity.';}

/** Scoped child process: requests carry paths and opaque identities, never credentials. */
export class MacSmbNative implements SmbNative {
 private helper=fileURLToPath(new URL('../native/smb-filesystem.py',import.meta.url));
 private async spawn(request:SmbRequest,signal?:AbortSignal){
  signal?.throwIfAborted();
  const process=track(Bun.spawn(['/usr/bin/python3',this.helper],{stdin:'pipe',stdout:'pipe',stderr:'ignore'}));
  let killTimeout:ReturnType<typeof setTimeout>|undefined;const abort=()=>{try{process.kill('SIGTERM');}catch{}killTimeout??=setTimeout(()=>{try{process.kill('SIGKILL');}catch{}},1500);};signal?.addEventListener('abort',abort,{once:true});
  const timeout=request.action==='transaction'?undefined:setTimeout(abort,120_000);
  const clean=()=>{clearTimeout(timeout);if(killTimeout)clearTimeout(killTimeout);signal?.removeEventListener('abort',abort);};
  try{process.stdin.write(encode(request));process.stdin.write('\n');}catch(error){abort();await process.exited;clean();throw error;}
  return {process,clean,abort};
 }
 async transaction(request:SmbTransactionRequest,signal?:AbortSignal){
  signal?.throwIfAborted();const {process,clean,abort}=await this.spawn(request);const session=new SmbRpcSession(process,clean,abort,signal);try{await session.ready();return session;}catch(error){await session.close().catch(()=>{});throw error;}
 }
 async *stream(request:SmbRequest,max:number,signal?:AbortSignal){
  const {process,clean,abort}=await this.spawn(request,signal);let received=0;
  try{process.stdin.end();for await(const chunk of process.stdout){signal?.throwIfAborted();received+=chunk.length;if(received>max)throw failure();yield chunk;}if(await process.exited!==0)throw failure();signal?.throwIfAborted();}
  finally{abort();await process.exited;clean();}
 }
 async read(request:SmbRequest,max:number,signal?:AbortSignal){const chunks:Uint8Array[]=[];for await(const chunk of this.stream(request,max,signal))chunks.push(chunk);return Buffer.concat(chunks);}
 async json(request:SmbRequest,signal?:AbortSignal){try{const value=JSON.parse(Buffer.from(await this.read(request,1_048_576,signal)).toString('utf8'));if(value?.error==='unsupported-filesystem')throw unsupportedSmbFilesystem();return value;}catch(error){signal?.throwIfAborted();if((error as Error&{code?:string}).code==='unsupported-filesystem')throw error;throw failure();}}
 async write(request:SmbRequest,source:AsyncIterable<Uint8Array>,signal?:AbortSignal){
  const {process,clean,abort}=await this.spawn(request,signal);let written=0;const output=new Response(process.stdout).arrayBuffer();
  try{for await(const chunk of source){signal?.throwIfAborted();written+=chunk.length;if(written>(request.bytes??0))throw failure();await process.stdin.write(chunk);await process.stdin.flush();}if(written!==request.bytes)throw failure();process.stdin.end();if(await process.exited!==0)throw failure();if((await output).byteLength>4096)throw failure();signal?.throwIfAborted();}
  finally{try{process.stdin.end();}finally{abort();await process.exited;await output.catch(()=>{});clean();}}
 }
}

/** Immutable SMB publications acknowledge verified share read-back, not server power-loss durability. */
export class SmbProvider implements LibraryProvider {
 readonly transport='authenticated-network' as const;
 readonly id:string;readonly name:string;readonly readOnly:boolean;
 readonly deletionCapabilities:DeletionCapabilities;
 readonly withTransaction?:<T>(context:TransactionContext,run:(transaction:RemoteTransaction)=>Promise<T>,signal?:AbortSignal)=>Promise<T>;
 private context=new AsyncLocalStorage<{session:SmbTransactionNative;transaction:RemoteTransaction;closed:boolean}>();
 private transactionRunning=false;
 readonly capabilities:{read:boolean;write:boolean;transportSecurity:'signed'|'encrypted'|'unknown';remoteDeletion:boolean;durability:'share-readback'};
 constructor(private binding:SmbBinding,private native:SmbNative=new MacSmbNative(),private guard?:()=>void,private privateRoot=process.env.HEED_APP_DIR||join(homedir(),'.heed-app'),private quota?:QuotaBudget & {allocation?:(id:string)=>{bytes:number;paths:string[]}|null}){
  this.id=binding.id;this.name=binding.name;this.readOnly=binding.readOnly;
  const version=binding.destinationVersion??1;
  this.deletionCapabilities={revisionMetadata:version===2&&!binding.readOnly&&binding.security!=='unknown',sharedAudioGC:false,exclusion:version===2?'exclusive-create':'none',confirmation:version===2?'pending-verification':'disabled',destinationVersion:version,destinationId:binding.destinationId,connectionGeneration:sha(encode({generation:binding.connectionGeneration??null,id:binding.id,root:binding.root,identity:binding.identity,destinationId:binding.destinationId,destinationVersion:version,readOnly:binding.readOnly,security:binding.security})),blockedReason:version===1?'Create a new empty v2 destination for physical metadata deletion.':binding.readOnly?'SMB v2 requires writable coordination access.':'Shared audio reclamation awaits real cross-host namespace and contention verification.'};
  if(version===2)this.withTransaction=(context,run,signal)=>this.transact(context,run,signal);
  this.capabilities={read:binding.security!=='unknown'&&!(version===2&&binding.readOnly),write:!binding.readOnly&&binding.security!=='unknown',transportSecurity:binding.security,remoteDeletion:this.deletionCapabilities.revisionMetadata,durability:'share-readback'};
 }
 private transactionDirectory(){if(!isAbsolute(this.privateRoot))throw new Error('Invalid SMB private root.');return join(this.privateRoot,'library','catalog','transactions');}
 private transactionFiles(){
  const directory=this.transactionDirectory();const inspect=(path:string)=>{try{return lstatSync(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw new Error('Invalid SMB transaction state; preserve pending copies.');}};
  for(let parent=directory;;parent=dirname(parent)){const info=inspect(parent);if(info&&(info.isSymbolicLink()||!info.isDirectory()))throw new Error('Invalid SMB transaction state; preserve pending copies.');if(parent===dirname(parent))break;}
  if(!inspect(directory))return [];const names=readdirSync(directory);if(names.length>256)throw new Error('SMB transaction journal limit reached.');return names.map(name=>{if(!/^(?:[a-f0-9-]{36}\.(?:json|guard)|\.[a-f0-9-]{36}\.json\.[a-f0-9-]{36})$/i.test(name))throw new Error('Unknown SMB transaction state; preserve it for recovery.');const file=join(directory,name),info=lstatSync(file);if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.size>4_000_000)throw new Error('Invalid SMB transaction state; preserve it for recovery.');return file;});
 }

 pendingTransactions():PendingRemoteTransaction[]{
  this.guard?.();const result:PendingRemoteTransaction[]=[];
  for(const file of this.transactionFiles().filter(path=>path.endsWith('.json'))){
   const job=readPrivateJson<any>(file,4_000_000);if(!job||job.version!==1||!job.scope||!UUID.test(job.scope.operationId)||!UUID.test(job.scope.deviceId)||!['read','publish','delete'].includes(job.scope.kind)||!['prepared','claimed','checkpointed','releasing'].includes(job.phase)||!job.admissions||typeof job.admissions!=='object'||Array.isArray(job.admissions)||Object.keys(job.admissions).length>10000)throw new Error('Invalid SMB transaction journal; preserve it for recovery.');
   let pinned=true;const admissions=Object.entries(job.admissions).map(([path,raw])=>{const receipt=raw as any,parts=path.split('/');if(parts.length!==5||parts[0]!=='meetings'||!UUID.test(parts[1]!)||parts[2]!=='revisions'||!UUID.test(parts[3]!)||parts[4]!=='manifest.json'||!receipt||!HASH.test(receipt.sha256)||!Number.isSafeInteger(receipt.bytes)||receipt.bytes<=0||receipt.bytes>65536||receipt.inode!==null&&(!Array.isArray(receipt.inode)||receipt.inode.length!==2||!receipt.inode.every((n:any)=>typeof n==='string'&&/^(?:0|[1-9][0-9]{0,19})$/.test(n))))throw new Error('Invalid SMB admission receipt; preserve the original job.');if(receipt.inode===null)pinned=false;return {meetingId:parts[1]!,revisionId:parts[3]!,manifestHash:receipt.sha256};});
   if(job.scope.destinationId!==this.binding.destinationId)continue;
   const bindingMatches=job.scope.root===this.binding.root&&job.scope.connectionGeneration===this.deletionCapabilities.connectionGeneration&&['type','fsid','sourceHash','mountPath','readOnly'].every(key=>job.scope.identity?.[key]===this.binding.identity[key as keyof SmbIdentity]);
   const releaseOnly=job.phase==='releasing'||job.phase==='checkpointed'||admissions.length===0&&job.effects===0;
   const preparedProof=job.phase==='prepared'&&job.receipt&&['root','lease'].every(key=>Array.isArray(job.receipt[key])&&job.receipt[key].length===2&&job.receipt[key].every((n:unknown)=>typeof n==='string'&&/^(?:0|[1-9][0-9]{0,19})$/.test(n)));
   const recoverable=bindingMatches&&pinned&&(preparedProof&&releaseOnly||['claimed','checkpointed'].includes(job.phase)&&(releaseOnly||job.scope.kind==='read'&&admissions.length===0||job.scope.kind==='publish'&&admissions.length>0)||job.phase==='releasing');
   result.push({operationId:job.scope.operationId,deviceId:job.scope.deviceId,kind:job.scope.kind,recoverable,admissions,...(releaseOnly?{releaseOnly:true}:{}),...(!bindingMatches?{blockedReason:'Original SMB connection generation and destination binding are required; no rebind or takeover is permitted.'}:!pinned?{blockedReason:'Canonical staging allocation is ambiguous; preserve the original journal and destination.'}:{})});
  }
  return result;
 }

 private active(){this.guard?.();const context=this.context.getStore();if(!context||context.closed)throw new Error('SMB v2 requires an active whole-operation transaction.');return context;}
 private io():SmbNative{return (this.binding.destinationVersion??1)===2?this.active().session:this.native;}
 private async transact<T>(context:TransactionContext,run:(transaction:RemoteTransaction)=>Promise<T>,signal?:AbortSignal):Promise<T>{
  this.guard?.();signal?.throwIfAborted();const borrowed=this.context.getStore();if(borrowed){if(borrowed.closed)throw new Error('SMB transaction is closed.');return run(borrowed.transaction);}
  if(this.transactionRunning)throw new Error('SMB transaction is busy.');if(this.readOnly)throw new Error('SMB v2 requires writable coordination access. A read-only v2 destination cannot be opened.');
  if(!UUID.test(context.operationId)||!UUID.test(context.deviceId)||!['read','publish','delete'].includes(context.kind)||!this.native.transaction)throw new Error('SMB native transaction capability is unavailable.');
  this.transactionRunning=true;const quotaId='smb-transaction-'+context.operationId;let reserved=false;let session:SmbTransactionNative|undefined;let box:ReturnType<typeof this.context.getStore>;
  try{
   if(this.quota){const directory=this.transactionDirectory(),bytes=this.transactionFiles().reduce((sum,file)=>sum+lstatSync(file).size,0);const old=this.quota.allocation?.(quotaId);if(old){if(old.paths.length!==1||old.paths[0]!==directory||old.bytes<bytes+4_000_000)throw new Error('SMB transaction quota recovery is required.');}else this.quota.reserve(quotaId,bytes+8_000_000,[directory]);reserved=true;}
   session=await this.native.transaction({...this.request('transaction'),appDir:this.privateRoot,...context,readOnly:this.readOnly,security:this.binding.security,connectionGeneration:this.deletionCapabilities.connectionGeneration},signal);
   const command=(action:string,value?:Record<string,unknown>,signal?:AbortSignal)=>{this.active();return session!.command(action,value,signal);};
   const transaction:RemoteTransaction={checkpoint:async()=>{await command('checkpoint');},inventory:async signal=>{const raw=await command('inventory',undefined,signal) as RemoteInventory;if(!raw||raw.complete!==true||!Array.isArray(raw.commits)||!Array.isArray(raw.deletions)||!Array.isArray(raw.pending)||[raw.commits,raw.deletions,raw.pending].some(items=>items.length>10000))throw failure();raw.commits.forEach(validateCommit);raw.deletions.forEach(validateDeletionRecord);raw.pending.forEach(validatePublicationIntent);if(raw.deletions.some(record=>record.destinationId!==this.binding.destinationId))throw failure();return raw;},writeDeletion:async(record,signal)=>{validateDeletionRecord(record);await command('write-deletion',{value:record},signal);},writeFence:async(fence,signal)=>{validateRevisionFence(fence);await command('write-fence',{value:fence},signal);},writePending:async(intent,signal)=>{validatePublicationIntent(intent);await command('write-pending',{value:intent},signal);},retirePending:async(intent,signal)=>{validatePublicationIntent(intent);await command('retire-pending',{value:intent},signal);},removeExact:async(jobId,artifact,signal)=>{validateArtifactIdentity(artifact);const result=await command('remove-exact',{jobId,artifact},signal);if(result!=='removed'&&result!=='already-removed')throw failure();return result;}};
   box={session,transaction,closed:false};return await this.context.run(box,()=>run(transaction));
  }finally{if(box)box.closed=true;try{await session?.close();if(reserved)this.quota!.release(quotaId);}finally{this.transactionRunning=false;}}
 }
 private request(action:SmbRequest['action'],extra:Partial<SmbRequest>={}):SmbRequest{return {action,root:this.binding.root,identity:this.binding.identity,destinationId:this.binding.destinationId,stagingId:this.binding.id,...extra};}
 private async access(write:boolean,signal?:AbortSignal){
  this.guard?.();signal?.throwIfAborted();if((this.binding.destinationVersion??1)===2){this.active();if(write&&this.readOnly)throw new Error('SMB library is read-only.');return;}const probe=smbProbe(await this.io().json(this.request('probe'),signal));if(write&&probe.atomicOperations===false)throw unsupportedSmbFilesystem();
  if(probe.security==='unknown'||(this.binding.security==='encrypted'&&probe.security!=='encrypted')||['fsid','sourceHash','mountPath'].some(k=>probe.identity[k as keyof SmbIdentity]!==this.binding.identity[k as keyof SmbIdentity]))throw failure();
  const header=destinationHeader(await this.io().json(this.request('header'),signal));if(header?.destinationId!==this.binding.destinationId||header.schemaVersion!==1)throw new Error('SMB destination identity changed. Test and confirm the connection again.');
  if(write&&(this.readOnly||probe.identity.readOnly))throw new Error('SMB library is read-only. Import remains available.');
 }
 async list(cursor:string|null,limit:number,signal?:AbortSignal){
  if(!Number.isInteger(limit)||limit<1||limit>100)throw new Error('Invalid SMB discovery limit.');await this.access(false,signal);
  const result=await this.io().json(this.request('list'),signal);if(!Array.isArray(result)||result.length>10000||result.some(p=>typeof p!=='string'||!/^commits\/[a-f0-9-]{36}\/[a-f0-9-]{36}\.json$/.test(p)))throw failure();
  const paths=(result as string[]).sort();const identity=sha(encode(paths));let offset=0;
  if(cursor){const pieces=cursor.split(':');if(pieces.length!==2||pieces[0]!==identity||!/^\d+$/.test(pieces[1]!))throw new Error('SMB listing changed. Refresh the library to retry.');offset=Number(pieces[1]);if(offset<0||offset>=paths.length)throw failure();}
  const commits:PortableCommit[]=[];
  for(const file of paths.slice(offset,offset+limit)){signal?.throwIfAborted();const marker=JSON.parse(Buffer.from(await this.io().read(this.request('read',{path:file,maxBytes:16384}),16384,signal)).toString('utf8')) as PortableCommit;
   if(!marker||marker.schemaVersion!==1||![marker.libraryId,marker.meetingId,marker.revisionId,marker.deviceId].every(id=>typeof id==='string'&&UUID.test(id))||!HASH.test(marker.manifestHash)||file!==`commits/${marker.deviceId}/${marker.revisionId}.json`||marker.manifestPath!==`meetings/${marker.meetingId}/revisions/${marker.revisionId}/manifest.json`)throw new Error('Unsupported or corrupt SMB commit.');commits.push(marker);}
  return {commits,next:offset+limit<paths.length?`${identity}:${offset+limit}`:null,complete:true};
 }
 async read(file:string,max:number,signal?:AbortSignal){if(!count(max))throw failure();path(file);await this.access(false,signal);const value=await this.io().read(this.request('read',{path:file,maxBytes:max}),max,signal);if(value.length>max)throw failure();return value;}
 async *stream(file:string,max:number,signal?:AbortSignal){if(!count(max))throw failure();path(file);await this.access(false,signal);let received=0;for await(const chunk of this.io().stream(this.request('read',{path:file,maxBytes:max}),max,signal)){signal?.throwIfAborted();received+=chunk.length;if(received>max)throw failure();yield chunk;}}
 async writeImmutable(file:string,value:Uint8Array,signal?:AbortSignal){path(file);await this.access(true,signal);await this.io().write(this.request('write',{path:file,bytes:value.length,sha256:sha(value)}),(async function*(){yield value;})(),signal);}
 async writeObjectImmutable(file:string,size:number,digest:string,source:AsyncIterable<Uint8Array>,signal?:AbortSignal){if(!count(size)||!HASH.test(digest)||file!==`objects/${digest}`)throw failure();path(file);await this.access(true,signal);const hash=createHash('sha256');let received=0;
  const verified=(async function*(){for await(const chunk of source){signal?.throwIfAborted();received+=chunk.length;if(received>size)throw failure();hash.update(chunk);yield chunk;}if(received!==size||hash.digest('hex')!==digest)throw failure();})();await this.io().write(this.request('write',{path:file,bytes:size,sha256:digest}),verified,signal);
 }
 async confirm(marker:PortableCommit,signal?:AbortSignal):Promise<'remote-confirmed'>{
  await this.access(true,signal);const prefix=`meetings/${marker.meetingId}/revisions/${marker.revisionId}`;
  if(marker.manifestPath!==`${prefix}/manifest.json`||![marker.meetingId,marker.revisionId,marker.deviceId].every(id=>UUID.test(id))||!HASH.test(marker.manifestHash))throw failure();
  const stored=await this.read(`commits/${marker.deviceId}/${marker.revisionId}.json`,16384,signal);if(sha(stored)!==sha(encode(marker)))throw failure();
  const manifestBytes=await this.read(marker.manifestPath,65536,signal);if(sha(manifestBytes)!==marker.manifestHash)throw failure();
  const manifest=JSON.parse(Buffer.from(manifestBytes).toString('utf8'));
  if(manifest.libraryId!==marker.libraryId||manifest.meetingId!==marker.meetingId||manifest.revisionId!==marker.revisionId||!Array.isArray(manifest.artifacts)||manifest.artifacts.length!==1)throw failure();
  const artifact=manifest.artifacts[0];if(artifact.path!=='meeting.json'||!count(artifact.bytes)||artifact.bytes>16*1024*1024||!HASH.test(artifact.sha256))throw failure();
  const meetingBytes=await this.read(`${prefix}/meeting.json`,artifact.bytes,signal);if(meetingBytes.length!==artifact.bytes||sha(meetingBytes)!==artifact.sha256)throw failure();
  const meeting=JSON.parse(Buffer.from(meetingBytes).toString('utf8'));if(meeting.audio){const audio=meeting.audio;if(!count(audio.bytes)||!HASH.test(audio.sha256)||audio.objectPath!==`objects/${audio.sha256}`)throw failure();let received=0;const hash=createHash('sha256');for await(const chunk of this.stream(audio.objectPath,audio.bytes,signal)){received+=chunk.length;hash.update(chunk);}if(received!==audio.bytes||hash.digest('hex')!==audio.sha256)throw failure();}
  return 'remote-confirmed';
 }
}
