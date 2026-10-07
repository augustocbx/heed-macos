import {expect,test} from 'bun:test';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

for (const scoped of [false,true]) test(`${scoped?'label-scoped':'meeting'} chat gets the next slot ahead of pending notes and task suggestions`,async()=>{
 const state=mkdtempSync(join(tmpdir(),'heed-ai-priority-'));
 writeFileSync(join(state,'config.json'),JSON.stringify({automatic_notes:{enabled:true,model:'synthetic:local',templateId:'general',language:'meeting'}}));
 let releaseTask!:()=>void,releaseChat!:()=>void;
 const taskHold=new Promise<void>(r=>releaseTask=r),chatHold=new Promise<void>(r=>releaseChat=r);
 const started:string[]=[];let active=0,peak=0;
 const model=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req){
  const path=new URL(req.url).pathname;if(path==='/api/tags')return Response.json({models:[{name:'synthetic:local'}]});
  const body=await req.json() as any;if(path==='/api/show')return Response.json({details:{family:'llama'},model_info:{'llama.context_length':8192},capabilities:['completion']});
  if(!body.prompt)return Response.json({done:true});
  let input:any;try{input=JSON.parse(body.prompt);}catch{}
  const kind=input?.segments?'tasks':input?.question?'chat':'notes';started.push(kind);active++;peak=Math.max(peak,active);
  try{
   if(started.length===1&&kind==='tasks')await taskHold;
   if(kind==='chat')await chatHold;
   const output=kind==='tasks'?'{"suggestions":[]}':kind==='notes'?'Grounded notes':JSON.stringify({claims:[{text:'Ana will review the budget.',evidenceIds:[input.evidence[0].id]}],notFound:false});
   return Response.json({response:output,done:true,done_reason:'stop'});
  }finally{active--;}
 }});
 const reserve=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response()});const port=reserve.port;reserve.stop(true);const base=`http://127.0.0.1:${port}`;
 const app=Bun.spawn([process.execPath,'run',join(import.meta.dir,'../server.ts')],{cwd:join(import.meta.dir,'../../..'),env:{...process.env,HEED_APP_DIR:state,HEED_RECORDINGS_DIR:join(state,'recordings'),HEED_MODEL:'synthetic:local',PORT:String(port),HEED_API_PORT:String(port),HEED_UI_PORT:'48101',HEED_TRANSCRIPTION_PORT:'48102',OLLAMA_HOST:`http://127.0.0.1:${model.port}`,HEED_TRANSCRIPTION_URL:base},stdout:'ignore',stderr:'ignore'});
 const request=async(path:string,body?:unknown)=>{const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});if(!response.ok)throw new Error(`HTTP ${response.status} ${path}`);return response.json() as Promise<any>;};
 const until=async(check:()=>Promise<boolean>)=>{const end=Date.now()+8000;while(Date.now()<end){if(await check())return;await Bun.sleep(20);}throw new Error('AI priority condition timed out');};
 const scope={mode:'labels',labels:['Planning'],match:'any'};
 const turn=async()=>scoped?(await request('/api/library-chat/context',{scope})).thread.turns[0]:(await request('/api/sessions/first/chat')).turns[0];
 const meeting=(id:string)=>({id,tags:['Planning'],language:'en',transcript:'Ana will review the budget.',transcriptFinalized:true,segments:[{speaker:'Ana',start:0,end:2,text:'Ana will review the budget.'}]});
 try{
  await until(async()=>{try{await request('/api/sessions');return true;}catch{return false;}});
  const source=await request('/api/sessions',meeting('first'));
  await until(async()=>started.length>0);expect(started).toEqual(['tasks']);
  await request('/api/sessions',meeting('second'));
  const command={action:'send',requestId:'priority',model:'synthetic:local',question:'Who reviews the budget?',expectedSourceRevision:scoped?(await request('/api/library-chat/context',{scope})).preview.snapshot.key:source.transcriptRevision};
  await request(scoped?'/api/library-chat/command':'/api/sessions/first/chat',scoped?{scope,command}:command);
  expect(await turn()).toMatchObject({status:'waiting',attempts:0,waitingReason:'tasks'});
  const sessions=await request('/api/sessions');expect(Object.values(sessions.find((s:any)=>s.id==='second').notesJobs)[0]).toMatchObject({waitingReason:'tasks'});
  releaseTask();await until(async()=>started.includes('chat'));
  expect(started.slice(0,2)).toEqual(['tasks','chat']);expect(started.filter(v=>v==='tasks')).toHaveLength(1);expect(started).not.toContain('notes');expect(peak).toBe(1);
  releaseChat();await until(async()=>(await turn()).status==='completed');const answer=await turn();expect(answer.waitingReason).toBeUndefined();expect(answer.answer.claims[0].citations[0]).toMatchObject({sessionId:'first',sourceRevision:source.transcriptRevision,quote:'Ana will review the budget.'});
  await until(async()=>started.filter(v=>v==='tasks').length===2&&started.includes('notes'));expect(peak).toBe(1);
 }finally{releaseTask();releaseChat();app.kill('SIGTERM');await app.exited;model.stop(true);rmSync(state,{recursive:true,force:true});}
},15000);
