import {createHash,randomUUID} from 'node:crypto';
import {createReadStream,existsSync,mkdirSync,readFileSync,readdirSync,lstatSync,realpathSync,readSync,rmSync,writeFileSync,renameSync,openSync,fsyncSync,closeSync} from 'node:fs';
import {join,dirname,relative,isAbsolute,sep} from 'node:path';
import type {LibraryPreview,LibrarySnapshot,PortableCommit,PortableManifest,PortableMeeting,PublicationState,Session} from '@heed/shared';
import {atomicWriteJson} from './atomic-json';import {atomicWrite,SessionTags} from './session-tags';
import {encode,makeBundle,MAX_ARTIFACT_BYTES,portableMeeting,revisionPath,sha256,UUID,validateBundle,validateCommit,validateManifest} from './portable-schema';
import {providerPath,type LibraryProvider,type QuotaBudget} from './portable-provider';
interface Entry {providerId?:string;audioSource?:string;marker:PortableCommit;manifest:PortableManifest;preview:LibraryPreview;sessionId?:string;payloadHash?:string;commitIntent?:boolean;commitState?:PublicationState}
interface Catalog {version:1;libraryId:string;deviceId:string;aliases:Record<string,string>;heads:Record<string,string>;entries:Record<string,Entry>;complete:boolean;imported:number;skipped:number;error?:string}
interface Options {root:string;sessions:SessionTags;sessionsDir:string;quota:QuotaBudget;recordingsDir?:string;provider?:LibraryProvider;write?:typeof atomicWriteJson}
const entryKey=(m:PortableManifest|PortableCommit)=>`${m.libraryId}/${m.meetingId}/${m.revisionId}`;
const meetingKey=(m:PortableManifest|PortableCommit)=>`${m.libraryId}/${m.meetingId}`;
/** A complete SessionTags write is the only AI visibility boundary; remote previews never enter it. */
export class PortableLibrary {
 private state:Catalog;private statePath:string;private active=false;
 constructor(private options:Options){
  for(const category of ['catalog','media','indexes','staging'])mkdirSync(join(options.root,category),{recursive:true,mode:0o700});
  this.statePath=join(options.root,'catalog','state.json');
  this.state=existsSync(this.statePath)?JSON.parse(readFileSync(this.statePath,'utf8')):{version:1,libraryId:randomUUID(),deviceId:randomUUID(),aliases:{},heads:{},entries:{},complete:true,imported:0,skipped:0};
  if(this.state.version!==1||!UUID.test(this.state.libraryId)||!UUID.test(this.state.deviceId)||!this.state.aliases||!this.state.heads||!this.state.entries)throw new Error('Invalid private library catalog; preserve it for recovery');
  for(const entry of Object.values(this.state.entries)){validateCommit(entry.marker);validateManifest(entry.manifest);}
  if(!existsSync(this.statePath))this.persist(this.state);
  for(const entry of Object.values(this.state.entries).filter(e=>e.commitIntent&&e.sessionId)){
   const session=options.sessions.read(entry.sessionId!);if(!session)continue;const payload=this.payload(entry);const matches=sha256(encode(portableMeeting(session,entry.manifest.meetingId,payload.audio)))===entry.payloadHash;
   this.edit(next=>{const item=next.entries[entryKey(entry.manifest)]!;item.preview.state=matches?(item.commitState||'verified'):'conflict';item.preview.local=true;delete item.commitIntent;delete item.commitState;next.heads[meetingKey(entry.manifest)]=entry.manifest.revisionId;});
  }
  // Previous process jobs cannot be running; discard only our bounded staging directories and claims.
  for(const name of readdirSync(join(options.root,'staging'))){if(!UUID.test(name))continue;const path=join(options.root,'staging',name);if(!lstatSync(path).isDirectory())continue;rmSync(path,{recursive:true});options.quota.release(`library-${name}`);}
 }
 private persist(next:Catalog){(this.options.write||atomicWriteJson)(this.statePath,next);this.state=next;}
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
  for await(const chunk of createReadStream(source)){signal?.throwIfAborted();bytes+=chunk.length;if(bytes>stat.size)throw new Error('Audio changed during integrity verification');hash.update(chunk);}const after=lstatSync(source);if(bytes!==stat.size||after.size!==stat.size||after.mtimeMs!==stat.mtimeMs||after.ino!==stat.ino)throw new Error('Audio changed during integrity verification');return {bytes,hash:hash.digest('hex')};
 }
 private async operation<T>(run:()=>Promise<T>,signal?:AbortSignal):Promise<T>{signal?.throwIfAborted();if(this.active)throw new Error('A library operation is already running');this.active=true;try{return await run();}finally{this.active=false;}}
 selectProvider(provider?:LibraryProvider):void{if(this.active)throw new Error('A library operation is already running');this.options.provider=provider;}
 private provider():LibraryProvider {if(!this.options.provider)throw new Error('No remote library provider is configured');return this.options.provider;}
 snapshot():LibrarySnapshot {const previews=Object.values(this.state.entries).map(entry=>({...entry.preview,local:!!entry.sessionId&&!!this.options.sessions.read(entry.sessionId)}));return {localMeetings:this.options.sessions.snapshot().sessions.filter(s=>s.transcriptFinalized===true).map(s=>({id:s.id,title:s.title})),configured:!!this.options.provider,providerName:this.options.provider?.name,previews:previews.sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt)||a.meetingId.localeCompare(b.meetingId)||a.revisionId.localeCompare(b.revisionId)),imported:this.state.imported,skipped:this.state.skipped,pending:previews.filter(p=>!p.local||['pending','uploading','unavailable'].includes(p.state)).length,complete:this.state.complete,error:this.state.error};}
 async discover(signal?:AbortSignal):Promise<LibrarySnapshot>{return this.operation(async()=>{
  const provider=this.provider();let cursor:string|null=null;const seen=new Set<string>();let complete=true,count=0;const discovered:Entry[]=[];const revisions=new Map(Object.entries(this.state.entries));
  try {for(let page=0;page<100;page++){
   signal?.throwIfAborted();const result=await provider.list(cursor,100,signal);if(!Array.isArray(result.commits)||result.commits.length>100||typeof result.complete!=='boolean'||(result.next!==null&&typeof result.next!=='string'))throw new Error('Invalid provider discovery page');complete=complete&&result.complete;
   for(const raw of result.commits){if(++count>10000)throw new Error('Library discovery limit reached; select a smaller collection');const marker=validateCommit(raw);const manifestBytes=await provider.read(providerPath(marker.manifestPath),65536,signal);if(manifestBytes.length>65536)throw new Error('Provider exceeded metadata read limit');const manifest=validateManifest(JSON.parse(Buffer.from(manifestBytes).toString('utf8')));
    if(marker.manifestHash!==sha256(encode(manifest))||marker.libraryId!==manifest.libraryId||marker.meetingId!==manifest.meetingId||marker.revisionId!==manifest.revisionId)throw new Error('Invalid committed manifest');
    // Preview metadata is verified transcript content, but remains outside the authoritative session store.
    const bytes=await provider.read(providerPath(`${revisionPath(manifest.meetingId,manifest.revisionId)}/meeting.json`),manifest.artifacts[0]!.bytes,signal);const payload=validateBundle(marker,manifest,bytes);const old=revisions.get(entryKey(manifest));if(!old&&revisions.size>=10000)throw new Error('Private library catalog limit reached');if(old&&old.marker.manifestHash!==marker.manifestHash)throw new Error('Immutable remote revision changed');
    const entry=old||{providerId:provider.id,marker,manifest,preview:{libraryId:manifest.libraryId,meetingId:manifest.meetingId,revisionId:manifest.revisionId,title:payload.title,createdAt:payload.createdAt,bytes:bytes.length,local:false,state:'pending',audio:!!payload.audio}} as Entry;revisions.set(entryKey(manifest),entry);discovered.push(entry);
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
 async importSelected(revisionIds?:string[],signal?:AbortSignal):Promise<LibrarySnapshot>{return this.operation(async()=>{
  const provider=this.provider();let imported=0,skipped=0;
  const entries=Object.values(this.state.entries).filter(e=>(!e.providerId||e.providerId===provider.id)&&(!revisionIds||revisionIds.includes(e.manifest.revisionId))).sort((a,b)=>Date.parse(b.preview.createdAt)-Date.parse(a.preview.createdAt)||a.manifest.meetingId.localeCompare(b.manifest.meetingId)||a.manifest.revisionId.localeCompare(b.manifest.revisionId));
  for(const entry of entries){signal?.throwIfAborted();if(entry.sessionId&&this.options.sessions.read(entry.sessionId))continue;let job:ReturnType<PortableLibrary['quotaJob']>|undefined;
   try {const estimate=this.sessionFor(entry,{...({} as PortableMeeting),meetingId:entry.manifest.meetingId});job=this.quotaJob(entry,estimate);
    const bytes=await provider.read(providerPath(`${revisionPath(entry.manifest.meetingId,entry.manifest.revisionId)}/meeting.json`),entry.manifest.artifacts[0]!.bytes,signal);signal?.throwIfAborted();const payload=validateBundle(entry.marker,entry.manifest,bytes);atomicWrite(join(job.path,'meeting.json'),Buffer.from(bytes).toString('utf8'));this.saveArtifacts(entry,payload);
    const key=meetingKey(entry.manifest),head=this.state.heads[key],previous=head?this.state.entries[`${key}/${head}`]:undefined;const current=previous?.sessionId?this.options.sessions.read(previous.sessionId):null;
    const changed=!!current&&sha256(encode(portableMeeting(current,entry.manifest.meetingId,this.payload(previous!).audio)))!==previous!.payloadHash;
    if(previous&&current&&!changed&&this.descends(previous,entry.manifest.revisionId)){this.edit(next=>{const item=next.entries[entryKey(entry.manifest)]!;item.preview.state='verified';item.sessionId=current.id;item.payloadHash=sha256(bytes);});continue;}
    if(previous&&current&&(changed||!this.descends(entry,head!))){this.edit(next=>{const item=next.entries[entryKey(entry.manifest)]!;item.preview.state='conflict';item.payloadHash=sha256(bytes);});skipped++;continue;}
    const session=this.sessionFor(entry,payload);if(current?.files?.wav&&(!payload.audio||this.payload(previous!).audio?.sha256===payload.audio.sha256))session.files=current.files;this.edit(next=>{const item=next.entries[entryKey(entry.manifest)]!;item.sessionId=session.id;item.payloadHash=sha256(bytes);item.commitIntent=true;next.aliases[key]=session.id;});
    this.options.sessions.save(session);
    this.edit(next=>{const item=next.entries[entryKey(entry.manifest)]!;item.sessionId=session.id;item.payloadHash=sha256(bytes);item.preview.local=true;item.preview.state='verified';delete item.preview.error;delete item.commitIntent;next.aliases[key]=session.id;next.heads[key]=entry.manifest.revisionId;});imported++;
   }catch(error){if(signal?.aborted)throw error;skipped++;this.edit(next=>{const item=next.entries[entryKey(entry.manifest)]!;item.preview.state='unavailable';item.preview.error=error instanceof Error?error.message:'Import unavailable';});}
   finally{job?.finish();}
  }
  this.edit(next=>{next.imported=imported;next.skipped=skipped;});return this.snapshot();
 },signal);}
 async queueLocal(sessionId:string,signal?:AbortSignal):Promise<LibraryPreview>{return this.operation(()=>this.queueLocalRecord(sessionId,signal),signal);}
 private async queueLocalRecord(sessionId:string,signal?:AbortSignal):Promise<LibraryPreview> {
  const session=this.options.sessions.read(sessionId);if(!session)throw new Error('Meeting not found');
  const existingKey=Object.keys(this.state.aliases).find(key=>this.state.aliases[key]===sessionId);const libraryId=existingKey?.split('/')[0]||this.state.libraryId,meetingId=existingKey?.split('/')[1]||randomUUID(),key=`${libraryId}/${meetingId}`;const head=this.state.heads[key],previous=head?this.state.entries[`${key}/${head}`]:undefined;
  let audio=previous?this.payload(previous).audio:undefined,audioSource=previous?.audioSource;
  if(session.files?.wav){audioSource=session.files.wav;this.safeAudioSource(audioSource);const inspected=await this.inspectAudio(audioSource,signal);if(inspected.bytes<12)throw new Error('Invalid local WAV');const header=Buffer.alloc(12),fd=openSync(audioSource,'r');try{readSync(fd,header,0,12,0);}finally{closeSync(fd);}if(!['RIFF','RF64'].includes(header.toString('ascii',0,4))||header.toString('ascii',8,12)!=='WAVE')throw new Error('Invalid local WAV');audio={sha256:inspected.hash,bytes:inspected.bytes,format:'wav',mode:'archived',objectPath:`objects/${inspected.hash}`};}
  const current=this.options.sessions.read(sessionId);if(!current||JSON.stringify(portableMeeting(current,meetingId))!==JSON.stringify(portableMeeting(session,meetingId)))throw new Error('Local meeting changed during publication preparation; retry');
  const payload=portableMeeting(session,meetingId,audio),hash=sha256(encode(payload));if(previous?.payloadHash===hash){if(audioSource&&previous.audioSource!==audioSource)this.edit(next=>{next.entries[entryKey(previous.manifest)]!.audioSource=audioSource;});return previous.preview;}
  const bundle=makeBundle(libraryId,this.state.deviceId,payload,head?[head]:[]);const entry:Entry={marker:bundle.marker,manifest:bundle.manifest,payloadHash:hash,sessionId,audioSource,preview:{libraryId,meetingId,revisionId:bundle.manifest.revisionId,title:session.title,createdAt:session.createdAt,bytes:encode(payload).length,local:true,state:'pending',audio:!!payload.audio}};
  const job=this.quotaJob(entry,session);try{this.saveArtifacts(entry,payload);this.edit(next=>{next.entries[entryKey(entry.manifest)]=entry;next.aliases[key]=sessionId;next.heads[key]=entry.manifest.revisionId;});return entry.preview;}finally{job.finish();}
 }
 async resolveConflict(revisionId:string,signal?:AbortSignal):Promise<LibraryPreview>{return this.operation(async()=>{
  const selected=Object.values(this.state.entries).find(e=>e.manifest.revisionId===revisionId);if(!selected||selected.preview.state!=='conflict')throw new Error('Conflict revision not found');
  const key=meetingKey(selected.manifest),oldHead=this.state.heads[key],old=oldHead?this.state.entries[`${key}/${oldHead}`]:undefined;if(!old?.sessionId)throw new Error('Current local meeting not found');
  await this.queueLocalRecord(old.sessionId,signal);const head=this.state.heads[key],previous=head?this.state.entries[`${key}/${head}`]:undefined;if(!previous?.sessionId)throw new Error('Current local meeting not found');
  const payload=this.payload(selected),session={...this.sessionFor(selected,payload),id:previous.sessionId};const parents=[...new Set([head!,...Object.values(this.state.entries).filter(e=>meetingKey(e.manifest)===key&&e.preview.state==='conflict').map(e=>e.manifest.revisionId)])];
  const bundle=makeBundle(selected.manifest.libraryId,this.state.deviceId,payload,parents);const entry:Entry={marker:bundle.marker,manifest:bundle.manifest,sessionId:session.id,payloadHash:sha256(encode(payload)),commitIntent:true,commitState:'pending',preview:{...selected.preview,revisionId:bundle.manifest.revisionId,local:true,state:'pending'}};
  const job=this.quotaJob(entry,session);try{this.saveArtifacts(entry,payload);this.edit(next=>{next.entries[entryKey(entry.manifest)]=entry;});this.options.sessions.save(session);this.edit(next=>{delete next.entries[entryKey(entry.manifest)]!.commitIntent;delete next.entries[entryKey(entry.manifest)]!.commitState;next.heads[key]=entry.manifest.revisionId;for(const id of parents){const old=next.entries[`${key}/${id}`];if(old?.preview.state==='conflict')old.preview.state='verified';}});return entry.preview;}finally{job.finish();}
 },signal);}
 async publish(revisionId:string,signal?:AbortSignal):Promise<LibrarySnapshot>{return this.operation(async()=>{
  const provider=this.provider();const entry=Object.values(this.state.entries).find(e=>e.manifest.revisionId===revisionId);if(!entry?.sessionId)throw new Error('Local revision not found');const payload=this.payload(entry);
  this.edit(next=>{next.entries[entryKey(entry.manifest)]!.preview.state='uploading';});
  try {if(payload.audio){const path=this.safeAudioSource(entry.audioSource||join(this.options.root,'media',`${payload.audio.sha256}.wav`));if(!existsSync(path)||lstatSync(path).size!==payload.audio.bytes)throw new Error('Archived audio unavailable locally');await provider.writeObjectImmutable(providerPath(payload.audio.objectPath),payload.audio.bytes,payload.audio.sha256,createReadStream(path),signal);}
   const prefix=revisionPath(entry.manifest.meetingId,entry.manifest.revisionId);await provider.writeImmutable(providerPath(`${prefix}/meeting.json`),encode(payload),signal);await provider.writeImmutable(providerPath(`${prefix}/manifest.json`),encode(entry.manifest),signal);await provider.writeImmutable(providerPath(`commits/${entry.marker.deviceId}/${entry.marker.revisionId}.json`),encode(entry.marker),signal);
   const confirmation=await provider.confirm(entry.marker,signal);this.edit(next=>{next.entries[entryKey(entry.manifest)]!.preview.state=confirmation==='remote-confirmed'?'provider-confirmed':'pending';});
   if(confirmation==='remote-confirmed'){const manifest=JSON.parse(Buffer.from(await provider.read(entry.marker.manifestPath,65536,signal)).toString('utf8'));validateBundle(entry.marker,manifest,await provider.read(`${prefix}/meeting.json`,MAX_ARTIFACT_BYTES,signal));this.edit(next=>{next.entries[entryKey(entry.manifest)]!.preview.state='verified';});}
  }catch(error){this.edit(next=>{next.entries[entryKey(entry.manifest)]!.preview.state='unavailable';next.entries[entryKey(entry.manifest)]!.preview.error=error instanceof Error?error.message:'Publication unavailable';});if(signal?.aborted)throw error;}
  return this.snapshot();
 },signal);}
 async requestAudio(sessionId:string,signal?:AbortSignal):Promise<string>{return this.operation(async()=>{
  const key=Object.keys(this.state.aliases).find(key=>this.state.aliases[key]===sessionId),head=key&&this.state.heads[key],entry=key&&head&&this.state.entries[`${key}/${head}`];if(!entry)throw new Error('No archived audio reference');const payload=this.payload(entry),audio=payload.audio;if(!audio)throw new Error('No archived audio reference');const path=join(this.options.root,'media',`${audio.sha256}.wav`);
  const apply=()=>{const session=this.options.sessions.read(sessionId);if(!session)throw new Error('Meeting not found');this.options.sessions.save({...session,files:{...session.files,wav:path}});return path;};
  if(existsSync(path)){const inspected=await this.inspectAudio(path,signal);if(inspected.bytes===audio.bytes&&inspected.hash===audio.sha256)return apply();throw new Error('Cached audio integrity verification failed');}
  const provider=this.provider(),job=randomUUID(),id=`library-${job}`,staging=join(this.options.root,'staging',job);this.options.quota.reserve(id,audio.bytes*2+4*encode(this.state).length+131072,[staging,path,join(this.options.sessionsDir,`${sessionId}.json`)]);
  try{mkdirSync(staging,{recursive:true,mode:0o700});const file=join(staging,'verified.wav'),fd=openSync(file,'wx',0o600),hash=createHash('sha256');let received=0;
   try{for await(const chunk of provider.stream(providerPath(audio.objectPath),audio.bytes,signal)){signal?.throwIfAborted();received+=chunk.length;if(received>audio.bytes)throw new Error('Audio transfer exceeded declared size');hash.update(chunk);writeFileSync(fd,chunk);}if(received!==audio.bytes||hash.digest('hex')!==audio.sha256)throw new Error('Audio integrity verification failed');fsyncSync(fd);}finally{closeSync(fd);}
   renameSync(file,path);const dir=openSync(dirname(path),'r');try{fsyncSync(dir);}finally{closeSync(dir);}return apply();
  }finally{rmSync(staging,{recursive:true,force:true});this.options.quota.release(id);}
 },signal);}
 protectedPaths(revisionIds?:string[]):string[]{const requested=new Set(revisionIds);return Object.values(this.state.entries).filter(e=>e.preview.state!=='verified'||requested.has(e.manifest.revisionId)).flatMap(e=>{try{const audio=this.payload(e).audio;return audio?[join(this.options.root,'media',`${audio.sha256}.wav`),...(e.audioSource?[e.audioSource]:[])]:[];}catch{return [];}});}
}
