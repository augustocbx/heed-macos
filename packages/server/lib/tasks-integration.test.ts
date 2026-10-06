import {afterAll,beforeAll,expect,test} from 'bun:test';
import {mkdtempSync,writeFileSync,rmSync,renameSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import type {Session,TasksSnapshot} from '../../shared/types';
let pauseTasks=false;let unloadStarted=false;let finishUnload:(()=>void)|undefined;
let directory:string;let app:ReturnType<typeof Bun.spawn>;let model:ReturnType<typeof Bun.serve>;let base:string;let meeting:Session;
async function until<T>(read:()=>Promise<T>,check:(value:T)=>boolean):Promise<T>{const deadline=Date.now()+8000;while(Date.now()<deadline){try{const value=await read();if(check(value))return value;}catch{}await Bun.sleep(25);}throw new Error('Isolated task server timed out');}
async function command(body:unknown){const response=await fetch(`${base}/api/tasks`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:response.status,body:await response.json() as TasksSnapshot};}
async function snapshot(sessionId?:string):Promise<TasksSnapshot>{return (await fetch(`${base}/api/tasks${sessionId?`?sessionId=${sessionId}`:''}`)).json();}
async function start(){app=Bun.spawn([process.execPath,resolve(import.meta.dir,'../server.ts')],{cwd:resolve(import.meta.dir,'../../..'),env:{...process.env,PORT:base.split(':').at(-1)!,HEED_APP_DIR:directory,OLLAMA_HOST:`http://127.0.0.1:${model.port}`},stdout:'ignore',stderr:'pipe'});await until(async()=>(await fetch(`${base}/api/tasks`)).status,status=>status===200);}
beforeAll(async()=>{
 directory=mkdtempSync(join(tmpdir(),'heed-tasks-http-'));writeFileSync(join(directory,'config.json'),JSON.stringify({ollama_model:'fixture:1b'}));
 model=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){const path=new URL(request.url).pathname;
  if(path==='/api/tags')return Response.json({models:[{name:'fixture:1b'}]});if(path==='/api/show')return Response.json({details:{family:'fixture'}});
  if(path==='/api/generate'){const body=await request.json() as {prompt:string};if(!body.prompt){if(pauseTasks){unloadStarted=true;await new Promise<void>(resolve=>{finishUnload=resolve;});}return Response.json({done:true});}
   const segments=JSON.parse(body.prompt).segments;if(!segments)return new Response(JSON.stringify({response:'Grounded notes',done:true})+'\n');
   if(pauseTasks)return new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('{"response":"partial","done":false}\n'));}}));
   const suggestions=segments[0].text==='No actions today.'?[]:segments.map((segment:any,i:number)=>({title:`Task ${i+1}`,description:segment.text,kind:i===0?'explicit':'inferred',assignee:null,dueDate:i===0?'2026-10-09':null,dateQuote:i===0?'2026-10-09':i===1?'next Friday':null,evidence:[{segmentIndex:i,quote:segment.text}]}));
   return new Response(JSON.stringify({response:JSON.stringify({suggestions}),done:true})+'\n');
  }return Response.json({whisper:true});
 }});
 const reserve=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response()});base=`http://127.0.0.1:${reserve.port}`;reserve.stop(true);await start();
},10000);
afterAll(async()=>{finishUnload?.();app?.kill();if(app)await app.exited;model?.stop(true);if(directory)rmSync(directory,{recursive:true,force:true});});
test('finalized meetings generate local cited suggestions without accepting any task',async()=>{
 const segments=['I will send the report on 2026-10-09.','Maybe update this next Friday.','Revisar a lista.','We should check the design.','Please prepare a draft.'].map((text,i)=>({speaker:i%2?'Bruno':'Ana',start:i*2,end:i*2+1,text}));
 const response=await fetch(`${base}/api/sessions`,{method:'POST',body:JSON.stringify({id:'task-fixture',title:'Synthetic meeting',transcriptFinalized:true,language:'pt',transcript:segments.map(s=>s.text).join(' '),speakers:['Ana','Bruno'],segments})});expect(response.status).toBe(200);meeting=await response.json();
 const result=await until(()=>snapshot(meeting.id),value=>value.review?.status==='ready');expect(result.tasks).toHaveLength(0);expect(result.review?.suggestions).toHaveLength(5);expect(result.review?.suggestions[0].dueDate).toBe('2026-10-09');expect(result.review?.suggestions[1]).toMatchObject({dueDate:null,dateReview:'next Friday'});
});
test('only two selected tasks persist across acceptance retries, restart and completion/date changes',async()=>{
 const review=(await snapshot(meeting.id)).review!;const items=[review.suggestions[0],review.suggestions[3]].map(s=>({suggestionId:s.id,title:s.title,description:s.description,assignee:s.assignee,dueDate:s.dueDate}));
 const body={action:'accept',sessionId:meeting.id,sourceRevision:review.sourceRevision,items};const responses=await Promise.all([command(body),command(body)]);expect(responses.map(r=>r.status)).toEqual([200,200]);expect((await snapshot()).tasks).toHaveLength(2);
 app.kill();await app.exited;await start();let task=(await snapshot()).tasks[0];expect(task.completedAt).toBeNull();expect(task.dueDate).toBe('2026-10-09');
 expect((await command({action:'update',id:task.id,revision:task.revision,patch:{status:'completed',dueDate:null}})).status).toBe(200);task=(await snapshot()).tasks[0];expect(task.dueDate).toBeNull();expect(task.completedAt).not.toBeNull();
 expect((await command({action:'update',id:task.id,revision:task.revision,patch:{status:'open',dueDate:null}})).status).toBe(200);expect((await snapshot()).tasks[0].completedAt).toBeNull();
});
test('storage failure is reported and acceptance retry cannot partially create items',async()=>{
 const review=(await snapshot(meeting.id)).review!;const suggestion=review.suggestions[1];const body={action:'accept',sessionId:meeting.id,sourceRevision:review.sourceRevision,items:[{suggestionId:suggestion.id,title:suggestion.title,description:'',assignee:null,dueDate:null}]};
 const path=join(directory,'tasks.json');renameSync(path,`${path}.backup`);mkdirSync(path);
 expect((await command(body)).status).toBe(503);rmSync(path,{recursive:true});renameSync(`${path}.backup`,path);
 expect((await snapshot()).tasks).toHaveLength(2);expect((await command(body)).status).toBe(200);expect((await snapshot()).tasks).toHaveLength(3);
});
test('source removal preserves accepted tasks with unavailable-source state',async()=>{
 const response=await fetch(`${base}/api/sessions?id=${meeting.id}`,{method:'DELETE'});expect(response.status).toBe(200);
 const result=await snapshot();expect(result.tasks).toHaveLength(3);expect(result.tasks.every(task=>task.sourceState==='meeting-deleted'&&!task.audioAvailable)).toBe(true);expect(result.tasks[0].evidence[0].quote).toContain('report');
});
test('a meeting with no tasks yields a durable empty review',async()=>{
 await fetch(`${base}/api/sessions`,{method:'POST',body:JSON.stringify({id:'no-task-fixture',transcriptFinalized:true,transcript:'No actions today.',segments:[{speaker:'Ana',text:'No actions today.',start:0,end:1}]})});
 const result=await until(()=>snapshot('no-task-fixture'),value=>value.review?.status==='ready');expect(result.review?.suggestions).toHaveLength(0);expect(result.tasks).toHaveLength(0);
});

test('manual notes reserve resources before awaiting task model preemption',async()=>{
 pauseTasks=true;unloadStarted=false;
 await fetch(`${base}/api/sessions`,{method:'POST',body:JSON.stringify({id:'preemption-fixture',transcriptFinalized:true,transcript:'I will prepare the report tomorrow.',segments:[{speaker:'Ana',text:'I will prepare the report tomorrow.',start:0,end:1}]})});
 await until(()=>snapshot('preemption-fixture'),value=>value.review?.status==='running');
 const input={transcript:'I will prepare the report tomorrow.',language:'en',templateId:'general'};
 const first=fetch(`${base}/api/summarize`,{method:'POST',body:JSON.stringify(input)});
 await until(async()=>unloadStarted,value=>value);
 const secondRequest=fetch(`${base}/api/summarize`,{method:'POST',body:JSON.stringify(input)});
 const second=await Promise.race([secondRequest,Bun.sleep(400).then(()=>null)]);
 pauseTasks=false;finishUnload?.();finishUnload=undefined;
 const response=await first;await response.text();const completedSecond=await secondRequest;await completedSecond.text();
 expect(second?.status).toBe(409);expect(response.status).toBe(200);
});
