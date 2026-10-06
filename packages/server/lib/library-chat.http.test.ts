import {expect,test} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

test('real HTTP scoped chat isolates markers, pins label snapshots and persists separate contexts',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'heed-scoped-http-'));const prompts:any[]=[];let release:()=>void=()=>{};let held=false;
 const ollama=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){
  const path=new URL(request.url).pathname;if(path==='/api/tags')return Response.json({models:[{name:'synthetic:local'}]});
  const body=await request.json() as any;if(path==='/api/show')return Response.json({details:{family:'llama'},capabilities:['completion'],model_info:{'llama.context_length':8192}});
  if(!body.prompt)return Response.json({done:true});const input=JSON.parse(body.prompt);prompts.push(input);
  if(input.question==='Hold scope'){held=true;await new Promise<void>(resolve=>{release=resolve;});}
  return Response.json({response:JSON.stringify({claims:input.evidence.map((e:any)=>({text:e.quote,evidenceIds:[e.id]})),notFound:false}),done:true,done_reason:'stop'});
 }});
 const reserve=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response()});const port=reserve.port;await reserve.stop(true);const base=`http://127.0.0.1:${port}`;let app:Bun.Subprocess|undefined;
 const call=async(path:string,body?:unknown,extra:RequestInit={})=>{const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),...extra});const text=await response.text();let value:any;try{value=JSON.parse(text);}catch{value=text;}return {status:response.status,body:value};};
 const wait=async(check:()=>Promise<boolean>)=>{for(let i=0;i<250;i++){if(await check())return;await Bun.sleep(20);}throw new Error('Scoped HTTP condition timed out');};
 const start=async()=>{app=Bun.spawn([process.execPath,'run',join(import.meta.dir,'..','server.ts')],{cwd:join(import.meta.dir,'..','..','..'),env:{...process.env,HEED_MODEL:'',HEED_APP_DIR:directory,HEED_RECORDINGS_DIR:join(directory,'recordings'),PORT:String(port),OLLAMA_HOST:`http://127.0.0.1:${ollama.port}`},stdout:'ignore',stderr:'ignore'});await wait(async()=>{try{return (await call('/api/sessions')).status===200;}catch{return false;}});};
 const stop=async()=>{if(app){app.kill('SIGTERM');await app.exited;app=undefined;}};
 const scope=(labels:string[],match='any')=>({mode:'labels',labels,match});const broad={mode:'all',labels:[],match:'any'};
 const context=async(selection:any)=>(await call('/api/library-chat/context',{scope:selection}));
 const send=async(selection:any,id:string,question='Who mentioned Rails?')=>{const current=await context(selection);return call('/api/library-chat/command',{scope:selection,command:{action:'send',requestId:id,model:'synthetic:local',question,expectedSourceRevision:current.body.preview.snapshot.key,expectedThreadRevision:current.body.thread.revision}});};
 const complete=async(selection:any)=>{await wait(async()=>(await context(selection)).body.thread.turns.at(-1)?.status==='completed');return (await context(selection)).body;};
 try{
  await start();const create=async(id:string,tags:string[],text:string)=>(await call('/api/sessions',{id,title:id,tags,transcriptFinalized:true,language:'pt',transcript:text,segments:[{speaker:'Ana',text,start:1,end:3}],speakers:['Ana']})).body;
  const interview=await create('interview',['Entrevistas'],'INTERVIEW_ALLOWED Rails experiência.');await create('both',['Entrevistas','Client'],'BOTH_ALLOWED Rails experiência.');await create('planning',['Client'],'PLANNING_SECRET Rails experiência.');await create('unlabelled',[],'UNLABELLED_SECRET Rails experiência.');
  expect((await context(scope([]))).status).toBe(200);expect((await context(scope([]))).body.preview.ready).toBe(false);expect((await send(scope([]),'empty')).status).toBe(409);
  const any=await context(scope(['Entrevistas','Client']));expect(any.body.preview.snapshot.sources.map((s:any)=>s.sessionId)).toEqual(['both','interview','planning']);expect((await context(scope(['Entrevistas','Client'],'all'))).body.preview.snapshot.sources.map((s:any)=>s.sessionId)).toEqual(['both']);
  expect((await context(scope(['Missing']))).body.preview.snapshot.sources).toEqual([]);expect((await send(scope(['Missing']),'missing')).status).toBe(409);
  expect((await call('/api/library-chat/context',{scope:broad},{headers:{origin:'https://foreign.example'}})).status).toBe(403);expect((await call('/api/library-chat/command',{scope:broad,command:{}},{headers:{origin:'https://foreign.example'}})).status).toBe(403);
  expect((await send(broad,'broad')).status).toBe(200);const broader=await complete(broad);expect(JSON.stringify(broader.thread.turns[0].answer)).toContain('PLANNING_SECRET');
  const initial=prompts.length;expect((await send(scope(['Entrevistas']),'narrow')).status).toBe(200);const narrow=await complete(scope(['Entrevistas']));
  for(const input of prompts.slice(initial)){expect(JSON.stringify(input)).not.toContain('PLANNING_SECRET');expect(JSON.stringify(input)).not.toContain('UNLABELLED_SECRET');expect(input.history).toEqual([]);}expect(narrow.thread.turns).toHaveLength(1);expect(narrow.thread.turns[0].answer.claims[0].citations[0]).toMatchObject({sessionId:'both',segmentIndex:0,start:1});
  await stop();await start();expect((await context(scope(['Entrevistas']))).body.thread.turns[0].answer).toEqual(narrow.thread.turns[0].answer);
  expect((await send(scope(['Entrevistas']),'held','Hold scope')).status).toBe(200);await wait(async()=>held);
  expect((await call('/api/sessions?id=interview',{tags:[],tagsRevision:interview.tagsRevision},{method:'PATCH'})).status).toBe(200);
  const changed=(await context(scope(['Entrevistas']))).body;expect(changed.thread.turns[0].stale).toBe(true);expect(changed.thread.turns[1]).toMatchObject({status:'failed',reason:'scope-changed'});release();
  expect((await call('/api/library-chat/command',{scope:scope(['Entrevistas']),command:{action:'retry',turnId:changed.thread.turns[1].id}})).status).toBe(409);
  expect((await call('/api/library-chat/command',{scope:scope(['Entrevistas']),command:{action:'clear',expectedThreadRevision:'old'}})).status).toBe(409);
  expect((await call('/api/library-chat/command',{scope:scope(['Entrevistas']),command:{action:'clear',expectedThreadRevision:changed.thread.revision}})).status).toBe(200);
  expect((await context(broad)).body.thread.turns).toHaveLength(1);
 }finally{release();await stop();await ollama.stop(true);rmSync(directory,{recursive:true,force:true});}
},20000);

