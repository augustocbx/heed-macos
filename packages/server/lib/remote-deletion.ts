import {lstatSync,mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {ArtifactIdentity,DeletionJob,DeletionPreview,DeletionRecord,DeletionSelection,RevisionDescriptor,RevisionKey,RevisionDeletionFence} from '@heed/shared';
import type {LibraryProvider,RemoteTransaction} from './portable-provider';
import {atomicWriteJson} from './atomic-json';
import {readPrivateJson} from './connectors/private-json';
import {encode,MAX_ARTIFACT_BYTES,revisionPath,sha256,validateBundle,validateCommit,validateManifest,UUID} from './portable-schema';
import {equivalentRevisionFence,canonicalControl,revisionKey,validateDeletionRecord,validatePublicationIntent,validateRevisionKey,validateRevisionFence} from './portable-deletion-schema';

interface Plan {binding:string;digest:string;record:DeletionRecord;retainedBytes:number}
interface PreviewState {view:DeletionPreview;plan:Plan}
interface JobState {view:DeletionJob;plan:Plan;completed:string[];fences:string[]}
interface State {reconcileCursor?:string;version:1;previews:Record<string,PreviewState>;jobs:Record<string,JobState>}
interface Options {path:string;write?:typeof atomicWriteJson;now?:()=>number;onIntent?:(providerId:string,record:DeletionRecord)=>void}
/** A private exact-job journal is the only authority to continue already-confirmed destructive work. */
export class RemoteDeletion {
 private state:State;
 constructor(private options:Options){
  let present=true;try{lstatSync(options.path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')present=false;else throw error;}
  this.state=present?readPrivateJson<State>(options.path,16_000_000):{version:1,previews:{},jobs:{}};
  if(this.state.version!==1||!this.state.previews||!this.state.jobs||Object.keys(this.state.previews).length>64||Object.keys(this.state.jobs).length>128)throw Error('Invalid deletion journal; preserve it for recovery');
  for(const [id,item] of Object.entries(this.state.previews)){if(!UUID.test(id)||item.view.token!==id||!Number.isFinite(Date.parse(item.view.expiresAt)))throw Error('Invalid deletion journal');this.selection(item.view.selection);this.plan(item.plan,id);this.sameSelection(item.view.selection,item.plan.record);}
  for(const [id,item] of Object.entries(this.state.jobs)){if(!UUID.test(id)||item.view.id!==id||!['prepared','deleting','incomplete','pending-verification','pending-propagation'].includes(item.view.state)||!Array.isArray(item.completed)||!Array.isArray(item.fences))throw Error('Invalid deletion journal');this.selection(item.view.selection);this.plan(item.plan,id);this.sameSelection(item.view.selection,item.plan.record);if(item.completed.some(path=>!item.plan.record.artifacts.some(a=>a.path===path))||item.fences.some(path=>!item.plan.record.artifacts.some(a=>a.path===path&&path.endsWith('/manifest.json'))))throw Error('Invalid deletion receipts');}
 }
 private plan(plan:Plan,id:string){if(!plan||typeof plan.binding!=='string'||! /^[A-Za-z0-9_-]{1,128}$/.test(plan.binding)||! /^[a-f0-9]{64}$/.test(plan.digest)||!Number.isSafeInteger(plan.retainedBytes)||plan.retainedBytes<0)throw Error('Invalid deletion plan');validateDeletionRecord(plan.record);if(plan.record.jobId!==id)throw Error('Invalid deletion plan identity');}
 private sameSelection(selection:DeletionSelection,record:DeletionRecord){if(selection.destinationId!==record.destinationId||selection.revisions.map(revisionKey).sort().join('|')!==record.revisions.map(revisionKey).sort().join('|'))throw Error('Invalid deletion selection identity');}
 private selection(value:DeletionSelection){if(!value||Object.keys(value).some(key=>!['providerId','destinationId','revisions'].includes(key))||typeof value.providerId!=='string'||! /^[A-Za-z0-9_-]{1,128}$/.test(value.providerId)||!UUID.test(value.destinationId)||!Array.isArray(value.revisions)||value.revisions.length<1||value.revisions.length>1000)throw Error('Invalid deletion selection');value.revisions.forEach(validateRevisionKey);if(new Set(value.revisions.map(revisionKey)).size!==value.revisions.length)throw Error('Invalid duplicate deletion selection');}
 private bound(provider:LibraryProvider,selection:DeletionSelection,binding?:string){this.selection(selection);const caps=provider.deletionCapabilities;if(!caps||caps.destinationVersion!==2||!caps.revisionMetadata||provider.readOnly||!provider.withTransaction)throw Error('Physical deletion requires a writable new v2 destination');if(binding!==undefined&&caps.connectionGeneration!==binding)throw Error('The deletion configuration changed; refresh and review again');if(typeof caps.connectionGeneration!=='string'||! /^[A-Za-z0-9_-]{1,128}$/.test(caps.connectionGeneration))throw Error('Invalid deletion configuration');if(provider.id!==selection.providerId||caps.destinationId!==selection.destinationId)throw Error('The deletion destination changed; refresh and review again');}
 private edit(change:(next:State)=>void){const next=structuredClone(this.state);change(next);if(encode(next).length>16_000_000||Object.keys(next.jobs).length>128||Object.keys(next.previews).length>64)throw Error('Deletion journal limit reached; preserve existing jobs');mkdirSync(dirname(this.options.path),{recursive:true,mode:0o700});(this.options.write||atomicWriteJson)(this.options.path,next);this.state=next;}
 private now(){return this.options.now?.()??Date.now();}
 jobs(provider?:LibraryProvider):DeletionJob[]{return Object.values(this.state.jobs).map(item=>({...structuredClone(item.view),...(provider&&(item.view.selection.providerId!==provider.id||item.view.selection.destinationId!==provider.deletionCapabilities?.destinationId||item.plan.binding!==provider.deletionCapabilities?.connectionGeneration)?{blockedReason:'Original connection generation required'}:{})}));}
 job(id:string):DeletionJob{const item=this.state.jobs[id];if(!item)throw Error('Invalid deletion job');return structuredClone(item.view);}
 hasUnresolved(){return Object.values(this.state.jobs).some(item=>!['pending-verification','pending-propagation'].includes(item.view.state));}
 private async scan(provider:LibraryProvider,tx:RemoteTransaction,selection:DeletionSelection,id:string,signal?:AbortSignal):Promise<Plan>{
  this.bound(provider,selection);signal?.throwIfAborted();const inventory=await tx.inventory(signal);
  if(!inventory.complete||!Array.isArray(inventory.commits)||!Array.isArray(inventory.deletions)||!Array.isArray(inventory.pending)||inventory.commits.length>10000||inventory.deletions.length>10000||inventory.pending.length>10000)throw Error('Remote discovery is incomplete; no deletion is permitted');
  const deleted=new Set<string>();for(const record of inventory.deletions){validateDeletionRecord(record);if(record.destinationId!==selection.destinationId)throw Error('Deletion control destination changed');for(const revision of record.revisions)deleted.add(revisionKey(revision));}
  inventory.pending.forEach(validatePublicationIntent);
  const chosen=new Set(selection.revisions.map(revisionKey)),found=new Map<string,RevisionDescriptor>(),paths=new Map<string,ArtifactIdentity>(),audio=new Map<string,ArtifactIdentity>(),protectedAudio=new Set(inventory.pending.flatMap(intent=>intent.audio?[intent.audio.sha256]:[])),allPaths=new Set<string>();let metadataBytes=0;
  const add=(path:string,bytes:Uint8Array)=>{const artifact={path,bytes:bytes.length,sha256:sha256(bytes)};const old=paths.get(path);if(old&&old.sha256!==artifact.sha256)throw Error('Conflicting immutable deletion target');paths.set(path,artifact);};
  for(const raw of inventory.commits){
   signal?.throwIfAborted();const marker=validateCommit(raw),key=revisionKey(marker),commitPath=`commits/${marker.deviceId}/${marker.revisionId}.json`;
   if(allPaths.has(commitPath))throw Error('Duplicate remote commit identity');allPaths.add(commitPath);if(deleted.has(key))continue;
   const manifestBytes=await provider.read(marker.manifestPath,65536,signal);metadataBytes+=manifestBytes.length;
   const parsed=JSON.parse(Buffer.from(manifestBytes).toString('utf8'));
   if(parsed.kind==='heed-deleted-revision'){const fence=validateRevisionFence(parsed);if(fence.destinationId!==selection.destinationId||revisionKey(fence.revision)!==key||fence.artifact.sha256!==marker.manifestHash)throw Error('Invalid canonical deletion fence');deleted.add(key);continue;}
   const manifest=validateManifest(parsed);if(sha256(manifestBytes)!==marker.manifestHash)throw Error('Invalid remote manifest integrity');
   const payloadPath=`${revisionPath(marker.meetingId,marker.revisionId)}/meeting.json`,bytes=await provider.read(payloadPath,manifest.artifacts[0]!.bytes,signal);metadataBytes+=bytes.length;if(metadataBytes>64_000_000)throw Error('Remote deletion inventory exceeds the supported metadata limit');
   const payload=validateBundle(marker,manifest,bytes);
   if(!chosen.has(key)){if(payload.audio)protectedAudio.add(payload.audio.sha256);continue;}
   const descriptor={libraryId:manifest.libraryId,meetingId:manifest.meetingId,revisionId:manifest.revisionId,manifestHash:marker.manifestHash,parents:manifest.parents};const previous=found.get(key);if(previous&&sha256(encode(previous))!==sha256(encode(descriptor)))throw Error('Conflicting remote revision identity');found.set(key,descriptor);
   const commitBytes=await provider.read(commitPath,65536,signal);if(sha256(encode(validateCommit(JSON.parse(Buffer.from(commitBytes).toString()))))!==sha256(encode(marker)))throw Error('Remote commit changed');add(commitPath,commitBytes);add(payloadPath,bytes);add(marker.manifestPath,manifestBytes);
   if(payload.audio)audio.set(payload.audio.sha256,{path:payload.audio.objectPath,bytes:payload.audio.bytes,sha256:payload.audio.sha256});
  }
  if(selection.revisions.some(revision=>!found.has(revisionKey(revision))||deleted.has(revisionKey(revision))))throw Error('The selected remote revisions changed or were already deleted');
  let retainedBytes=0;for(const [hash,artifact] of audio){if(!provider.deletionCapabilities!.sharedAudioGC||protectedAudio.has(hash))retainedBytes+=artifact.bytes;else paths.set(artifact.path,artifact);}
  const rank=(path:string)=>path.startsWith('commits/')?0:path.endsWith('/meeting.json')?1:path.endsWith('/manifest.json')?2:3;
  const artifacts=[...paths.values()].sort((a,b)=>rank(a.path)-rank(b.path)||a.path.localeCompare(b.path));
  const record=validateDeletionRecord({version:1,jobId:id,destinationId:selection.destinationId,revisions:[...found.values()].sort((a,b)=>revisionKey(a).localeCompare(revisionKey(b))),artifacts});
  const normalize=(values:any[])=>values.map(value=>encode(value).toString()).sort();const digest=sha256(encode({commits:normalize(inventory.commits),deletions:normalize(inventory.deletions),pending:normalize(inventory.pending),artifacts}));return {binding:provider.deletionCapabilities!.connectionGeneration,digest,record,retainedBytes};
 }
 async preview(provider:LibraryProvider,tx:RemoteTransaction,selection:DeletionSelection,signal?:AbortSignal):Promise<DeletionPreview>{const id=randomUUID(),plan=await this.scan(provider,tx,selection,id,signal),view:DeletionPreview={token:id,expiresAt:new Date(this.now()+600000).toISOString(),selection:structuredClone(selection),versions:selection.revisions.length,eligibleBytes:plan.record.artifacts.reduce((sum,a)=>sum+a.bytes,0),retainedBytes:plan.retainedBytes,sharedAudioGC:provider.deletionCapabilities!.sharedAudioGC,confirmation:provider.deletionCapabilities!.confirmation};this.edit(next=>{for(const [key,item] of Object.entries(next.previews))if(Date.parse(item.view.expiresAt)<this.now())delete next.previews[key];next.previews[id]={view,plan};});return structuredClone(view);}
 async confirm(provider:LibraryProvider,tx:RemoteTransaction,token:string,confirmed:boolean,signal?:AbortSignal):Promise<DeletionJob>{
  let executing=false;
  try {
   if(confirmed!==true)throw Error('Confirm physical remote deletion explicitly');
   const old=this.state.jobs[token];if(old){this.bound(provider,old.view.selection,old.plan.binding);if(['pending-verification','pending-propagation'].includes(old.view.state)){await tx.checkpoint();return structuredClone(old.view);}executing=true;return await this.execute(provider,tx,token,signal);}
   const preview=this.state.previews[token];if(!preview||Date.parse(preview.view.expiresAt)<this.now())throw Error('Invalid or expired deletion preview');this.bound(provider,preview.view.selection,preview.plan.binding);const current=await this.scan(provider,tx,preview.view.selection,token,signal);if(current.digest!==preview.plan.digest)throw Error('The remote library changed; review a new deletion preview');
   this.edit(next=>{next.jobs[token]={view:{id:token,selection:preview.view.selection,state:'prepared',removed:0,total:current.record.artifacts.length,retainedBytes:current.retainedBytes},plan:current,completed:[],fences:[]};});executing=true;return await this.execute(provider,tx,token,signal);
  }catch(error){if(!executing)await tx.checkpoint();throw error;}
 }
 async retry(provider:LibraryProvider,tx:RemoteTransaction,id:string,signal?:AbortSignal){let executing=false;try{const job=this.state.jobs[id];if(!job)throw Error('Invalid deletion job');this.bound(provider,job.view.selection,job.plan.binding);if(job.view.state==='pending-verification'){await tx.checkpoint();return structuredClone(job.view);}if(job.view.state==='pending-propagation')this.edit(next=>{next.jobs[id]!.completed=[];next.jobs[id]!.fences=[];next.jobs[id]!.view.removed=0;});executing=true;return await this.execute(provider,tx,id,signal);}catch(error){if(!executing)await tx.checkpoint();throw error;}}
 /** One already-confirmed exact iCloud job per discovery; learned remote intents never create jobs. */
 async reconcile(provider:LibraryProvider,tx:RemoteTransaction,signal?:AbortSignal):Promise<DeletionJob|undefined>{
  const candidates=Object.values(this.state.jobs).filter(job=>job.view.state==='pending-propagation'&&job.view.selection.providerId===provider.id&&job.view.selection.destinationId===provider.deletionCapabilities?.destinationId&&job.plan.binding===provider.deletionCapabilities.connectionGeneration).sort((a,b)=>a.view.id.localeCompare(b.view.id));
  const selected=candidates.find(job=>job.view.id>(this.state.reconcileCursor||''))||candidates[0];if(!selected)return;
  this.edit(next=>{next.reconcileCursor=selected.view.id;});return this.retry(provider,tx,selected.view.id,signal);
 }
 private async execute(provider:LibraryProvider,tx:RemoteTransaction,id:string,signal?:AbortSignal):Promise<DeletionJob>{
  const job=this.state.jobs[id]!;this.bound(provider,job.view.selection,job.plan.binding);
  try{
   this.edit(next=>{next.jobs[id]!.view.state='deleting';delete next.jobs[id]!.view.error;});await tx.writeDeletion(job.plan.record,signal);this.options.onIntent?.(provider.id,job.plan.record);
   for(const artifact of job.plan.record.artifacts){
    signal?.throwIfAborted();if(this.state.jobs[id]!.completed.includes(artifact.path))continue;
    await tx.removeExact(id,artifact,signal);
    if(artifact.path.endsWith('/manifest.json')){const revision=job.plan.record.revisions.find(r=>artifact.path===`${revisionPath(r.meetingId,r.revisionId)}/manifest.json`)!;const fence:RevisionDeletionFence={kind:'heed-deleted-revision',version:1,jobId:id,destinationId:job.plan.record.destinationId,revision,artifact};await tx.writeFence(fence,signal);const bytes=await provider.read(artifact.path,65536,signal);const stored=validateRevisionFence(JSON.parse(Buffer.from(bytes).toString()));if(canonicalControl(stored)!==canonicalControl(fence)){if(provider.deletionCapabilities?.confirmation!=='pending-propagation'||!equivalentRevisionFence(stored,fence))throw Error('Canonical deletion fence changed');const inventory=await tx.inventory(signal),other=inventory.deletions.find(record=>record.jobId===stored.jobId);if(!inventory.complete||!other)throw Error('Equivalent deletion intent is unavailable');validateDeletionRecord(other);if(other.destinationId!==fence.destinationId||!other.revisions.some(item=>canonicalControl(item)===canonicalControl(fence.revision))||!other.artifacts.some(item=>canonicalControl(item)===canonicalControl(fence.artifact)))throw Error('Equivalent deletion intent changed');}}
    this.edit(next=>{const current=next.jobs[id]!;current.completed.push(artifact.path);if(artifact.path.endsWith('/manifest.json'))current.fences.push(artifact.path);current.view.removed=current.completed.length;});
   }
   this.edit(next=>{next.jobs[id]!.view.state=provider.deletionCapabilities!.confirmation==='pending-propagation'?'pending-propagation':'pending-verification';});await tx.checkpoint();return this.job(id);
  }catch(error){
   this.edit(next=>{const current=next.jobs[id]!;current.view.state='incomplete';current.view.error=signal?.aborted?'Deletion interrupted; retry this exact job after the meeting.':'Deletion incomplete; preserve this job and retry the same destination.';});
   if(this.state.jobs[id]!.fences.length===job.plan.record.revisions.length)await tx.checkpoint();return this.job(id);
  }
 }
}
