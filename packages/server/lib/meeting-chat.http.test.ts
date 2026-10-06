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
  process=Bun.spawn([globalThis.process.execPath,"run",join(import.meta.dir,"..","server.ts")],{cwd:join(import.meta.dir,"..","..",".."),env:{...globalThis.process.env,HEED_APP_DIR:state,PORT:String(port),OLLAMA_HOST:`http://127.0.0.1:${ollama.port}`},stdout:"ignore",stderr:"ignore"});
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
