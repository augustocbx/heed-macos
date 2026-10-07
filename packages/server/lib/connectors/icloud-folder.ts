import {openNativeAuthoritySession,type NativeOwnedAuthorityRequest} from '../qa/synchronization-device-authority';
import {AsyncLocalStorage} from 'node:async_hooks';
import {encode,validateCommit} from '../portable-schema';
import {equivalentRevisionFence,canonicalControl,validateDeletionRecord,validatePublicationIntent,validateRevisionFence} from '../portable-deletion-schema';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {lstatSync,readdirSync} from 'node:fs';
import type {QuotaBudget} from '../portable-provider';
import {fileURLToPath} from 'node:url';import {track} from '../process';
import type {LibraryProvider,RemoteTransaction,TransactionContext} from '../portable-provider';
import type {PortableCommit,DeletionCapabilities,RemoteInventory,DeletionRecord,PublicationIntent,RevisionDeletionFence,ArtifactIdentity} from '@heed/shared';
export interface CloudBinding {bookmark:string;account:string;identity:string}
export interface CloudObservation {ubiquitous:boolean;uploaded?:boolean;uploading?:boolean;downloaded?:string;errorCode?:number;state:string;remoteChecksumVerified:false}
export interface CloudRequest {privateRoot?:string;connectionGeneration?:string;action:'pick'|'probe'|'create'|'list'|'read'|'write'|'status'|'hydrate'|'watch'|'inventory'|'remove-exact'|'retire-pending';destinationVersion?:1|2;jobId?:string;binding?:CloudBinding;destinationId?:string;stagingId?:string;path?:string;bytes?:number;sha256?:string;maxBytes?:number}
export interface CloudAcceptanceRequest extends Omit<CloudRequest,'action'> {action:'qa-observe-parent'|'qa-create-child'|'qa-join-child';spec?:unknown;workspace?:unknown;selectedScope?:'parent'|'child';evidence?:unknown}
export interface CloudAcceptanceNative {acceptance(request:CloudAcceptanceRequest,signal?:AbortSignal):Promise<unknown>}
export interface CloudNative {
 json(request:CloudRequest,signal?:AbortSignal):Promise<unknown>;
 stream(request:CloudRequest,max:number,signal?:AbortSignal):AsyncIterable<Uint8Array>;
 write(request:CloudRequest,source:AsyncIterable<Uint8Array>,signal?:AbortSignal):Promise<void>;
}
export const CLOUD_ISSUES=['unavailable','account-unavailable','account-changed','bookmark-stale','folder-unavailable','permission-denied','hydration-pending'] as const;
export type CloudIssue=typeof CLOUD_ISSUES[number];
export class CloudFolderError extends Error {constructor(readonly code:CloudIssue='unavailable'){super('iCloud folder unavailable. Check sign-in, folder access, download status and library integrity.');}}
export const cloudUnavailable=(code:CloudIssue='unavailable')=>new CloudFolderError(code);
export function cloudIssue(error:unknown):CloudIssue {return error instanceof CloudFolderError&&CLOUD_ISSUES.includes(error.code)?error.code:'unavailable';}
/** Drain the whole pipe to avoid deadlock; retain only a bounded protocol response. */
async function boundedOutput(stream:AsyncIterable<Uint8Array>,max:number){const chunks:Uint8Array[]=[];let size=0;for await(const chunk of stream){size+=chunk.length;if(size<=max)chunks.push(chunk);}return size>max?null:Buffer.concat(chunks);}
function nativeFailure(data:Buffer|null){try{const value=JSON.parse(data?.toString('utf8')??'');if(value&&Object.keys(value).sort().join(',')==='code,protocol,version'&&value.protocol==='heed-icloud-failure'&&value.version===1&&CLOUD_ISSUES.includes(value.code))return cloudUnavailable(value.code);}catch{}return cloudUnavailable();}
const hash=(value:Uint8Array)=>createHash('sha256').update(value).digest('hex');
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
function path(value:string){if(value.length>512||! /^(meetings|objects|commits)\/[A-Za-z0-9_./-]+$/.test(value)||value.split('/').some(p=>!p||p==='.'||p==='..'))throw cloudUnavailable();return value;}
function bound(value:number){if(!Number.isSafeInteger(value)||value<0||value>8_000_000_000_000)throw cloudUnavailable();return value;}
export function cloudHeader(value:unknown):{format:'heed-portable-library';schemaVersion:1|2;destinationId:string}|null {
 if(value===null)return null;const item=value as any;
 if(!item||Object.keys(item).sort().join(',')!=='destinationId,format,schemaVersion'||item.format!=='heed-portable-library'||![1,2].includes(item.schemaVersion)||!UUID.test(item.destinationId))throw cloudUnavailable();return item;
}
export function cloudBinding(value:unknown):CloudBinding {const b=value as CloudBinding;if(!b||Object.keys(b).sort().join(',')!=='account,bookmark,identity'||![b.account,b.bookmark].every(v=>typeof v==='string'&&v.length>0&&v.length<=65536&&/^[A-Za-z0-9+/]+=*$/.test(v))||typeof b.identity!=='string'||!/^\d+:\d+$/.test(b.identity))throw cloudUnavailable();return b;}
export class MacCloudNative implements CloudNative {
 constructor(private helper=fileURLToPath(new URL('../../../desktop/icloud-folder/.build/heed-icloud',import.meta.url))){}
 private async spawn(request:CloudRequest|CloudAcceptanceRequest,signal?:AbortSignal){
  signal?.throwIfAborted();const process=track(Bun.spawn([this.helper],{stdin:'pipe',stdout:'pipe',stderr:'pipe'}));
  const diagnostic=boundedOutput(process.stderr,4096).catch(()=>null);let termination:ReturnType<typeof setTimeout>|undefined;
  const abort=()=>{try{process.kill('SIGTERM');}catch{}termination??=setTimeout(()=>{try{process.kill('SIGKILL');}catch{}},1000);};
  const timer=setTimeout(abort,request.action==='pick'||request.action==='qa-create-child'||request.action==='qa-join-child'?120000:Math.min(3600000,30000+Math.ceil((request.bytes??request.maxBytes??0)/1_000_000)*1000));signal?.addEventListener('abort',abort,{once:true});
  const clean=()=>{clearTimeout(timer);if(termination)clearTimeout(termination);signal?.removeEventListener('abort',abort);};
  try{process.stdin.write(JSON.stringify(request)+'\n');}catch{abort();await process.exited;await diagnostic;clean();throw cloudUnavailable();}
  return {process,diagnostic,abort,clean};
 }
 private async *read(request:CloudRequest|CloudAcceptanceRequest,max:number,signal?:AbortSignal,typed=false){
  const {process,diagnostic,abort,clean}=await this.spawn(request,signal);let size=0;let failure:unknown;
  try{process.stdin.end();for await(const chunk of process.stdout){signal?.throwIfAborted();size+=chunk.length;if(size>max)throw cloudUnavailable();yield chunk;}
   const exit=await process.exited;signal?.throwIfAborted();if(exit!==0)throw typed?nativeFailure(await diagnostic):cloudUnavailable();
  }catch(error){failure=error;throw error;}finally{abort();await process.exited;await diagnostic;clean();if(request.action.startsWith('qa-')&&failure instanceof Error)Object.defineProperty(failure,'guardianStopped',{value:true,enumerable:false});}
 }
 stream(request:CloudRequest,max:number,signal?:AbortSignal){return this.read(request,max,signal);}
 async json(request:CloudRequest,signal?:AbortSignal){const chunks:Uint8Array[]=[];for await(const chunk of this.read(request,['list','inventory'].includes(request.action)?2_000_000:150000,signal,true))chunks.push(chunk);try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw cloudUnavailable();}}
 async openAcceptanceAuthority(request:NativeOwnedAuthorityRequest,signal?:AbortSignal){
  const keys=['action','binding','spec','workspace','selectedScope','role','connectionGeneration'];
  if(request.action!=='qa-open-owned-authority'||Object.keys(request).sort().join(',')!==keys.sort().join(',')||!['creator','participant'].includes(request.role)||request.selectedScope!==(request.role==='creator'?'parent':'child')||Buffer.byteLength(JSON.stringify(request))>150000)throw cloudUnavailable();
  cloudBinding(request.binding);
  return openNativeAuthoritySession(async()=>Bun.spawn([this.helper],{stdin:'pipe',stdout:'pipe',stderr:'pipe'}),request as unknown as Record<string,unknown>,signal);
 }
 async acceptance(request:CloudAcceptanceRequest,signal?:AbortSignal):Promise<unknown>{
  const keys=request.action==='qa-observe-parent'?['action','binding']:request.action==='qa-create-child'?['action','binding','connectionGeneration','spec','workspace','selectedScope']:request.action==='qa-join-child'?['action','binding','connectionGeneration','spec','workspace','selectedScope','evidence']:[];
  if(!keys.length||Object.keys(request).sort().join(',')!==keys.sort().join(',')||Buffer.byteLength(JSON.stringify(request))>150000)throw cloudUnavailable();cloudBinding(request.binding);
  const chunks:Uint8Array[]=[];for await(const chunk of this.read(request,150000,signal,true))chunks.push(chunk);
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw cloudUnavailable();}
 }
 async write(request:CloudRequest,source:AsyncIterable<Uint8Array>,signal?:AbortSignal){
  const {process,diagnostic,abort,clean}=await this.spawn(request,signal);const response=boundedOutput(process.stdout,4096).catch(()=>null);let size=0;
  try{for await(const chunk of source){signal?.throwIfAborted();size+=chunk.length;if(size>(request.bytes??0))throw cloudUnavailable();
    // Only transport failures may use the helper diagnostic; source errors retain their identity.
    try{await process.stdin.write(chunk);await process.stdin.flush();}catch(error){
     if((error as NodeJS.ErrnoException)?.code!=='EPIPE')throw error;
     try{process.stdin.end();}catch{}const grace=setTimeout(abort,1000);
     try{const exit=await process.exited,data=await diagnostic;signal?.throwIfAborted();throw exit!==0?nativeFailure(data):cloudUnavailable();}finally{clearTimeout(grace);}
    }
   }
   if(size!==request.bytes)throw cloudUnavailable();process.stdin.end();const exit=await process.exited;signal?.throwIfAborted();if(exit!==0)throw nativeFailure(await diagnostic);if(await response===null)throw cloudUnavailable();
  }finally{try{process.stdin.end();}catch{}abort();await process.exited;await Promise.all([response,diagnostic]);clean();}
 }
}
/** macOS upload observations never release the sole private pending copy. */
export class ICloudFolderProvider implements LibraryProvider {
 readonly transport='os-managed-folder' as const;
 readonly deletionCapabilities:DeletionCapabilities;
 private transaction=new AsyncLocalStorage<{active:boolean}>();private active=false;
 private observations=new Map<string,CloudObservation>();
 failureIssue?:CloudIssue;
 statusFor(revisionId:string){return this.observations.get(revisionId);}
 readonly capabilities:{read:true;write:true;remoteDeletion:boolean;durability:'local-only'};
 constructor(readonly id:string,readonly name:string,private binding:CloudBinding,private destinationId:string,private native:CloudNative=new MacCloudNative(),private guard?:()=>void,private destinationVersion:1|2=1,connectionGeneration:string=id,private privateRoot?:string,private quota?:QuotaBudget){const owner=this,delegate=this.native;this.native={json:async(request,signal)=>{try{return await delegate.json(request,signal);}catch(error){owner.failureIssue=cloudIssue(error);throw error;}},stream:async function*(request,max,signal){try{yield* delegate.stream(request,max,signal);}catch(error){owner.failureIssue=cloudIssue(error);throw error;}},write:async(request,source,signal)=>{try{await delegate.write(request,source,signal);}catch(error){owner.failureIssue=cloudIssue(error);throw error;}}};this.capabilities={read:true,write:true,remoteDeletion:destinationVersion===2,durability:'local-only'};this.deletionCapabilities={connectionGeneration,destinationVersion,destinationId,revisionMetadata:destinationVersion===2,sharedAudioGC:false,exclusion:destinationVersion===2?'local-coordination':'none',confirmation:destinationVersion===2?'pending-propagation':'disabled',...(destinationVersion===1?{blockedReason:'Physical deletion requires a new v2 library'}:{})};}
 private request(action:CloudRequest['action'],extra:Partial<CloudRequest>={}):CloudRequest{return {action,binding:this.binding,destinationId:this.destinationId,stagingId:this.id,destinationVersion:this.destinationVersion,...(this.privateRoot?{privateRoot:this.privateRoot,connectionGeneration:this.deletionCapabilities.connectionGeneration}:{}),...extra};}
 private async access(signal?:AbortSignal){this.guard?.();if(this.destinationVersion===2&&!this.transaction.getStore()?.active)throw new Error('A whole iCloud transaction is required');const probe=await this.native.json(this.request('probe'),signal) as any;const header=cloudHeader(probe?.header);if(header?.destinationId!==this.destinationId||header.schemaVersion!==this.destinationVersion||probe.remoteChecksumVerified!==false)throw cloudUnavailable();}
 async withTransaction<T>(_context:TransactionContext,run:(tx:RemoteTransaction)=>Promise<T>,signal?:AbortSignal):Promise<T>{
  const borrowed=this.transaction.getStore();if(borrowed){if(!borrowed.active)throw cloudUnavailable();return run(this.controls(borrowed));}
  if(this.active)throw new Error('An iCloud transaction is already running');this.guard?.();signal?.throwIfAborted();const session={active:true};this.active=true;
  try{return await this.transaction.run(session,()=>run(this.controls(session)));}finally{session.active=false;this.active=false;}
 }
 private controls(session:{active:boolean}):RemoteTransaction {
  const valid=()=>{if(!session.active||this.transaction.getStore()!==session)throw cloudUnavailable();this.guard?.();};
  const read=async(file:string,max:number,signal?:AbortSignal)=>{valid();await this.access(signal);await this.native.json(this.request('hydrate',{path:file,maxBytes:max}),signal);const chunks:Uint8Array[]=[];let size=0;for await(const chunk of this.native.stream(this.request('read',{path:file,maxBytes:max}),max,signal)){size+=chunk.length;if(size>max)throw cloudUnavailable();chunks.push(chunk);}return JSON.parse(Buffer.concat(chunks).toString());};
  const write=async(file:string,value:unknown,signal?:AbortSignal,action:CloudRequest['action']='write')=>{valid();await this.access(signal);const data=encode(value);await this.native.write(this.request(action,{path:file,bytes:data.length,sha256:hash(data)}),(async function*(){yield data;})(),signal);};
  return {
   checkpoint:async()=>{valid();},
   inventory:async(signal)=>{valid();await this.access(signal);const paths=await this.native.json(this.request('inventory'),signal) as any;if(!paths||Object.keys(paths).sort().join(',')!=='commits,deletions,pending'||!['commits','deletions','pending'].every(key=>Array.isArray(paths[key])&&paths[key].length<=10000))throw cloudUnavailable();const result:RemoteInventory={commits:[],deletions:[],pending:[],complete:true};let size=0;for(const category of ['commits','deletions','pending'] as const){for(const file of paths[category]){const pattern=category==='commits'?/^commits\/[a-f0-9-]{36}\/[a-f0-9-]{36}\.json$/i:new RegExp(`^control/${category}/[a-f0-9-]{36}\\.json$`,'i');if(typeof file!=='string'||!pattern.test(file))throw cloudUnavailable();const value=await read(file,category==='deletions'?2_000_000:65536,signal);size+=encode(value).length;if(size>64_000_000)throw cloudUnavailable();if(category==='commits'){const marker=validateCommit(value);if(file!==`commits/${marker.deviceId}/${marker.revisionId}.json`)throw cloudUnavailable();result.commits.push(marker);}else if(category==='deletions'){const record=validateDeletionRecord(value);if(record.destinationId!==this.destinationId||file!==`control/deletions/${record.jobId}.json`)throw cloudUnavailable();result.deletions.push(record);}else{const intent=validatePublicationIntent(value);if(file!==`control/pending/${intent.id}.json`)throw cloudUnavailable();result.pending.push(intent);}}}return result;},
   writeDeletion:async(record:DeletionRecord,signal)=>{validateDeletionRecord(record);if(record.destinationId!==this.destinationId)throw cloudUnavailable();await write(`control/deletions/${record.jobId}.json`,record,signal);},
   writePending:async(intent:PublicationIntent,signal)=>{validatePublicationIntent(intent);await write(`control/pending/${intent.id}.json`,intent,signal);},
   retirePending:async(intent:PublicationIntent,signal)=>{valid();validatePublicationIntent(intent);await this.access(signal);const data=encode(intent);await this.native.json(this.request('retire-pending',{path:`control/pending/${intent.id}.json`,jobId:intent.id,bytes:data.length,sha256:hash(data)}),signal);},
   removeExact:async(jobId:string,artifact:ArtifactIdentity,signal)=>{valid();if(artifact.path.startsWith('objects/'))throw new Error('Shared audio garbage collection is unavailable');await this.access(signal);const result=await this.native.json(this.request('remove-exact',{jobId,path:artifact.path,bytes:artifact.bytes,sha256:artifact.sha256}),signal) as any;if(!['removed','already-removed'].includes(result?.result))throw cloudUnavailable();return result.result;},
   writeFence:async(fence:RevisionDeletionFence,signal)=>{valid();validateRevisionFence(fence);if(fence.destinationId!==this.destinationId)throw cloudUnavailable();const existing=validateRevisionFence(await read(fence.artifact.path,65536,signal));if(canonicalControl(existing)!==canonicalControl(fence)){if(!equivalentRevisionFence(existing,fence))throw cloudUnavailable();const intent=validateDeletionRecord(await read(`control/deletions/${existing.jobId}.json`,2_000_000,signal));if(intent.destinationId!==this.destinationId||!intent.revisions.some(item=>canonicalControl(item)===canonicalControl(fence.revision))||!intent.artifacts.some(item=>canonicalControl(item)===canonicalControl(fence.artifact)))throw cloudUnavailable();}},
  };
 }
 async list(cursor:string|null,limit:number,signal?:AbortSignal){if(!Number.isInteger(limit)||limit<1||limit>100)throw cloudUnavailable();await this.access(signal);const paths=await this.native.json(this.request('list'),signal);if(!Array.isArray(paths)||paths.length>10000||paths.some(p=>typeof p!=='string'||!/^commits\/[a-f0-9-]{36}\/[a-f0-9-]{36}\.json$/i.test(p)))throw cloudUnavailable();const sorted=[...paths].sort();const identity=hash(Buffer.from(JSON.stringify(sorted)));let offset=0;if(cursor){const parts=cursor.split(':');if(parts.length!==2||parts[0]!==identity||!/^\d+$/.test(parts[1]!))throw cloudUnavailable();offset=Number(parts[1]);if(!Number.isSafeInteger(offset)||offset<0||offset>=sorted.length)throw cloudUnavailable();}const commits:PortableCommit[]=[];for(const file of sorted.slice(offset,offset+limit)){const marker=JSON.parse(Buffer.from(await this.read(file,16384,signal)).toString('utf8'));if(!marker||Object.keys(marker).sort().join(',')!=='deviceId,libraryId,manifestHash,manifestPath,meetingId,revisionId,schemaVersion'||marker.schemaVersion!==1||![marker.deviceId,marker.libraryId,marker.meetingId,marker.revisionId].every(v=>typeof v==='string'&&UUID.test(v))||file!==`commits/${marker.deviceId}/${marker.revisionId}.json`||marker.manifestPath!==`meetings/${marker.meetingId}/revisions/${marker.revisionId}/manifest.json`||! /^[a-f0-9]{64}$/.test(marker.manifestHash))throw cloudUnavailable();commits.push(marker);}return {commits,next:offset+limit<sorted.length?`${identity}:${offset+limit}`:null,complete:true};}
 async *stream(file:string,max:number,signal?:AbortSignal){path(file);bound(max);await this.access(signal);await this.native.json(this.request('hydrate',{path:file,maxBytes:max}),signal);let size=0;for await(const chunk of this.native.stream(this.request('read',{path:file,maxBytes:max}),max,signal)){signal?.throwIfAborted();size+=chunk.length;if(size>max)throw cloudUnavailable();yield chunk;}}
 async read(file:string,max:number,signal?:AbortSignal){if(max>16_000_000)throw cloudUnavailable();const chunks:Uint8Array[]=[];for await(const chunk of this.stream(file,max,signal))chunks.push(chunk);return Buffer.concat(chunks);}
 async writeImmutable(file:string,bytes:Uint8Array,signal?:AbortSignal){path(file);await this.access(signal);const claim=this.destinationVersion===2&&file.endsWith('/manifest.json')&&this.privateRoot&&this.quota?`icloud-admission-${hash(Buffer.from(this.deletionCapabilities.connectionGeneration+'/'+file))}`:undefined;const directory=this.privateRoot&&join(this.privateRoot,'library','catalog','icloud-admissions');if(claim){let existing=0;try{const info=lstatSync(directory!);if(!info.isDirectory()||info.isSymbolicLink())throw cloudUnavailable();const names=readdirSync(directory!);if(names.length>20000)throw cloudUnavailable();for(const name of names){const file=lstatSync(join(directory!,name));if(!file.isFile()||file.isSymbolicLink()||file.nlink!==1||file.size>4096)throw cloudUnavailable();existing+=file.size;}}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}this.quota!.reserve(claim,existing+16384,[directory!]);}try{await this.native.write(this.request('write',{path:file,bytes:bytes.length,sha256:hash(bytes)}),(async function*(){yield bytes;})(),signal);}finally{if(claim)this.quota!.release(claim);}}
 async writeObjectImmutable(file:string,bytes:number,digest:string,source:AsyncIterable<Uint8Array>,signal?:AbortSignal){path(file);bound(bytes);if(file!==`objects/${digest}`||! /^[a-f0-9]{64}$/.test(digest))throw cloudUnavailable();await this.access(signal);let size=0;const checksum=createHash('sha256');const verified=(async function*(){for await(const chunk of source){signal?.throwIfAborted();size+=chunk.length;if(size>bytes)throw cloudUnavailable();checksum.update(chunk);yield chunk;}if(size!==bytes||checksum.digest('hex')!==digest)throw cloudUnavailable();})();await this.native.write(this.request('write',{path:file,bytes,sha256:digest}),verified,signal);}
 async observation(marker:PortableCommit,signal?:AbortSignal){await this.access(signal);return await this.native.json(this.request('watch',{path:`commits/${marker.deviceId}/${marker.revisionId}.json`}),signal) as CloudObservation;}
 async confirm(marker:PortableCommit,signal?:AbortSignal):Promise<'local-only'>{await this.access(signal);const stored=await this.read(`commits/${marker.deviceId}/${marker.revisionId}.json`,16384,signal);if(hash(stored)!==hash(Buffer.from(JSON.stringify(marker))))throw cloudUnavailable();const observation=await this.observation(marker,signal);this.observations.set(marker.revisionId,observation);if(!observation.ubiquitous||observation.errorCode!==undefined)throw cloudUnavailable();return 'local-only';}
}
