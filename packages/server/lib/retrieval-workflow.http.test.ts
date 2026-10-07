import {expect,test} from 'bun:test';
import {randomUUID} from 'node:crypto';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Session} from '@heed/shared';
import {encode,makeBundle,portableMeeting,revisionPath,sha256} from './portable-schema';

const selected={mode:'labels',labels:['Work'],match:'any'};
const providerId='synthetic-local';
const syntheticWav=()=>{
 const bytes=Buffer.alloc(48);bytes.write('RIFF');bytes.writeUInt32LE(40,4);bytes.write('WAVE',8);bytes.write('fmt ',12);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(16000,24);bytes.writeUInt32LE(32000,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(4,40);return bytes;
};
async function fixture(){
 const root=mkdtempSync(join(tmpdir(),'heed-retrieval-workflow-')),remote=join(root,'synthetic-provider'),appRoot=join(root,'app'),prompts:any[]=[];
 mkdirSync(join(remote,'commits'),{recursive:true});mkdirSync(appRoot);let app:Bun.Subprocess|undefined,holding=false,held=false,release:()=>void=()=>{};
 const model=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){
  const path=new URL(request.url).pathname;if(path==='/api/tags')return Response.json({models:[{name:'fixture:local'}]});const body=await request.json() as any;
  if(path==='/api/show')return Response.json({details:{family:'llama'},capabilities:['completion'],model_info:{'llama.context_length':8192}});
  if(!body.prompt)return Response.json({done:true});const input=JSON.parse(body.prompt);prompts.push(input);
  if(holding){held=true;await new Promise<void>(resolve=>release=resolve);holding=false;}
  return Response.json({response:JSON.stringify({claims:[{text:'Synthetic supported statement.',evidenceIds:[input.evidence[0].id]}],notFound:false}),done:true,done_reason:'stop'});
 }});
 const reserve=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response()}),port=reserve.port;await reserve.stop(true);const base=`http://127.0.0.1:${port}`;
 // The adapter supplies only synthetic local files. All HTTP routes, portable
 // validation/import, source writes, SQLite retrieval and generation guards are production code.
 const wrapper=join(root,'server-with-synthetic-provider.ts');
 writeFileSync(wrapper,`import {readFileSync,readdirSync} from 'node:fs';import {join} from 'node:path';
 const root=${JSON.stringify(remote)};const server=await import(${JSON.stringify(join(import.meta.dir,'../server.ts'))});
 server.getPortableLibrary().selectProvider({id:${JSON.stringify(providerId)},name:'Synthetic local fixture',transport:'os-managed-folder',readOnly:true,
 async list(cursor,limit,signal){signal?.throwIfAborted();if(cursor!==null)throw Error('Unexpected fixture cursor');const commits=readdirSync(join(root,'commits')).sort().map(name=>JSON.parse(readFileSync(join(root,'commits',name),'utf8')));if(commits.length>limit)throw Error('Fixture page limit');return {commits,next:null,complete:true};},
 async read(path,maxBytes,signal){signal?.throwIfAborted();const bytes=readFileSync(join(root,path));if(bytes.length>maxBytes)throw Error('Fixture read limit');return bytes;},
 async *stream(path,maxBytes,signal){signal?.throwIfAborted();const bytes=readFileSync(join(root,path));if(bytes.length>maxBytes)throw Error('Fixture stream limit');yield bytes;},
 async writeObjectImmutable(){throw Error('Read-only fixture');},async writeImmutable(){throw Error('Read-only fixture');},async confirm(){return 'local-only';}});
 `);
 const call=async(path:string,body?:unknown,method=body===undefined?'GET':'POST')=>{const response=await fetch(base+path,{method,headers:{origin:base,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,body:await response.json() as any};};
 const wait=async(check:()=>Promise<boolean>|boolean)=>{for(let i=0;i<500;i++){if(await check())return;await Bun.sleep(10);}throw Error('Synthetic retrieval workflow timed out');};
 const start=async()=>{
  app=Bun.spawn([process.execPath,wrapper],{cwd:join(import.meta.dir,'../../..'),env:{...process.env,HEED_APP_DIR:appRoot,HEED_RECORDINGS_DIR:join(appRoot,'recordings'),HEED_MODEL:'',PORT:String(port),HEED_API_PORT:String(port),HEED_UI_PORT:'48101',HEED_TRANSCRIPTION_PORT:'48102',HEED_TRANSCRIPTION_URL:base,VITE_API_BASE:base,OLLAMA_HOST:`http://127.0.0.1:${model.port}`},stdout:'ignore',stderr:'ignore'});
  await wait(async()=>{try{return (await call('/api/library')).body.providerId===providerId;}catch{return false;}});
 };
 const stop=async(signal:'SIGTERM'|'SIGKILL'='SIGTERM')=>{if(app){app.kill(signal);await app.exited;app=undefined;}};
 const library=async(action:string,extra:Record<string,unknown>={})=>call('/api/library',{action,expectedProviderId:providerId,...extra});
 const source=async(id:string)=>{const response=await call('/api/sessions');return response.body.find((session:Session)=>session.id===id) as Session;};
 const completed=async(id:string,index:number)=>{await wait(async()=>(await call(`/api/sessions/${id}/chat`)).body.turns[index]?.status==='completed');return (await call(`/api/sessions/${id}/chat`)).body.turns[index];};
 return {root,appRoot,remote,prompts,call,wait,start,stop,library,source,completed,hold:()=>{holding=true;held=false;},held:()=>held,release:()=>release(),close:async()=>{release();await stop();await model.stop(true);rmSync(root,{recursive:true,force:true});}};
}
function publishFixture(remote:string,session:Session,meetingId:string,libraryId:string,deviceId:string,parents:string[],audio:ReturnType<typeof portableMeeting>['audio']){
 const bundle=makeBundle(libraryId,deviceId,portableMeeting(session,meetingId,audio),parents),path=join(remote,revisionPath(meetingId,bundle.manifest.revisionId));mkdirSync(path,{recursive:true});writeFileSync(join(path,'meeting.json'),encode(bundle.payload));writeFileSync(join(path,'manifest.json'),encode(bundle.manifest));writeFileSync(join(remote,'commits',bundle.manifest.revisionId+'.json'),encode(bundle.marker));return bundle;
}
test('real HTTP portable replacement during held chat rejects version-only and changed-source output, retains WAV and survives restart',async()=>{
 const f=await fixture();try{
  const meetingId=randomUUID(),libraryId=randomUUID(),deviceId=randomUUID(),wav=syntheticWav(),hash=sha256(wav),audio={sha256:hash,bytes:wav.length,format:'wav' as const,mode:'archived' as const,objectPath:`objects/${hash}`};mkdirSync(join(f.remote,'objects'));writeFileSync(join(f.remote,audio.objectPath),wav);
  const initial:Session={id:meetingId,title:'Synthetic imported meeting',createdAt:'2026-10-06T12:00:00.000Z',duration:4,language:'en',transcript:'Delivery confirmed.',segments:[{speaker:'Ana',text:'Delivery confirmed.',start:1,end:4}],speakers:['Ana'],tags:['Work'],aiNotes:'',summary:'',pinned:false,transcriptFinalized:true};
  let bundle=publishFixture(f.remote,initial,meetingId,libraryId,deviceId,[],audio);await f.start();expect((await f.library('refresh')).status).toBe(200);expect((await f.library('import',{revisionIds:[bundle.manifest.revisionId]})).body.imported).toBe(1);
  expect((await f.library('audio',{sessionId:meetingId})).status).toBe(200);let current=await f.source(meetingId);const media=current.files!.wav!;expect(readFileSync(media)).toEqual(wav);await f.wait(()=>existsSync(join(f.appRoot,'library/indexes/retrieval/active.json')));
  f.hold();expect((await f.call(`/api/sessions/${meetingId}/chat`,{action:'send',requestId:'held-version',question:'Delivery?',model:'fixture:local',expectedSourceRevision:current.transcriptRevision})).status).toBe(200);await f.wait(f.held);
  const originalHash=current.transcriptRevision,originalVersion=current.transcriptVersion!;
  const sameText={...current,transcriptEditing:{schemaVersion:1 as const,activeGenerationId:'remote-recognition',generations:[{id:'remote-recognition',createdAt:'2026-10-06T13:00:00.000Z',origin:'recognition' as const,transcript:current.transcript,segments:current.segments,speakers:current.speakers,language:current.language,duration:current.duration}],edits:[],candidates:[],candidateRequestReceipts:[]}};
  bundle=publishFixture(f.remote,sameText,meetingId,libraryId,deviceId,[bundle.manifest.revisionId],audio);expect((await f.library('refresh')).status).toBe(200);expect((await f.library('import',{revisionIds:[bundle.manifest.revisionId]})).body.imported).toBe(1);current=await f.source(meetingId);expect(current.transcriptRevision).toBe(originalHash);expect(current.transcriptVersion).toBeGreaterThan(originalVersion);f.release();await f.wait(async()=>(await f.call(`/api/sessions/${meetingId}/chat`)).body.turns[0]?.status==='failed');expect((await f.call(`/api/sessions/${meetingId}/chat`)).body.turns[0]).toMatchObject({reason:'source-changed',stale:true});
  const before=await f.call('/api/library-chat/context',{scope:selected});f.hold();expect((await f.call('/api/library-chat/command',{scope:selected,command:{action:'send',requestId:'held-import',question:'Delivery?',model:'fixture:local',expectedSourceRevision:before.body.preview.snapshot.key}})).status).toBe(200);await f.wait(f.held);
  const text='Delivery rejected pending evidence.',segments=current.segments.map(segment=>({...segment,text})),replacement={...current,transcript:text,segments,transcriptEditing:{...current.transcriptEditing!,activeGenerationId:'remote-replacement',generations:[...current.transcriptEditing!.generations,{id:'remote-replacement',createdAt:'2026-10-06T14:00:00.000Z',origin:'recognition' as const,transcript:text,segments,speakers:current.speakers,language:current.language,duration:current.duration}]}};
  bundle=publishFixture(f.remote,replacement,meetingId,libraryId,deviceId,[bundle.manifest.revisionId],audio);expect((await f.library('refresh')).status).toBe(200);expect((await f.library('import',{revisionIds:[bundle.manifest.revisionId]})).body.imported).toBe(1);f.release();await f.wait(async()=>(await f.call('/api/library-chat/context',{scope:selected})).body.thread.turns[0]?.status==='failed');const stale=(await f.call('/api/library-chat/context',{scope:selected})).body.thread.turns[0];expect(stale).toMatchObject({reason:'scope-changed',stale:true});expect(stale.answer).toBeUndefined();current=await f.source(meetingId);expect(current.transcript).toBe(text);expect(current.files?.wav).toBe(media);expect(readFileSync(media)).toEqual(wav);
  expect((await f.call(`/api/sessions/${meetingId}/chat`,{action:'send',requestId:'current',question:'Delivery?',model:'fixture:local',expectedSourceRevision:current.transcriptRevision})).status).toBe(200);const answer=(await f.completed(meetingId,1)).answer;expect(answer.claims[0].citations[0]).toMatchObject({sessionId:meetingId,sourceRevision:current.transcriptRevision,quote:text,start:1,end:4});
  await f.stop();await f.start();await f.wait(async()=>(await f.call('/api/library-chat/context',{scope:selected})).status===200);expect((await f.call(`/api/sessions/${meetingId}/chat`)).body.turns[1].answer).toEqual(answer);expect(readFileSync(media)).toEqual(wav);expect((await f.call('/api/storage')).body.reservedBytes).toBe(0);
 }finally{await f.close();}
},20000);
test('production restart discards a real unpublished indexing transaction, quota failure uses current fallback and accepted bytes stay intact',async()=>{
 const f=await fixture();try{
  const id='interrupted-source',transcript=Array.from({length:20000},(_,i)=>`Delivery synthetic paragraph ${i}.`).join('\n\n');mkdirSync(join(f.appRoot,'sessions'));writeFileSync(join(f.appRoot,'sessions',id+'.json'),encode({id,title:'Synthetic interrupted source',createdAt:'2026-10-06T12:00:00.000Z',duration:1,language:'en',transcript,segments:[],speakers:[],tags:['Work'],aiNotes:'',summary:'',pinned:false,transcriptFinalized:true}));await f.start();
  const directory=join(f.appRoot,'library/indexes/retrieval'),pointer=join(directory,'active.json');let stage='';
  await f.wait(()=>{stage=readdirSync(directory).find(name=>/^[a-f0-9-]{36}$/.test(name)&&existsSync(join(directory,name,'index.sqlite-journal')))??'';return !!stage&&!existsSync(pointer);});await f.stop('SIGKILL');expect(existsSync(pointer)).toBe(false);expect(existsSync(join(directory,stage))).toBe(true);
  const accepted=readFileSync(join(f.appRoot,'sessions',id+'.json')),ledger=JSON.parse(readFileSync(join(f.appRoot,'quota-reservations.json'),'utf8'));expect(Object.keys(ledger.reservations)).toContain('retrieval-rebuild-'+stage);
  // The real production rebuild cannot reserve its bounded database/journal
  // allowance under this supported 1MiB device quota. Accepted text fits.
  writeFileSync(join(f.appRoot,'config.json'),encode({storage_limit_bytes:1048576}));await f.start();expect(existsSync(join(directory,stage))).toBe(false);expect(readFileSync(join(f.appRoot,'sessions',id+'.json'))).toEqual(accepted);const current=await f.source(id);
  expect((await f.call(`/api/sessions/${id}/chat`,{action:'send',requestId:'fallback-after-crash',question:'Delivery?',model:'fixture:local',expectedSourceRevision:current.transcriptRevision})).status).toBe(200);const fallback=(await f.completed(id,0)).answer;expect(fallback.coverage).toMatchObject({complete:false,retrieval:{strategy:'fallback',selectedMeetings:1,searchedMeetings:1,searchedEvidence:256,lookupComplete:false}});expect(fallback.coverage.retrieval.partialReasons).toContain('fallback-limit');expect(fallback.claims[0].citations[0]).toMatchObject({sourceRevision:current.transcriptRevision,quote:'Delivery synthetic paragraph 0.'});
  await Bun.sleep(1100);expect(existsSync(pointer)).toBe(false);expect((await f.call('/api/storage')).body.reservedBytes).toBe(0);expect(readFileSync(join(f.appRoot,'sessions',id+'.json'))).toEqual(accepted);expect(readdirSync(directory)).toEqual([]);
  expect((await f.call(`/api/sessions/${id}/chat`,{action:'send',requestId:'fallback-after-quota',question:'Delivery?',model:'fixture:local',expectedSourceRevision:current.transcriptRevision})).status).toBe(200);const capacity=(await f.completed(id,1)).answer;expect(capacity.coverage.retrieval.partialReasons).toContain('index-capacity');expect(capacity.coverage.retrieval).toMatchObject({strategy:'fallback',indexedEvidence:0,searchedEvidence:256,lookupComplete:false});expect(capacity.claims[0].citations[0].sourceRevision).toBe(current.transcriptRevision);
 }finally{await f.close();}
},20000);
