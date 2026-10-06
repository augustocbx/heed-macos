import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// This test runs the real server with synthetic state and an isolated fake Ollama.
// It never starts recording, ASR, installed models, or the user's desktop services.
test("isolated HTTP chat persists across restart, cancels generation and rejects hostile origins", async () => {
 const state=mkdtempSync(join(tmpdir(),"heed-chat-http-"));
 let unloads=0;let cancelStarted=false;
 const ollama=Bun.serve({hostname:"127.0.0.1",port:0,async fetch(req){
  const path=new URL(req.url).pathname;
  if(path==="/api/tags")return Response.json({models:[{name:"synthetic:latest"},{name:"embed:latest"},{name:"fake-cloud"}]});
  const body=await req.json() as any;
  if(path==="/api/show")return Response.json({details:{family:"llama"},model_info:{"llama.context_length":8192},capabilities:body.model==="embed:latest" ? ["embedding"] : ["completion"]});
  if(!body.prompt){unloads++;return Response.json({done:true});}
  const input=JSON.parse(body.prompt);
  expect(body.options.num_ctx).toBe(8192);
  if(input.question==="Cancel this request"){cancelStarted=true;await new Promise(resolve=>setTimeout(resolve,500));}
  return Response.json({response:JSON.stringify({claims:[{text:"Ana will review the budget.",evidenceIds:[input.evidence[0].id]}],notFound:false}),done:true,done_reason:"stop"});
 }});
 const probe=Bun.serve({hostname:"127.0.0.1",port:0,fetch:()=>new Response()});const port=probe.port;await probe.stop(true);
 const base=`http://127.0.0.1:${port}`;
 let process:Bun.Subprocess|undefined;
 const request=async(path:string,body?:unknown,extra:RequestInit={})=>{
  const response=await fetch(base+path,{method:body===undefined ? "GET" : "POST",headers:{"content-type":"application/json"},body:body===undefined ? undefined : JSON.stringify(body),...extra});
  return {status:response.status,body:await response.json() as any};
 };
 const waitFor=async(check:()=>Promise<boolean>)=>{for(let i=0;i<150;i++){if(await check())return;await new Promise(resolve=>setTimeout(resolve,20));}throw new Error("Isolated HTTP condition timed out");};
 const start=async()=>{
  process=Bun.spawn([globalThis.process.execPath,"run",join(import.meta.dir,"..","server.ts")],{cwd:join(import.meta.dir,"..","..",".."),env:{...globalThis.process.env,HEED_APP_DIR:state,HEED_RECORDINGS_DIR:join(state,"recordings"),PORT:String(port),HEED_API_PORT:String(port),HEED_UI_PORT:"48101",HEED_TRANSCRIPTION_PORT:"48102",HEED_TRANSCRIPTION_URL:base,VITE_API_BASE:base,OLLAMA_HOST:`http://127.0.0.1:${ollama.port}`},stdout:"ignore",stderr:"ignore"});
  await waitFor(async()=>{try{return (await request("/api/sessions")).status===200;}catch{return false;}});
 };
 const stop=async()=>{if(process){process.kill("SIGTERM");await process.exited;process=undefined;}};
 try {
  await start();
  const source=(await request("/api/sessions",{id:"synthetic",title:"Synthetic bilingual meeting",language:"pt",transcript:"Ana: Vou revisar o orçamento.",segments:[{speaker:"Ana",start:1,end:3,text:"Vou revisar o orçamento."}],speakers:["Ana"],transcriptFinalized:true})).body;
  expect((await request("/api/chat/models")).body.models).toEqual(["synthetic:latest"]);
  expect((await request("/api/sessions/synthetic/chat",undefined,{headers:{origin:"https://hostile.example"}})).status).toBe(403);
  const command={action:"send",requestId:"question-a",question:"What did Ana agree to do?",model:"synthetic:latest",expectedSourceRevision:source.transcriptRevision};
  expect((await request("/api/sessions/synthetic/chat",command)).status).toBe(200);
  await waitFor(async()=>(await request("/api/sessions/synthetic/chat")).body.turns[0].status==="completed");
  const saved=(await request("/api/sessions/synthetic/chat")).body;
  const citation=saved.turns[0].answer.claims[0].citations[0];expect(citation).toMatchObject({quote:"Vou revisar o orçamento.",speaker:"Ana",segmentIndex:0,start:1});
  expect((await request("/api/sessions/synthetic/chat",command)).body.turns).toHaveLength(1);
  await stop();await start();expect((await request("/api/sessions/synthetic/chat")).body.turns[0].answer.claims[0].citations[0]).toEqual(citation);
  await request("/api/sessions/synthetic/chat",{...command,requestId:"question-b",question:"Cancel this request"});
  await waitFor(async()=>cancelStarted);
  const active=(await request("/api/sessions/synthetic/chat")).body.turns[1];
  expect((await request("/api/sessions/synthetic/chat",{action:"cancel",turnId:active.id})).status).toBe(200);
  await waitFor(async()=>unloads>0);
  expect((await request("/api/sessions/synthetic/chat")).body.turns[1].status).toBe("cancelled");
  await request("/api/sessions?id=synthetic",{transcript:"Edited synthetic transcript"},{method:"PATCH"});
  const stale=(await request("/api/sessions/synthetic/chat")).body;expect(stale.turns[0].stale).toBe(true);
  expect((await request("/api/sessions/synthetic/chat",{action:"clear",expectedThreadRevision:stale.revision})).status).toBe(200);
  expect((await request("/api/sessions/synthetic/chat")).body.turns).toHaveLength(0);
  expect((await request("/api/sessions?id=synthetic",undefined,{method:"DELETE"})).status).toBe(200);
  expect((await request("/api/sessions/synthetic/chat")).status).toBe(404);
 }finally {await stop();await ollama.stop(true);rmSync(state,{recursive:true,force:true});}
},15000);

