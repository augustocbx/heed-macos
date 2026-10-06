import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash,randomUUID} from 'node:crypto';
import {createReadStream,existsSync,mkdirSync,readFileSync,readdirSync,lstatSync,realpathSync,readSync,rmSync,writeFileSync,renameSync,openSync,fsyncSync,closeSync} from 'node:fs';
import {join,dirname,relative,isAbsolute,sep} from 'node:path';
import type {LibraryPreview,LibrarySnapshot,PortableCommit,PortableManifest,PortableMeeting,PublicationState,Session,DeletionRecord,DeletionSelection,RevisionDescriptor,PublicationIntent} from '@heed/shared';
import {atomicWriteJson} from './atomic-json';import {atomicWrite,SessionTags} from './session-tags';
import {encode,makeBundle,MAX_ARTIFACT_BYTES,portableMeeting,revisionPath,sha256,UUID,validateBundle,validateCommit,validateManifest} from './portable-schema';
import {coordinatedProvider,providerPath,type LibraryProvider,type QuotaBudget,type RemoteTransaction,type TransactionContext} from './portable-provider';
import {RemoteDeletion} from './remote-deletion';
import {revisionKey,validateRevisionFence,validateDeletionRecord,validateRevisionDescriptor} from './portable-deletion-schema';
interface OptionalTask {controller:AbortController;done:Promise<void>;finish:()=>void}
interface Entry {localPublications?:Record<string,true>;providerId?:string;audioSource?:string;audioHash?:string;marker:PortableCommit;manifest:PortableManifest;preview:LibraryPreview;sessionId?:string;payloadHash?:string;commitIntent?:boolean;commitState?:PublicationState}
interface Catalog {version:1;libraryId:string;deviceId:string;aliases:Record<string,string>;heads:Record<string,string>;entries:Record<string,Entry>;complete:boolean;imported:number;skipped:number;error?:string;tombstones?:Record<string,true>;remoteDeletions?:Record<string,RevisionDescriptor>}
export interface PortableLibraryOptions {root:string;sessions:SessionTags;sessionsDir:string;quota:QuotaBudget;recordingsDir?:string;provider?:LibraryProvider;write?:typeof atomicWriteJson}
const entryKey=(m:PortableManifest|PortableCommit)=>`${m.libraryId}/${m.meetingId}/${m.revisionId}`;
const meetingKey=(m:PortableManifest|PortableCommit)=>`${m.libraryId}/${m.meetingId}`;
/** A complete SessionTags write is the only AI visibility boundary; remote previews never enter it. */
export class PortableLibrary {
 private state:Catalog;private statePath:string;private active=false;private activeTask?:OptionalTask;private providerTask?:OptionalTask;private providerSignal?:AbortSignal;private preemption?:Promise<void>;private lease?:symbol;private mutationLease?:symbol;private leaseContext=new AsyncLocalStorage<symbol>();
 private deletion?:RemoteDeletion;
 constructor(private options:PortableLibraryOptions){
  for(const category of ['catalog','media','indexes','staging'])mkdirSync(join(options.root,category),{recursive:true,mode:0o700});
  this.statePath=join(options.root,'catalog','state.json');
  if(existsSync(this.statePath)&&lstatSync(this.statePath).size>64_000_000)throw new Error('Invalid oversized private library catalog');
  this.state=existsSync(this.statePath)?JSON.parse(readFileSync(this.statePath,'utf8')):{version:1,libraryId:randomUUID(),deviceId:randomUUID(),aliases:{},heads:{},entries:{},complete:true,imported:0,skipped:0};
  if(this.state.version!==1||!UUID.test(this.state.libraryId)||!UUID.test(this.state.deviceId)||!this.state.aliases||!this.state.heads||!this.state.entries)throw new Error('Invalid private library catalog; preserve it for recovery');
  if(Object.keys(this.state.entries).length>10000)throw new Error('Private library catalog limit reached');
  if(this.state.remoteDeletions){if(Object.keys(this.state.remoteDeletions).length>10000)throw new Error('Remote deletion catalog limit reached');Object.values(this.state.remoteDeletions).forEach(validateRevisionDescriptor);}
  for(const entry of Object.values(this.state.entries)){validateCommit(entry.marker);validateManifest(entry.manifest);if(!entry.audioHash&&existsSync(join(this.canonical(entry),'meeting.json')))entry.audioHash=this.payload(entry).audio?.sha256;}
  if(!existsSync(this.statePath))this.persist(this.state);
  for(const entry of Object.values(this.state.entries).filter(e=>e.commitIntent&&e.sessionId)){
   const session=options.sessions.read(entry.sessionId!);if(!session)continue;const payload=this.payload(entry);const matches=sha256(encode(portableMeeting(session,entry.manifest.meetingId,payload.audio)))===entry.payloadHash;
   this.edit(next=>{const item=next.entries[entryKey(entry.manifest)]!;item.preview.state=matches?(item.commitState||'verified'):'conflict';item.preview.local=true;delete item.commitIntent;delete item.commitState;next.heads[meetingKey(entry.manifest)]=entry.manifest.revisionId;});
  }
  // Previous process jobs cannot be running; discard only our bounded staging directories and claims.
  for(const name of readdirSync(join(options.root,'staging'))){if(!UUID.test(name))continue;const path=join(options.root,'staging',name);if(!lstatSync(path).isDirectory())continue;rmSync(path,{recursive:true});options.quota.release(`library-${name}`);}
 }
 private persist(next:Catalog){if(Object.keys(next.entries).length>10000||encode(next).length>64_000_000)throw new Error('Private library catalog limit reached');(this.options.write||atomicWriteJson)(this.statePath,next);this.state=next;}
 private edit(change:(state:Catalog)=>void){const next=structuredClone(this.state);change(next);this.persist(next);}
 private canonical(entry:Entry){return join(this.options.root,'catalog','revisions',entry.manifest.libraryId,entry.manifest.meetingId,entry.manifest.revisionId);}
 private payload(entry:Entry):PortableMeeting{return validateBundle(entry.marker,entry.manifest,readFileSync(join(this.canonical(entry),'meeting.json')));}
 private saveArtifacts(entry:Entry,payload:PortableMeeting){const directory=this.canonical(entry);mkdirSync(directory,{recursive:true,mode:0o700});
  for(const [name,value] of [['meeting.json',payload],['manifest.json',entry.manifest]] as const){const path=join(directory,name);if(existsSync(path)){if(sha256(encode(JSON.parse(readFileSync(path,'utf8'))))!==sha256(encode(value)))throw new Error('Immutable local revision collision');}else atomicWrite(path,encode(value).toString('utf8'));}
  const commits=join(this.options.root,'catalog','commits',entry.marker.deviceId);mkdirSync(commits,{recursive:true,mode:0o700});(this.options.write||atomicWriteJson)(join(commits,`${entry.marker.revisionId}.json`),entry.marker);
 }
 private safeAudioSource(path:string):string {
  if(!isAbsolute(path)||!existsSync(path)||lstatSync(path).isSymbolicLink()||!lstatSync(path).isFile())throw new Error('Local archived audio is unavailable');const actual=realpathSync(path);
  const roots=[join(this.options.root,'media'),...(this.options.recordingsDir?[this.options.recordingsDir]:[])];if(!roots.some(root=>{if(!existsSync(root))return false;const child=relative(realpathSync(root),actual);return !!child&&!isAbsolute(child)&&child!=='..'&&!child.startsWith(`..${sep}`);}))throw new Error('Audio is outside managed recording roots; migrate it before publication');return actual;
 }
 private async inspectAudio(path:string,signal?:AbortSignal):Promise<{bytes:number;hash:string}> {
  const source=this.safeAudioSource(path),stat=lstatSync(source),hash=createHash('sha256');let bytes=0;
  for await(const chunk of createReadStream(source)){signal?.throwIfAborted();bytes+=chunk.length;if(bytes>stat.size)throw new Error('Audio changed during integrity verification');hash.update(chunk);}signal?.throwIfAborted();const after=lstatSync(source);if(bytes!==stat.size||after.size!==stat.size||after.mtimeMs!==stat.mtimeMs||after.ino!==stat.ino)throw new Error('Audio changed during integrity verification');return {bytes,hash:hash.digest('hex')};
 }
 private task():OptionalTask {let finish!:()=>void;return {controller:new AbortController(),done:new Promise<void>(resolve=>finish=resolve),finish:()=>finish()};}
 private signal(controller:AbortController,external?:AbortSignal,lease?:AbortSignal):AbortSignal {return AbortSignal.any([controller.signal,...(external?[external]:[]),...(lease?[lease]:[])]);}
 /** Recording waits for optional transfers and their cleanup; credential mutations are independent. */
 preempt():Promise<void> {if(this.preemption)return this.preemption;const tasks=[this.activeTask,this.providerTask].filter((task):task is OptionalTask=>!!task);if(!tasks.length)return Promise.resolve();const pending=Promise.all(tasks.map(task=>task.done)).then(()=>{});this.preemption=pending.finally(()=>{this.preemption=undefined;});for(const task of tasks)task.controller.abort(new Error('Library transfer interrupted for recording'));return this.preemption;}
 private async operation<T>(run:(signal:AbortSignal,tx?:RemoteTransaction)=>Promise<T>,external?:AbortSignal,kind:TransactionContext['kind']='read',operationId:string=randomUUID(),remote=true):Promise<T>{
  external?.throwIfAborted();if(this.preemption)throw new Error('Library transfers are paused for recording');if(this.active||(this.lease&&this.leaseContext.getStore()!==this.lease))throw new Error('A library operation is already running');
  const task=this.task(),signal=this.signal(task.controller,external,this.providerSignal);signal.throwIfAborted();this.active=true;if(!this.mutationLease)this.activeTask=task;
  try {
   const provider=this.options.provider;
   if(remote&&provider&&coordinatedProvider(provider)){
    if(!provider.withTransaction)throw new Error('Remote coordination is unavailable');
    return await provider.withTransaction!({operationId,deviceId:this.state.deviceId,kind},async tx=>{
     if(provider.deletionCapabilities?.destinationVersion===3&&typeof tx.observationDigest!=='function')throw Error('Remote coordination observation is unavailable');
     try{const result=await run(signal,tx);if(kind!=='delete')await tx.checkpoint();signal.throwIfAborted();return result;}
     catch(error){if(kind==='read')await tx.checkpoint();throw error;}
    },signal);
   }
   const result=await run(signal);signal.throwIfAborted();return result;
  }finally{this.active=false;if(this.activeTask===task)this.activeTask=undefined;task.finish();}
 }
 isBusy():boolean{return this.active||!!this.lease;}
 isMutationOwner():boolean{return !this.active&&!!this.mutationLease&&this.lease===this.mutationLease&&this.leaseContext.getStore()===this.mutationLease;}
 async withMutation<T>(run:(library:PortableLibrary)=>Promise<T>,signal?:AbortSignal):Promise<T>{signal?.throwIfAborted();if(this.active||this.lease||this.preemption)throw new Error('A library operation is already running');const lease=Symbol('mutation');this.lease=this.mutationLease=lease;try{return await this.leaseContext.run(lease,()=>run(this));}finally{this.mutationLease=undefined;this.lease=undefined;}}