test('real HTTP scoped chat serializes with individual chat and task generation',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'heed-scoped-schedule-'));let individual=0,library=0,tasks=0,active=0,peak=0;let releaseIndividual:()=>void=()=>{},releaseLibrary:()=>void=()=>{};
 const individualHold=new Promise<void>(resolve=>{releaseIndividual=resolve;}),libraryHold=new Promise<void>(resolve=>{releaseLibrary=resolve;});
 const model=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){const path=new URL(request.url).pathname;if(path==='/api/tags')return Response.json({models:[{name:'synthetic:local'}]});const body=await request.json() as any;if(path==='/api/show')return Response.json({details:{family:'llama'},capabilities:['completion'],model_info:{'llama.context_length':8192}});if(!body.prompt)return Response.json({done:true});const input=JSON.parse(body.prompt);active++;peak=Math.max(peak,active);try{if(input.segments){tasks++;return Response.json({response:'{"suggestions":[]}',done:true});}if(input.question==='Hold individual'){individual++;await individualHold;}if(input.question==='Across sources'){library++;await libraryHold;}return Response.json({response:JSON.stringify({claims:[{text:'Supported',evidenceIds:[input.evidence[0].id]}],notFound:false}),done:true,done_reason:'stop'});}finally{active--;}}});
 const reserve=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response()});const port=reserve.port;await reserve.stop(true);const base=`http://127.0.0.1:${port}`;
 const app=Bun.spawn([process.execPath,'run',join(import.meta.dir,'..','server.ts')],{cwd:join(import.meta.dir,'..','..','..'),env:{...process.env,HEED_APP_DIR:directory,HEED_RECORDINGS_DIR:join(directory,'recordings'),HEED_MODEL:'synthetic:local',PORT:String(port),OLLAMA_HOST:`http://127.0.0.1:${model.port}`},stdout:'ignore',stderr:'ignore'});
 const request=async(path:string,body?:unknown)=>{const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,body:await response.json() as any};};const wait=async(check:()=>Promise<boolean>)=>{for(let i=0;i<250;i++){if(await check())return;await Bun.sleep(20);}throw new Error('Scoped worker scheduling timed out');};const scope={mode:'labels',labels:['Entrevistas'],match:'any'};
 const context=async()=>(await request('/api/library-chat/context',{scope})).body;
 try{
  await wait(async()=>{try{return (await request('/api/sessions')).status===200;}catch{return false;}});
  const first=(await request('/api/sessions',{id:'first',title:'First',tags:['Entrevistas'],transcriptFinalized:true,transcript:'Ana will review the budget.',segments:[{speaker:'Ana',text:'Ana will review the budget.',start:0,end:2}]})).body;
  await request('/api/sessions/first/chat',{action:'send',requestId:'individual',question:'Hold individual',model:'synthetic:local',expectedSourceRevision:first.transcriptRevision});await wait(async()=>individual===1);
  const preview=await context();await request('/api/library-chat/command',{scope,command:{action:'send',requestId:'library',question:'Across sources',model:'synthetic:local',expectedSourceRevision:preview.preview.snapshot.key}});
  await Bun.sleep(1100);expect(library).toBe(0);expect(tasks).toBe(0);expect((await context()).thread.turns[0].status).toBe('waiting');releaseIndividual();await wait(async()=>library===1);
  const taskCount=tasks;await request('/api/sessions',{id:'excluded',title:'Other',tags:['Other'],transcriptFinalized:true,transcript:'Other source.',segments:[{speaker:'Ana',text:'Other source.',start:0,end:1}]});
  await request('/api/sessions/first/chat',{action:'send',requestId:'second',question:'Follow up',model:'synthetic:local',expectedSourceRevision:first.transcriptRevision});
  expect((await request('/api/summarize',{transcript:'Manual request with enough source text.',templateId:'general'})).status).toBe(409);
  await Bun.sleep(1100);expect(tasks).toBe(taskCount);expect((await request('/api/sessions/first/chat')).body.turns[1].status).toBe('waiting');releaseLibrary();await wait(async()=>(await context()).thread.turns[0].status==='completed');await wait(async()=>(await request('/api/sessions/first/chat')).body.turns[1].status==='completed');expect(peak).toBe(1);
 }finally{releaseIndividual();releaseLibrary();app.kill('SIGTERM');await app.exited;await model.stop(true);rmSync(directory,{recursive:true,force:true});}
},20000);