test("real HTTP task and chat queues share one local model slot",async()=>{
 const state=mkdtempSync(join(tmpdir(),"heed-chat-task-http-"));
 let taskCalls=0,chatCalls=0,active=0,peak=0;
 let releaseTask:()=>void=()=>{},releaseChat:()=>void=()=>{};
 const taskHold=new Promise<void>(resolve=>{releaseTask=resolve;});const chatHold=new Promise<void>(resolve=>{releaseChat=resolve;});
 const ollama=Bun.serve({hostname:"127.0.0.1",port:0,async fetch(req){
  const path=new URL(req.url).pathname;if(path==="/api/tags")return Response.json({models:[{name:"synthetic:latest"}]});
  const body=await req.json() as any;if(path==="/api/show")return Response.json({details:{family:"llama"},model_info:{"llama.context_length":8192},capabilities:["completion"]});
  if(!body.prompt)return Response.json({done:true});
  const input=JSON.parse(body.prompt);active++;peak=Math.max(peak,active);
  try{
   if(input.segments){taskCalls++;if(taskCalls===1)await taskHold;return Response.json({response:'{"suggestions":[]}',done:true});}
   chatCalls++;await chatHold;return Response.json({response:JSON.stringify({claims:[{text:"Ana will review the budget.",evidenceIds:[input.evidence[0].id]}],notFound:false}),done:true,done_reason:"stop"});
  }finally{active--;}
 }});
 const probe=Bun.serve({hostname:"127.0.0.1",port:0,fetch:()=>new Response()});const port=probe.port;await probe.stop(true);const base=`http://127.0.0.1:${port}`;
 const server=Bun.spawn([globalThis.process.execPath,"run",join(import.meta.dir,"..","server.ts")],{cwd:join(import.meta.dir,"..","..",".."),env:{...globalThis.process.env,HEED_APP_DIR:state,HEED_RECORDINGS_DIR:join(state,"recordings"),HEED_MODEL:"synthetic:latest",PORT:String(port),HEED_API_PORT:String(port),HEED_UI_PORT:"48101",HEED_TRANSCRIPTION_PORT:"48102",HEED_TRANSCRIPTION_URL:base,VITE_API_BASE:base,OLLAMA_HOST:`http://127.0.0.1:${ollama.port}`},stdout:"ignore",stderr:"ignore"});
 const request=async(path:string,body?:unknown)=>{const response=await fetch(base+path,{method:body===undefined?"GET":"POST",headers:{"content-type":"application/json"},body:body===undefined?undefined:JSON.stringify(body)});expect(response.ok).toBe(true);return response.json() as Promise<any>;};
 const waitFor=async(check:()=>Promise<boolean>)=>{for(let i=0;i<250;i++){if(await check())return;await new Promise(resolve=>setTimeout(resolve,20));}throw new Error("Shared model scheduling condition timed out");};
 const meeting=(id:string)=>({id,title:"Synthetic meeting",language:"pt",transcript:"Ana: Vou revisar o orçamento da reunião.",segments:[{speaker:"Ana",text:"Vou revisar o orçamento da reunião.",start:0,end:2}],speakers:["Ana"],transcriptFinalized:true});
 try{
  await waitFor(async()=>{try{return !!await request("/api/sessions");}catch{return false;}});
  const source=await request("/api/sessions",meeting("first"));await waitFor(async()=>taskCalls===1);
  await request("/api/sessions/first/chat",{action:"send",requestId:"shared-slot",question:"What did Ana agree to do?",model:"synthetic:latest",expectedSourceRevision:source.transcriptRevision});
  await new Promise(resolve=>setTimeout(resolve,1100));expect(chatCalls).toBe(0);expect((await request("/api/sessions/first/chat")).turns[0].status).toBe("waiting");
  releaseTask();await waitFor(async()=>chatCalls===1);
  await request("/api/sessions",meeting("second"));await new Promise(resolve=>setTimeout(resolve,1100));expect(taskCalls).toBe(1);expect((await request("/api/tasks?sessionId=second")).review.status).toBe("queued");
  releaseChat();await waitFor(async()=>(await request("/api/sessions/first/chat")).turns[0].status==="completed");await waitFor(async()=>taskCalls===2);expect(peak).toBe(1);
 }finally{releaseTask();releaseChat();server.kill("SIGTERM");await server.exited;await ollama.stop(true);rmSync(state,{recursive:true,force:true});}
},20000);