 async withProvider<T>(provider:LibraryProvider,run:(library:PortableLibrary,signal:AbortSignal)=>Promise<T>,external?:AbortSignal):Promise<T>{external?.throwIfAborted();if(this.active||this.lease||this.preemption)throw new Error('A library operation is already running');const lease=Symbol('provider'),previous=this.options.provider,task=this.task(),signal=this.signal(task.controller,external);this.lease=lease;this.providerTask=task;this.providerSignal=signal;this.options.provider=provider;try{const invoke=()=>this.leaseContext.run(lease,()=>run(this,signal));const result=coordinatedProvider(provider)?await provider.withTransaction!({operationId:randomUUID(),deviceId:this.state.deviceId,kind:'publish'},async tx=>{if(provider.deletionCapabilities?.destinationVersion===3&&typeof tx.observationDigest!=='function')throw Error('Remote coordination observation is unavailable');const value=await invoke();await tx.checkpoint();return value;},signal):await invoke();signal.throwIfAborted();return result;}finally{this.options.provider=previous;this.providerTask=undefined;this.providerSignal=undefined;this.lease=undefined;task.finish();}}
 runMaintenance<T>(run:(signal:AbortSignal)=>Promise<T>,signal?:AbortSignal):Promise<T>{return this.operation(run,signal,'read',randomUUID(),false);}
 selectProvider(provider?:LibraryProvider):void{if(this.active||this.lease&&!this.isMutationOwner())throw new Error('A library operation is already running');this.options.provider=provider;}
 markDeleted(sessionId:string):void {const keys=Object.keys(this.state.aliases).filter(key=>this.state.aliases[key]===sessionId);if(keys.length)this.edit(next=>{next.tombstones||={};for(const key of keys)next.tombstones[key]=true;});}
 /** Pending queues must inspect private source ownership independently of provider-scoped discovery. */
 hasLocalRevision(revisionId:string):boolean {const entry=Object.values(this.state.entries).find(e=>e.manifest.revisionId===revisionId);return !!entry?.sessionId&&!!this.options.sessions.read(entry.sessionId)&&!this.state.tombstones?.[meetingKey(entry.manifest)];}
 isCurrentLocalRevision(revisionId:string):boolean {const entry=Object.values(this.state.entries).find(e=>e.manifest.revisionId===revisionId);return !!entry&&this.hasLocalRevision(revisionId)&&this.state.heads[meetingKey(entry.manifest)]===revisionId;}
 hasLocalPublication(revisionId:string):boolean {const entry=Object.values(this.state.entries).find(e=>e.manifest.revisionId===revisionId);return !!entry&&!!this.options.provider&&!!entry.localPublications?.[this.publicationScope(this.options.provider)];}
 private requireLocal(entry:Entry):void {if(!entry.sessionId||!this.options.sessions.read(entry.sessionId)||this.state.tombstones?.[meetingKey(entry.manifest)]){if(entry.sessionId)this.markDeleted(entry.sessionId);throw new Error('Local meeting was deleted; restore it explicitly before publication');}}
 private provider():LibraryProvider {if(!this.options.provider)throw new Error('No remote library provider is configured');return this.options.provider;}
 private publicationScope(provider:LibraryProvider):string {return sha256(encode([provider.id,provider.deletionCapabilities?.destinationId,provider.deletionCapabilities?.connectionGeneration]));}
 private remoteDeleted(revision:{libraryId:string;meetingId:string;revisionId:string}):boolean {const provider=this.options.provider;return !!provider?.deletionCapabilities?.destinationId&&!!this.state.remoteDeletions?.[`${provider.id}/${provider.deletionCapabilities.destinationId}/${revisionKey(revision)}`];}
 private applyDeletion(providerId:string,record:DeletionRecord):void {
  validateDeletionRecord(record);if(this.options.provider?.id!==providerId||this.options.provider.deletionCapabilities?.destinationId!==record.destinationId)throw Error('Remote deletion destination changed');
  this.edit(next=>{next.remoteDeletions||={};for(const revision of record.revisions){next.remoteDeletions[`${providerId}/${record.destinationId}/${revisionKey(revision)}`]=revision;const entry=next.entries[revisionKey(revision)];if(entry){entry.preview.state='unavailable';entry.preview.error='This remote revision was deleted. Local meeting content is preserved.';}}});
 }
 private deletionEngine():RemoteDeletion {return this.deletion||=new RemoteDeletion({path:join(this.options.root,'catalog','remote-deletions.json'),write:(path,value)=>(this.options.write||atomicWriteJson)(path,value),onIntent:(provider,record)=>this.applyDeletion(provider,record)});}
 async previewDeletion(selection:DeletionSelection,signal?:AbortSignal){return this.operation((effective,tx)=>{if(!tx)throw Error('Physical deletion requires a writable new v2 destination');return this.deletionEngine().preview(this.provider(),tx,selection,effective);},signal);}
 async confirmDeletion(token:string,confirmed:boolean,signal?:AbortSignal){if(!UUID.test(token))throw Error('Invalid deletion token');return this.operation((effective,tx)=>{if(!tx)throw Error('Physical deletion requires a writable new v2 destination');return this.deletionEngine().confirm(this.provider(),tx,token,confirmed,effective);},signal,'delete',token);}
 async retryDeletion(id:string,signal?:AbortSignal){if(!UUID.test(id))throw Error('Invalid deletion job');return this.operation((effective,tx)=>{if(!tx)throw Error('Physical deletion requires a writable new v2 destination');return this.deletionEngine().retry(this.provider(),tx,id,effective);},signal,'delete',id);}
 private recoveryEntries(job:NonNullable<ReturnType<NonNullable<LibraryProvider['pendingTransactions']>>>[number]):Entry[]|undefined {
  if(!job.recoverable||job.blockedReason||job.deviceId!==this.state.deviceId)return;
  if(job.releaseOnly)return [];
  if(job.kind==='delete')return;
  if(job.kind==='read')return job.admissions.length?undefined:[];
  if(!job.admissions.length)return;
  const entries=job.admissions.map(admission=>Object.values(this.state.entries).find(entry=>entry.manifest.meetingId===admission.meetingId&&entry.manifest.revisionId===admission.revisionId&&entry.marker.manifestHash===admission.manifestHash));
  if(entries.some(entry=>!entry?.sessionId||!this.options.sessions.read(entry.sessionId)||this.state.tombstones?.[meetingKey(entry.manifest)]||this.remoteDeleted(entry.manifest)))return;
  return entries as Entry[];
 }
 private recoveryMode(job:NonNullable<ReturnType<NonNullable<LibraryProvider['pendingTransactions']>>>[number]) {
  if(job.kind!=='publish'||job.releaseOnly||!job.recoverable||job.blockedReason||job.deviceId!==this.state.deviceId||!job.admissions.length)return job;
  const known=job.admissions.every(admission=>Object.values(this.state.entries).some(entry=>entry.manifest.meetingId===admission.meetingId&&entry.manifest.revisionId===admission.revisionId&&entry.marker.manifestHash===admission.manifestHash));
  return known?{...job,releaseAvailable:true,...(!this.recoveryEntries(job)?{releaseOnly:true}:{})}:job;
 }
 recoveryTransactions(){const destructive=new Set(this.deletionEngine().jobs().map(job=>job.id));return (this.options.provider?.pendingTransactions?.()||[]).map(job=>this.recoveryMode(job)).filter(job=>job.deviceId===this.state.deviceId&&(job.kind!=='delete'||job.releaseOnly||!destructive.has(job.operationId))).map(job=>({operationId:job.operationId,kind:job.kind,recoverable:!!this.recoveryEntries(job),...(job.releaseOnly?{releaseOnly:true}:{}),...('releaseAvailable' in job&&job.releaseAvailable?{releaseAvailable:true}:{}),...(job.blockedReason?{blockedReason:job.blockedReason}:{})}));}
 async reconcileTransaction(operationId:string,external?:AbortSignal,releaseOnly=false,providerOverride?:LibraryProvider):Promise<LibrarySnapshot>{
  if(!UUID.test(operationId))throw new Error('Invalid original remote operation');external?.throwIfAborted();if(this.active||this.lease||this.preemption)throw new Error('A library operation is already running');
  const provider=providerOverride??this.provider(),previous=this.options.provider;if(providerOverride&&!coordinatedProvider(provider))throw new Error('Original operation coordination is unavailable');const original=provider.pendingTransactions?.().find(item=>item.operationId===operationId);let job=original&&this.recoveryMode(original);if(job&&releaseOnly){if(!job.releaseOnly&&!('releaseAvailable' in job&&job.releaseAvailable))throw new Error('Original release-only recovery cannot be proven');job={...job,releaseOnly:true};}const entries=job&&this.recoveryEntries(job);
  if(!job||!entries||!provider.withTransaction)throw new Error('Original operation recovery is required; preserve its journal and destination');
  const lease=Symbol('recovery'),task=this.task(),signal=this.signal(task.controller,external);this.lease=lease;this.providerTask=task;this.providerSignal=signal;this.options.provider=provider;
  try{return await this.leaseContext.run(lease,()=>provider.withTransaction!({operationId,deviceId:this.state.deviceId,kind:job.kind},async tx=>{
   if(provider.deletionCapabilities?.destinationVersion===3&&typeof tx.observationDigest!=='function')throw Error('Remote coordination observation is unavailable');
   if(job.releaseOnly){await tx.checkpoint();return this.snapshot();}
   if(job.kind==='read')await this.discover(signal);else for(const entry of entries){await this.publish(entry.manifest.revisionId,signal);if(this.state.entries[entryKey(entry.manifest)]?.preview.state!=='verified')throw Error('Original publication remains incomplete; preserve its exact job');}
   await tx.checkpoint();return this.snapshot();
  },signal));}finally{this.options.provider=previous;this.lease=undefined;this.providerTask=undefined;this.providerSignal=undefined;task.finish();}
 }
 deletionJobs(){return this.deletionEngine().jobs(this.options.provider);}
 snapshot():LibrarySnapshot {const deletedSources=new Set(Object.entries(this.state.aliases).filter(([key])=>this.state.tombstones?.[key]).map(([,id])=>id));const previews=Object.values(this.state.entries).filter(entry=>!this.options.provider||!entry.providerId||entry.providerId===this.options.provider.id||!!entry.sessionId&&!!this.options.sessions.read(entry.sessionId)).map(entry=>({...entry.preview,deleted:!!this.state.tombstones?.[meetingKey(entry.manifest)],remoteDeleted:this.remoteDeleted(entry.manifest),local:!!entry.sessionId&&!!this.options.sessions.read(entry.sessionId),remoteAvailable:!!this.options.provider&&(entry.providerId===this.options.provider.id||!!entry.localPublications?.[this.publicationScope(this.options.provider)])}));return {localMeetings:this.options.sessions.snapshot().sessions.filter(s=>s.transcriptFinalized===true&&!deletedSources.has(s.id)&&!Object.values(this.state.entries).some(e=>e.sessionId===s.id&&this.state.heads[meetingKey(e.manifest)]===e.manifest.revisionId&&this.remoteDeleted(e.manifest))).map(s=>({id:s.id,title:s.title})),configured:!!this.options.provider,providerId:this.options.provider?.id,readOnly:this.options.provider?.readOnly,capabilities:this.options.provider?.capabilities,deletionCapabilities:this.options.provider?.deletionCapabilities,providerName:this.options.provider?.name,previews:previews.sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt)||a.meetingId.localeCompare(b.meetingId)||a.revisionId.localeCompare(b.revisionId)),imported:this.state.imported,skipped:this.state.skipped,pending:previews.filter(p=>!p.local||['pending','uploading','unavailable'].includes(p.state)).length,complete:this.state.complete,error:this.state.error};}
 async discover(signal?:AbortSignal):Promise<LibrarySnapshot>{return this.operation(async(signal,tx)=>{
  const provider=this.provider();let cursor:string|null=null;const seen=new Set<string>();let complete=true,count=0;const discovered:Entry[]=[];const revisions=new Map(Object.entries(this.state.entries));
  try {if(tx){if(provider.deletionCapabilities?.confirmation==='pending-propagation'){const result=await this.deletionEngine().reconcile(provider,tx,signal);if(result?.state==='incomplete')throw Error('iCloud deletion reconciliation is incomplete; retry the exact confirmed job');}const inventory=await tx.inventory(signal);if(!inventory.complete)throw new Error('Remote discovery is incomplete');for(const record of inventory.deletions){validateDeletionRecord(record);this.applyDeletion(provider.id,record);}}for(let page=0;page<100;page++){
   signal?.throwIfAborted();const result=await provider.list(cursor,100,signal);if(!Array.isArray(result.commits)||result.commits.length>100||typeof result.complete!=='boolean'||(result.next!==null&&typeof result.next!=='string'))throw new Error('Invalid provider discovery page');complete=complete&&result.complete;
   for(const raw of result.commits){if(++count>10000)throw new Error('Library discovery limit reached; select a smaller collection');const marker=validateCommit(raw);if(this.remoteDeleted(marker))continue;const manifestBytes=await provider.read(providerPath(marker.manifestPath),65536,signal);if(manifestBytes.length>65536)throw new Error('Provider exceeded metadata read limit');const parsed=JSON.parse(Buffer.from(manifestBytes).toString('utf8'));if(parsed.kind==='heed-deleted-revision'){const fence=validateRevisionFence(parsed);if(revisionKey(fence.revision)!==revisionKey(marker)||fence.destinationId!==provider.deletionCapabilities?.destinationId||fence.artifact.sha256!==marker.manifestHash)throw new Error('Invalid canonical deletion identity');this.applyDeletion(provider.id,{version:1,jobId:fence.jobId,destinationId:fence.destinationId,revisions:[fence.revision],artifacts:[fence.artifact]});continue;}const manifest=validateManifest(parsed);
    if(marker.manifestHash!==sha256(encode(manifest))||marker.libraryId!==manifest.libraryId||marker.meetingId!==manifest.meetingId||marker.revisionId!==manifest.revisionId)throw new Error('Invalid committed manifest');
    // Preview metadata is verified transcript content, but remains outside the authoritative session store.
    const bytes=await provider.read(providerPath(`${revisionPath(manifest.meetingId,manifest.revisionId)}/meeting.json`),manifest.artifacts[0]!.bytes,signal);const payload=validateBundle(marker,manifest,bytes);const old=revisions.get(entryKey(manifest));if(!old&&revisions.size>=10000)throw new Error('Private library catalog limit reached');if(old&&old.marker.manifestHash!==marker.manifestHash)throw new Error('Immutable remote revision changed');
    const entry=old?{...old,providerId:provider.id}:{providerId:provider.id,audioHash:payload.audio?.sha256,marker,manifest,preview:{libraryId:manifest.libraryId,meetingId:manifest.meetingId,revisionId:manifest.revisionId,title:payload.title,createdAt:payload.createdAt,bytes:bytes.length,local:false,state:'pending',audio:!!payload.audio}} as Entry;if(tx&&entry.sessionId&&!entry.commitIntent&&entry.payloadHash===sha256(bytes)&&this.options.sessions.read(entry.sessionId)){entry.localPublications={...entry.localPublications,[this.publicationScope(provider)]:true};}revisions.set(entryKey(manifest),entry);discovered.push(entry);
   }
   if(result.next===null){cursor=null;break;}if(seen.has(result.next))throw new Error('Provider repeated a discovery cursor');seen.add(result.next);cursor=result.next;
  }if(cursor!==null)throw new Error('Library discovery page limit reached');
  const graph={...this.state.entries,...Object.fromEntries(discovered.map(entry=>[entryKey(entry.manifest),entry]))};const visiting=new Set<string>(),done=new Set<string>();
  const visit=(key:string,depth=0)=>{if(done.has(key))return;if(visiting.has(key)||depth>256)throw new Error('Revision parent cycle or excessive depth');const entry=graph[key];if(!entry)return;visiting.add(key);for(const parent of entry.manifest.parents)visit(`${meetingKey(entry.manifest)}/${parent}`,depth+1);visiting.delete(key);done.add(key);};
  try{for(const key of Object.keys(graph))visit(key);}catch(error){discovered.splice(0);throw error;}

  this.edit(next=>{for(const entry of discovered){next.entries[entryKey(entry.manifest)]=entry;const key=meetingKey(entry.manifest);if(!next.aliases[key])next.aliases[key]=Object.values(next.aliases).includes(entry.manifest.meetingId)||!!this.options.sessions.read(entry.manifest.meetingId)?randomUUID():entry.manifest.meetingId;}next.complete=complete;delete next.error;});
  if(complete){signal?.throwIfAborted();await provider.acknowledgeDiscovery?.(signal);}
  }catch(error){this.edit(next=>{for(const entry of discovered){next.entries[entryKey(entry.manifest)]=entry;const key=meetingKey(entry.manifest);if(!next.aliases[key])next.aliases[key]=Object.values(next.aliases).includes(entry.manifest.meetingId)||!!this.options.sessions.read(entry.manifest.meetingId)?randomUUID():entry.manifest.meetingId;}next.complete=false;next.error=error instanceof Error?error.message:'Library unavailable';});if(signal?.aborted)throw error;}
  return this.snapshot();
 },signal);}
 private descends(candidate:Entry,revision:string,visited=new Set<string>()):boolean {if(candidate.manifest.parents.includes(revision))return true;if(visited.has(candidate.manifest.revisionId))return false;visited.add(candidate.manifest.revisionId);return candidate.manifest.parents.some(id=>{const parent=this.state.entries[`${meetingKey(candidate.manifest)}/${id}`];return !!parent&&this.descends(parent,revision,visited);});}
 private sessionFor(entry:Entry,payload:PortableMeeting):Session {const alias=this.state.aliases[meetingKey(entry.manifest)]||payload.meetingId;const {schemaVersion,meetingId,audio,...fields}=payload;return {...fields,id:alias,files:undefined,audioArchived:!!audio};}
 private quotaJob(entry:Entry,session:Session):{id:string;path:string;finish:()=>void}{const job=randomUUID(),id=`library-${job}`,path=join(this.options.root,'staging',job);const sessionPath=join(this.options.sessionsDir,`${session.id}.json`);const bytes=4*entry.preview.bytes+2*encode(session).length+4*encode(this.state).length+131072;
  this.options.quota.reserve(id,bytes,[path,this.canonical(entry),sessionPath,this.statePath,join(this.options.root,'catalog','commits',entry.marker.deviceId,`${entry.marker.revisionId}.json`)]);
  try{mkdirSync(path,{recursive:true,mode:0o700});atomicWriteJson(join(path,'job.json'),{version:1,id,revisionId:entry.manifest.revisionId});}catch(error){this.options.quota.release(id);throw error;}
  return {id,path,finish:()=>{rmSync(path,{recursive:true,force:true});this.options.quota.release(id);}};
 }
 async importSelected(revisionIds?:string[],signal?:AbortSignal):Promise<LibrarySnapshot>{return this.operation(async(signal,tx)=>{
  const provider=this.provider();let imported=0,skipped=0;
  const entries=Object.values(this.state.entries).filter(e=>(!e.providerId||e.providerId===provider.id)&&(!revisionIds||revisionIds.includes(e.manifest.revisionId))&&!this.remoteDeleted(e.manifest)).sort((a,b)=>Date.parse(b.preview.createdAt)-Date.parse(a.preview.createdAt)||a.manifest.meetingId.localeCompare(b.manifest.meetingId)||a.manifest.revisionId.localeCompare(b.manifest.revisionId));
  for(const entry of entries){signal?.throwIfAborted();const deletedKey=meetingKey(entry.manifest);if(entry.sessionId&&!this.options.sessions.read(entry.sessionId))this.markDeleted(entry.sessionId);if(this.state.tombstones?.[deletedKey]&&!revisionIds){skipped++;continue;}if(entry.sessionId&&this.options.sessions.read(entry.sessionId))continue;let job:ReturnType<PortableLibrary['quotaJob']>|undefined;
   try {const estimate=this.sessionFor(entry,{...({} as PortableMeeting),meetingId:entry.manifest.meetingId});job=this.quotaJob(entry,estimate);
    const bytes=await provider.read(providerPath(`${revisionPath(entry.manifest.meetingId,entry.manifest.revisionId)}/meeting.json`),entry.manifest.artifacts[0]!.bytes,signal);signal?.throwIfAborted();const payload=validateBundle(entry.marker,entry.manifest,bytes);atomicWrite(join(job.path,'meeting.json'),Buffer.from(bytes).toString('utf8'));this.saveArtifacts(entry,payload);
    const key=meetingKey(entry.manifest),head=this.state.heads[key],previous=head?this.state.entries[`${key}/${head}`]:undefined;const current=previous?.sessionId?this.options.sessions.read(previous.sessionId):null;
    const changed=!!current&&sha256(encode(portableMeeting(current,entry.manifest.meetingId,this.payload(previous!).audio)))!==previous!.payloadHash;
    if(previous&&current&&!changed&&this.descends(previous,entry.manifest.revisionId)){this.edit(next=>{const item=next.entries[entryKey(entry.manifest)]!;item.preview.state='verified';item.sessionId=current.id;item.payloadHash=sha256(bytes);});continue;}
    if(previous&&current&&(changed||!this.descends(entry,head!))){this.edit(next=>{const item=next.entries[entryKey(entry.manifest)]!;item.preview.state='conflict';item.payloadHash=sha256(bytes);});skipped++;continue;}
    const session=this.sessionFor(entry,payload);if(current?.files?.wav&&(!payload.audio||this.payload(previous!).audio?.sha256===payload.audio.sha256))session.files=current.files;this.edit(next=>{const item=next.entries[entryKey(entry.manifest)]!;item.sessionId=session.id;item.payloadHash=sha256(bytes);item.commitIntent=true;next.aliases[key]=session.id;});
    this.options.sessions.save(session);
    this.edit(next=>{const item=next.entries[entryKey(entry.manifest)]!;item.sessionId=session.id;item.payloadHash=sha256(bytes);item.preview.local=true;item.preview.state='verified';delete item.preview.error;delete item.commitIntent;if(tx){item.localPublications||={};item.localPublications[this.publicationScope(provider)]=true;}if(next.tombstones)delete next.tombstones[key];next.aliases[key]=session.id;next.heads[key]=entry.manifest.revisionId;});imported++;
   }catch(error){if(signal?.aborted)throw error;skipped++;this.edit(next=>{const item=next.entries[entryKey(entry.manifest)]!;item.preview.state='unavailable';item.preview.error=error instanceof Error?error.message:'Import unavailable';});}
   finally{job?.finish();}
  }
  this.edit(next=>{next.imported=imported;next.skipped=skipped;});return this.snapshot();
 },signal);}
 async queueLocal(sessionId:string,signal?:AbortSignal,explicit=false):Promise<LibraryPreview>{return this.operation(effective=>this.queueLocalRecord(sessionId,effective,explicit),signal,'read',randomUUID(),false);}
 async queueFreshRevision(revisionId:string,signal?:AbortSignal):Promise<LibraryPreview>{return this.operation(effective=>{const entry=Object.values(this.state.entries).find(item=>item.manifest.revisionId===revisionId);if(!entry?.sessionId||!this.remoteDeleted(entry.manifest))throw new Error('Invalid deleted local revision');this.requireLocal(entry);return this.queueLocalRecord(entry.sessionId,effective,true);},signal,'read',randomUUID(),false);}
 private async queueLocalRecord(sessionId:string,signal?:AbortSignal,explicit=false):Promise<LibraryPreview> {
  const session=this.options.sessions.read(sessionId);if(!session)throw new Error('Meeting not found');
  const existingKey=Object.keys(this.state.aliases).find(key=>this.state.aliases[key]===sessionId);const libraryId=existingKey?.split('/')[0]||this.state.libraryId,meetingId=existingKey?.split('/')[1]||randomUUID(),key=`${libraryId}/${meetingId}`;const head=this.state.heads[key],previous=head?this.state.entries[`${key}/${head}`]:undefined;
  if(previous&&this.remoteDeleted(previous.manifest)&&!explicit)throw new Error('This remote revision was deleted; create a fresh revision explicitly before publishing');
  let inspectionId:string|undefined;try{
  let audio=previous?this.payload(previous).audio:undefined,audioSource=previous?.audioSource;
  if(session.files?.wav){audioSource=session.files.wav;this.safeAudioSource(audioSource);const claim=`library-inspect-${randomUUID()}`;this.options.quota.reserve(claim,lstatSync(audioSource).size,[audioSource]);inspectionId=claim;const inspected=await this.inspectAudio(audioSource,signal);signal?.throwIfAborted();if(inspected.bytes<12)throw new Error('Invalid local WAV');const header=Buffer.alloc(12),fd=openSync(audioSource,'r');try{readSync(fd,header,0,12,0);}finally{closeSync(fd);}if(!['RIFF','RF64'].includes(header.toString('ascii',0,4))||header.toString('ascii',8,12)!=='WAVE')throw new Error('Invalid local WAV');audio={sha256:inspected.hash,bytes:inspected.bytes,format:'wav',mode:'archived',objectPath:`objects/${inspected.hash}`};}
  const current=this.options.sessions.read(sessionId);if(!current||JSON.stringify(portableMeeting(current,meetingId))!==JSON.stringify(portableMeeting(session,meetingId)))throw new Error('Local meeting changed during publication preparation; retry');
  const payload=portableMeeting(session,meetingId,audio),hash=sha256(encode(payload));if(previous?.payloadHash===hash&&!this.remoteDeleted(previous.manifest)){if(this.state.tombstones?.[key])this.edit(next=>{delete next.tombstones![key];});if(audioSource&&previous.audioSource!==audioSource)this.edit(next=>{next.entries[entryKey(previous.manifest)]!.audioSource=audioSource;});if(audio&&!session.audioArchived)this.options.sessions.save({...session,audioArchived:true});return previous.preview;}
  const bundle=makeBundle(libraryId,this.state.deviceId,payload,head?[head]:[]);const entry:Entry={marker:bundle.marker,manifest:bundle.manifest,payloadHash:hash,sessionId,audioSource,audioHash:audio?.sha256,preview:{libraryId,meetingId,revisionId:bundle.manifest.revisionId,title:session.title,createdAt:session.createdAt,bytes:encode(payload).length,local:true,state:'pending',audio:!!payload.audio}};
  const job=this.quotaJob(entry,session);try{this.saveArtifacts(entry,payload);this.edit(next=>{next.entries[entryKey(entry.manifest)]=entry;next.aliases[key]=sessionId;next.heads[key]=entry.manifest.revisionId;if(next.tombstones)delete next.tombstones[key];});if(audio&&!session.audioArchived)this.options.sessions.save({...session,audioArchived:true});return entry.preview;}finally{job.finish();}
  }finally{if(inspectionId)this.options.quota.release(inspectionId);}
 }
 async resolveConflict(revisionId:string,signal?:AbortSignal):Promise<LibraryPreview>{return this.operation(async(signal)=>{
  const selected=Object.values(this.state.entries).find(e=>e.manifest.revisionId===revisionId);if(!selected||selected.preview.state!=='conflict')throw new Error('Conflict revision not found');
  const key=meetingKey(selected.manifest),oldHead=this.state.heads[key],old=oldHead?this.state.entries[`${key}/${oldHead}`]:undefined;if(!old?.sessionId)throw new Error('Current local meeting not found');
  await this.queueLocalRecord(old.sessionId,signal);const head=this.state.heads[key],previous=head?this.state.entries[`${key}/${head}`]:undefined;if(!previous?.sessionId)throw new Error('Current local meeting not found');
  const payload=this.payload(selected),session={...this.sessionFor(selected,payload),id:previous.sessionId};const parents=[...new Set([head!,...Object.values(this.state.entries).filter(e=>meetingKey(e.manifest)===key&&e.preview.state==='conflict').map(e=>e.manifest.revisionId)])];
  const bundle=makeBundle(selected.manifest.libraryId,this.state.deviceId,payload,parents);const entry:Entry={marker:bundle.marker,manifest:bundle.manifest,sessionId:session.id,audioHash:payload.audio?.sha256,payloadHash:sha256(encode(payload)),commitIntent:true,commitState:'pending',preview:{...selected.preview,revisionId:bundle.manifest.revisionId,local:true,state:'pending'}};
  const job=this.quotaJob(entry,session);try{this.saveArtifacts(entry,payload);this.edit(next=>{next.entries[entryKey(entry.manifest)]=entry;});this.options.sessions.save(session);this.edit(next=>{delete next.entries[entryKey(entry.manifest)]!.commitIntent;delete next.entries[entryKey(entry.manifest)]!.commitState;next.heads[key]=entry.manifest.revisionId;for(const id of parents){const old=next.entries[`${key}/${id}`];if(old?.preview.state==='conflict')old.preview.state='verified';}});return entry.preview;}finally{job.finish();}
 },signal,'read',randomUUID(),false);}
 async publish(revisionId:string,signal?:AbortSignal):Promise<LibrarySnapshot>{return this.operation(async(signal,tx)=>{
  const provider=this.provider();const entry=Object.values(this.state.entries).find(e=>e.manifest.revisionId===revisionId);if(!entry?.sessionId)throw new Error('Local revision not found');this.requireLocal(entry);const payload=this.payload(entry);
  if(tx){const inventory=await tx.inventory(signal);if(!inventory.complete)throw new Error('Remote discovery is incomplete');for(const record of inventory.deletions)this.applyDeletion(provider.id,record);}
  if(this.remoteDeleted(entry.manifest))return this.snapshot();
  const prefix=revisionPath(entry.manifest.meetingId,entry.manifest.revisionId),intent:PublicationIntent={version:1,id:entry.manifest.revisionId,deviceId:this.state.deviceId,revision:{libraryId:entry.manifest.libraryId,meetingId:entry.manifest.meetingId,revisionId:entry.manifest.revisionId},...(payload.audio?{audio:{path:payload.audio.objectPath,bytes:payload.audio.bytes,sha256:payload.audio.sha256}}:{})};
  const publication=this.publicationScope(provider);
  const verifyPublished=async()=>{const bytes=await provider.read(entry.marker.manifestPath,65536,signal);if(sha256(bytes)!==entry.marker.manifestHash)throw Error('Published manifest changed');const manifest=JSON.parse(Buffer.from(bytes).toString('utf8'));validateBundle(entry.marker,manifest,await provider.read(`${prefix}/meeting.json`,MAX_ARTIFACT_BYTES,signal));signal.throwIfAborted();};
  this.edit(next=>{next.entries[entryKey(entry.manifest)]!.preview.state='uploading';});
  try {
   // A committed import is observation proof for this exact scope, never admission or pending-intent authority.
   if(tx&&entry.localPublications?.[publication]){const confirmation=await provider.confirm(entry.marker,signal);await verifyPublished();this.edit(next=>{const saved=next.entries[entryKey(entry.manifest)]!;saved.preview.state=confirmation==='remote-confirmed'?'verified':'pending';delete saved.preview.error;});return this.snapshot();}
   // V2 exclusive canonical admission fences stale publishers before any payload or media writes.
   if(tx){await provider.writeImmutable(entry.marker.manifestPath,encode(entry.manifest),signal);await tx.writePending(intent,signal);}
   if(payload.audio){const path=this.safeAudioSource(entry.audioSource||join(this.options.root,'media',`${payload.audio.sha256}.wav`));if(!existsSync(path)||lstatSync(path).size!==payload.audio.bytes)throw new Error('Archived audio unavailable locally');await provider.writeObjectImmutable(providerPath(payload.audio.objectPath),payload.audio.bytes,payload.audio.sha256,createReadStream(path),signal);}
   await provider.writeImmutable(providerPath(`${prefix}/meeting.json`),encode(payload),signal);if(!tx)await provider.writeImmutable(entry.marker.manifestPath,encode(entry.manifest),signal);signal.throwIfAborted();this.requireLocal(entry);await provider.writeImmutable(providerPath(`commits/${entry.marker.deviceId}/${entry.marker.revisionId}.json`),encode(entry.marker),signal);
   const confirmation=await provider.confirm(entry.marker,signal);signal.throwIfAborted();this.edit(next=>{next.entries[entryKey(entry.manifest)]!.preview.state=confirmation==='remote-confirmed'?'provider-confirmed':'pending';});
   if(confirmation==='remote-confirmed'||tx&&confirmation==='local-only'){await verifyPublished();this.edit(next=>{const saved=next.entries[entryKey(entry.manifest)]!;saved.preview.state=confirmation==='remote-confirmed'?'verified':'pending';saved.localPublications||={};saved.localPublications[publication]=true;delete saved.preview.error;});if(tx&&confirmation==='remote-confirmed')await tx.retirePending(intent,signal);}
  }catch(error){this.edit(next=>{next.entries[entryKey(entry.manifest)]!.preview.state='unavailable';next.entries[entryKey(entry.manifest)]!.preview.error=error instanceof Error?error.message:'Publication unavailable';});if(tx&&error instanceof Error&&(error as Error&{code?:string}).code==='canonical-collision-noeffect')await tx.checkpoint();if(tx||signal.aborted)throw error;}
  return this.snapshot();
 },signal,'publish');}
 async requestAudio(sessionId:string,signal?:AbortSignal):Promise<string>{return this.operation(async(signal)=>{
  const key=Object.keys(this.state.aliases).find(key=>this.state.aliases[key]===sessionId),head=key&&this.state.heads[key],entry=key&&head&&this.state.entries[`${key}/${head}`];if(!entry)throw new Error('No archived audio reference');this.requireLocal(entry);const payload=this.payload(entry),audio=payload.audio;if(!audio)throw new Error('No archived audio reference');const path=join(this.options.root,'media',`${audio.sha256}.wav`);
  const apply=()=>{const session=this.options.sessions.read(sessionId);if(!session)throw new Error('Meeting not found');const restored={...session,files:{...session.files,wav:path},audioArchived:true};delete (restored as any).audioExpired;delete (restored as any).audioRemovedAt;this.options.sessions.save(restored);return path;};
  if(existsSync(path)){const inspected=await this.inspectAudio(path,signal);if(inspected.bytes===audio.bytes&&inspected.hash===audio.sha256)return apply();throw new Error('Cached audio integrity verification failed');}
  const provider=this.provider(),job=randomUUID(),id=`library-${job}`,staging=join(this.options.root,'staging',job);this.options.quota.reserve(id,audio.bytes*2+4*encode(this.state).length+131072,[staging,path,join(this.options.sessionsDir,`${sessionId}.json`)]);
  try{mkdirSync(staging,{recursive:true,mode:0o700});const file=join(staging,'verified.wav'),fd=openSync(file,'wx',0o600),hash=createHash('sha256');let received=0;
   try{for await(const chunk of provider.stream(providerPath(audio.objectPath),audio.bytes,signal)){signal?.throwIfAborted();received+=chunk.length;if(received>audio.bytes)throw new Error('Audio transfer exceeded declared size');hash.update(chunk);writeFileSync(fd,chunk);}signal.throwIfAborted();if(received!==audio.bytes||hash.digest('hex')!==audio.sha256)throw new Error('Audio integrity verification failed');fsyncSync(fd);}finally{closeSync(fd);}
   renameSync(file,path);const dir=openSync(dirname(path),'r');try{fsyncSync(dir);}finally{closeSync(dir);}return apply();
  }finally{rmSync(staging,{recursive:true,force:true});this.options.quota.release(id);}
 },signal);}
 protectedPaths(revisionIds?:string[]):string[]{const requested=new Set(revisionIds);return Object.values(this.state.entries).filter(e=>!this.state.tombstones?.[meetingKey(e.manifest)]&&(e.preview.state!=='verified'||requested.has(e.manifest.revisionId))).flatMap(e=>{try{const hash=e.audioHash;return hash?[join(this.options.root,'media',`${hash}.wav`),...(e.audioSource?[e.audioSource]:[])]:[];}catch{return [];}});}
}