test('single and scoped chat request required response fields with exact eligible citation IDs',async()=>{
 const state=mkdtempSync(join(tmpdir(),'heed-chat-schema-http-'));const received:any[]=[];let app:Bun.Subprocess|undefined;
 const ollama=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){const path=new URL(request.url).pathname;if(path==='/api/tags')return Response.json({models:[{name:'synthetic:local'}]});const body=await request.json() as any;if(path==='/api/show')return Response.json({details:{family:'llama'},model_info:{'llama.context_length':8192},capabilities:['completion']});if(!body.prompt)return Response.json({done:true});const input=JSON.parse(body.prompt);received.push({body,input});const captured={claims:[{text:'The budget was not approved.',evidenceIds:[input.evidence[0].id]}]};const schema=body.format;const required=typeof schema==='object'&&schema.required?.includes('claims')&&schema.required?.includes('notFound');return Response.json({response:JSON.stringify(required?{...captured,notFound:false}:captured),done:true,done_reason:'stop'});}});
 const reservation=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response()}),port=reservation.port;reservation.stop(true);const base=`http://127.0.0.1:${port}`;
 const call=async(path:string,body?:unknown)=>{const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});expect(response.ok).toBe(true);return response.json() as Promise<any>;};
 const wait=async(read:()=>Promise<any>)=>{for(let i=0;i<250;i++){const value=await read();if(['completed','failed'].includes(value?.status))return value;await Bun.sleep(20);}throw new Error('Schema HTTP generation timed out');};
 try{app=Bun.spawn([process.execPath,'run',join(import.meta.dir,'..','server.ts')],{cwd:join(import.meta.dir,'../../..'),env:{...process.env,HEED_APP_DIR:state,HEED_RECORDINGS_DIR:join(state,'recordings'),HEED_MODEL:'',PORT:String(port),HEED_API_PORT:String(port),HEED_UI_PORT:"48101",HEED_TRANSCRIPTION_PORT:"48102",HEED_TRANSCRIPTION_URL:base,VITE_API_BASE:base,OLLAMA_HOST:`http://127.0.0.1:${ollama.port}`},stdout:'ignore',stderr:'ignore'});let ready=false;for(let i=0;i<150;i++){try{if((await fetch(base+'/api/sessions')).ok){ready=true;break;}}catch{}await Bun.sleep(20);}expect(ready).toBe(true);
  const source=await call('/api/sessions',{id:'allowed',title:'Synthetic',language:'pt',tags:['Allowed'],transcriptFinalized:true,transcript:'O orçamento não foi aprovado.',segments:[{speaker:'Ana',start:0,end:2,text:'O orçamento não foi aprovado.'}]});await call('/api/sessions',{id:'excluded',title:'Excluded',language:'en',tags:['Other'],transcriptFinalized:true,transcript:'EXCLUDED_MARKER',segments:[{speaker:'Dora',start:0,end:2,text:'EXCLUDED_MARKER'}]});
  await call('/api/sessions/allowed/chat',{action:'send',requestId:'single',question:'Budget?',model:'synthetic:local',expectedSourceRevision:source.transcriptRevision});const single=await wait(async()=>(await call('/api/sessions/allowed/chat')).turns[0]);expect(single.status).toBe('completed');
  const scope={mode:'labels',labels:['Allowed'],match:'any'},context=await call('/api/library-chat/context',{scope});await call('/api/library-chat/command',{scope,command:{action:'send',requestId:'scoped',question:'Budget?',model:'synthetic:local',expectedSourceRevision:context.preview.snapshot.key}});const scoped=await wait(async()=>(await call('/api/library-chat/context',{scope})).thread.turns[0]);expect(scoped.status).toBe('completed');
  expect(received).toHaveLength(2);for(const {body,input} of received){expect(body.format).toMatchObject({type:'object',additionalProperties:false,required:['claims','notFound'],properties:{notFound:{type:'boolean'},claims:{type:'array',maxItems:12,items:{required:['text','evidenceIds'],additionalProperties:false,properties:{text:{type:'string'},evidenceIds:{type:'array',minItems:1,maxItems:20,uniqueItems:true,items:{type:'string',enum:input.evidence.map((e:any)=>e.id)}}}}}}});expect(body.format.properties.claims.items.properties.text).toEqual({type:'string'});expect(body.options).toMatchObject({num_ctx:8192,num_predict:1800});expect(JSON.stringify(body.format)).not.toContain('excluded');expect(JSON.stringify(input)).not.toContain('EXCLUDED_MARKER');}
 }finally{app?.kill('SIGTERM');if(app)await app.exited;ollama.stop(true);rmSync(state,{recursive:true,force:true});}
},15000);
