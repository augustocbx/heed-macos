import {afterEach,expect,test} from 'bun:test';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import type {Session,ChatTurn} from '@heed/shared';
import {MeetingChatService} from '../meeting-chat';
import {LibraryChatService} from '../library-chat';
import {controlledChatRetrieval} from '../chat-retrieval-test-utils';
import {sourceRevision} from '../automatic-notes';
import {fixture,cleanupFixtures} from './connection-fixtures';
import {AiPlanner} from './planning';
import {AiAuthorizations} from './authorization';
import {AiRuntime} from './runtime';
import {getAiAdapter} from './adapters';
afterEach(cleanupFixtures);
const scope={mode:'labels' as const,labels:['selected'],match:'any' as const};
async function setup(kind:'chat'|'library-chat'){
 const f=fixture(),connection=await f.manager.register({provider:'openai',model:'gpt-6-luna',key:'SECRET_KEY'});await f.manager.validate(connection.id);f.manager.saveSelection(kind,{provider:'openai',connectionId:connection.id,model:connection.model});
 const session={id:'selected',title:'Selected',language:'pt',createdAt:'2026-10-07',transcript:'',segments:Array.from({length:12},(_,i)=>({speaker:'Ana',start:i,end:i+1,text:`SELECTED_${i} revisão orçamento `+'a'.repeat(1000)})),speakers:['Ana'],aiNotes:'NOTES_EXCLUDED',summary:'CALENDAR_EXCLUDED',files:{wav:'AUDIO_EXCLUDED'},tags:['selected'],pinned:false,duration:12,transcriptFinalized:true,transcriptVersion:1} as Session;
 session.transcriptRevision=sourceRevision(session);const excluded={...session,id:'excluded',tags:['excluded'],segments:[{speaker:'Other',start:0,end:1,text:'EXCLUDED_SECRET'}]};
 const sessions=[session,excluded],retrieval=controlledChatRetrieval(()=>sessions);let retrievals=0,localCalls=0,busy=true,hold:Promise<void>|undefined;
 const planner=new AiPlanner(f.manager),authorizations=new AiAuthorizations(planner),requests:any[]=[],reservations:number[]=[];
 const runtime=new AiRuntime({planner,authorizations,connections:f.manager,hooks:{reserve:async summary=>{reservations.push(summary.calls.length);return {dispatch:async()=>{},outcome:async()=>{},finish:async()=>{}};},acquire:async()=>({release:()=>{}})},generate:input=>getAiAdapter(input.selection.provider).generate({...input,fetch:(async(_url,init)=>{const body=JSON.parse(String(init?.body));requests.push(body);await hold;const data=JSON.parse(body.input);return Response.json({status:'completed',output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:JSON.stringify({claims:[{text:'Supported',evidenceIds:[data.evidence[0].id]}],notFound:false})}]}]});}) as typeof fetch})});
 const inference={planner,authorizations,runtime};const options={...retrieval,retriever:{...retrieval.retriever,retrieve:async(...args:Parameters<typeof retrieval.retriever.retrieve>)=>{retrievals++;return retrieval.retriever.retrieve(...args);}},directory:join(f.root,kind),getSession:(id:string)=>sessions.find(s=>s.id===id)??null,isBusy:()=>busy,inference,generate:async()=>{localCalls++;return '{"claims":[],"notFound":true}';}};
 const service=kind==='chat'?new MeetingChatService(options):new LibraryChatService(options);
 const get=()=>kind==='chat'?(service as MeetingChatService).get(session.id):(service as LibraryChatService).get(scope).thread;
 const command=(command:any)=>kind==='chat'?(service as MeetingChatService).command(session.id,command):(service as LibraryChatService).command(scope,command);
 planner.register(kind,command=>kind==='chat'?(service as MeetingChatService).prepareAi(command.sessionId!,command.turnId!):(service as LibraryChatService).prepareAi(command.scope as typeof scope,command.turnId!));
 const send=(requestId='request')=>command({action:'send',requestId,question:'What about orçamento?',model:connection.model,expectedSourceRevision:kind==='chat'?session.transcriptRevision:(service as LibraryChatService).preview(scope).snapshot.key});
 const prepare=(turnId=get().turns.at(-1)!.id)=>planner.prepare({feature:kind,sessionId:kind==='chat'?session.id:undefined,scope:kind==='library-chat'?scope:undefined,turnId});
 const consent=async()=>{const plan=await prepare();authorizations.authorize(plan.id,{allowRemote:true,expectedPayloadHash:plan.payloadHash});return plan;};
 return {...f,kind,session,sessions,service,options,get,command,send,prepare,consent,planner,authorizations,inference,requests,reservations,retrievals:()=>retrievals,localCalls:()=>localCalls,release:()=>busy=false,hold:(value:Promise<void>|undefined)=>hold=value,file:()=>join(options.directory,`${kind==='chat'?session.id:(get() as any).id}.json`)};
}
for(const kind of ['chat','library-chat'] as const){
 test(`${kind}: durable consent reserves the complete exact reviewed call set and excludes unrelated inputs`,async()=>{
  const f=await setup(kind);f.send();f.send();f.release();await f.service.tick();expect(f.requests).toHaveLength(0);expect(f.localCalls()).toBe(0);expect(f.get().turns).toHaveLength(1);expect(f.get().turns[0]?.reason).toBe('authorization-required');
  const plan=await f.consent();expect(plan.calls.length).toBeGreaterThan(1);expect(f.retrievals()).toBe(1);await f.service.tick();expect(f.retrievals()).toBe(1);expect(f.requests).toHaveLength(plan.calls.length);expect(f.reservations).toEqual([plan.calls.length]);
  for(const [i,request] of f.requests.entries()){expect(request.input).toBe(JSON.stringify(plan.calls[i]!.data));expect(request.instructions).toBe(plan.calls[i]!.system);for(const marker of ['EXCLUDED_SECRET','NOTES_EXCLUDED','CALENDAR_EXCLUDED','AUDIO_EXCLUDED'])expect(JSON.stringify(request)).not.toContain(marker);}
  expect(f.get().turns[0]).toMatchObject({status:'completed',provenance:{provider:'openai',model:'gpt-6-luna'}});
 });
 test(`${kind}: cancel and explicit retry replace review without timer replay`,async()=>{
  const f=await setup(kind);f.send();const first=await f.consent();const id=f.get().turns[0]!.id;f.command({action:'cancel',turnId:id});f.command({action:'retry',turnId:id});f.release();await f.service.tick();expect(f.requests).toHaveLength(0);expect(()=>f.authorizations.authorize(first.id,{allowRemote:true,expectedPayloadHash:first.payloadHash})).toThrow();const next=await f.consent();expect(next.jobId).toBe(first.jobId);expect(next.id).not.toBe(first.id);await f.service.tick();expect(f.get().turns[0]?.status).toBe('completed');
 });
 test(`${kind}: selected history edits invalidate review while own status changes do not`,async()=>{
  const f=await setup(kind);f.send('history');await f.consent();f.release();await f.service.tick();f.send('next');const plan=await f.consent();const stored=JSON.parse(readFileSync(f.file(),'utf8'));stored.turns[0].answer.claims[0].text='Changed historical answer';writeFileSync(f.file(),JSON.stringify(stored));const before=f.requests.length;await f.service.tick();expect(f.requests).toHaveLength(before);expect(()=>f.authorizations.authorize(plan.id,{allowRemote:true,expectedPayloadHash:plan.payloadHash})).toThrow('history-changed');
 });
 test(`${kind}: preemption after dispatch requires explicit retry and restart rejects late completion`,async()=>{
  const f=await setup(kind);f.send();await f.consent();let finish!:()=>void;f.hold(new Promise<void>(r=>finish=r));f.release();const running=f.service.tick();for(let i=0;i<100&&!f.requests.length;i++)await Bun.sleep(1);expect(f.requests.length).toBe(1);const preempt=f.service.preempt();finish();await preempt;await running;await f.service.tick();expect(f.requests).toHaveLength(1);expect(f.get().turns[0]?.reason).toBe('remote-attempt-uncertain');expect(f.get().turns[0]?.answer).toBeUndefined();
  const restarted=kind==='chat'?new MeetingChatService(f.options):new LibraryChatService(f.options);await restarted.tick();expect(f.requests).toHaveLength(1);
 });
}

for(const kind of ['chat','library-chat'] as const){
 test(`${kind}: consent-waiting chat does not block other optional jobs`,async()=>{const f=await setup(kind);f.send();expect(f.service.pending).toBe(false);await f.consent();expect(f.service.pending).toBe(true);});
 test(`${kind}: reviewed source version and scope changes reject before upload`,async()=>{
  for(const change of ['version','scope'] as const){const f=await setup(kind);f.send();const plan=await f.consent();if(change==='version')f.session.transcriptVersion!++;else if(kind==='library-chat')f.session.tags=[];else f.session.segments[0]!.text='Changed source';f.release();await f.service.tick();expect(f.requests).toHaveLength(0);expect(()=>f.authorizations.authorize(plan.id,{allowRemote:true,expectedPayloadHash:plan.payloadHash})).toThrow();}
 });
 test(`${kind}: process recovery fences a dispatched attempt and legacy turns remain local`,async()=>{
  const f=await setup(kind);f.send();await f.consent();let release!:()=>void;f.hold(new Promise<void>(resolve=>release=resolve));f.release();const old=f.service.tick();for(let i=0;i<100&&!f.requests.length;i++)await Bun.sleep(1);expect(f.requests).toHaveLength(1);
  const restarted=kind==='chat'?new MeetingChatService(f.options):new LibraryChatService(f.options);release();await old;await restarted.tick();expect(f.get().turns[0]).toMatchObject({status:'failed',reason:'remote-attempt-uncertain'});expect(f.get().turns[0]?.answer).toBeUndefined();expect(f.requests).toHaveLength(1);
  const stored=JSON.parse(readFileSync(f.file(),'utf8'));stored.turns[0].status='waiting';stored.turns[0].model='legacy-local';delete stored.turns[0].ai;writeFileSync(f.file(),JSON.stringify(stored));await restarted.tick();expect(f.localCalls()).toBeGreaterThan(0);expect(f.requests).toHaveLength(1);expect(f.get().turns[0]).toMatchObject({status:'completed',provenance:{provider:'ollama',model:'legacy-local'}});
 });
 test(`${kind}: HTTP preview and consent dispatch the existing server-owned command`,async()=>{
  const f=await setup(kind),{aiPlansResponse}=await import('./http');f.send();const id=f.get().turns[0]!.id;
  const http=(path:string,body:unknown)=>aiPlansResponse(new Request(`http://localhost:48100/api/ai/${path}`,{method:'POST',body:JSON.stringify(body)}),f.inference,true);
  const response=await http('plans',{feature:kind,...(kind==='chat'?{sessionId:f.session.id}:{scope}),turnId:id});expect(response?.status).toBe(200);expect(response?.headers.get('cache-control')).toBe('no-store');const preview=await response!.json();expect(f.requests).toHaveLength(0);
  expect((await http('authorize',{planId:preview.id,decision:{allowRemote:true,expectedPayloadHash:preview.payloadHash}}))?.status).toBe(200);f.release();await f.service.tick();expect(f.get().turns).toHaveLength(1);expect(f.get().turns[0]?.status).toBe('completed');expect(f.requests).toHaveLength(preview.calls.length);
 });
}

for(const kind of ['chat','library-chat'] as const)test(`${kind}: current source stamps guard uploads even before catalog reconciliation`,async()=>{
 const f=await setup(kind);f.send();const plan=await f.consent();const catalog=f.options.catalog,resolve=catalog.resolve.bind(catalog),preview=catalog.preview.bind(catalog);const frozen=resolve(kind==='chat'?{kind:'meeting',sessionId:f.session.id}:{kind:'library',scope});const frozenPreview=preview(scope);
 catalog.resolve=()=>frozen;catalog.preview=()=>frozenPreview;catalog.validate=()=>{};f.session.transcriptVersion!++;f.release();await f.service.tick();expect(f.requests).toHaveLength(0);expect(()=>f.authorizations.authorize(plan.id,{allowRemote:true,expectedPayloadHash:plan.payloadHash})).toThrow();
});

async function libraryHistoryFixture(){
 const f=await setup('library-chat');
 f.session.segments=[{speaker:'Ana',start:0,end:1,text:'CURRENT_A_MARKER'}];f.session.transcriptRevision=sourceRevision(f.session);
 const historical={...structuredClone(f.session),id:'history-b',title:'History source B',segments:[{speaker:'Ana',start:0,end:1,text:'HISTORY_B_MARKER'}]};historical.transcriptRevision=sourceRevision(historical);f.sessions.push(historical);
 let selectedId=historical.id,held=false,entered=false,release!:()=>void;const admission=new Promise<void>(resolve=>release=resolve),uploads:any[]=[];
 const retrieve=f.options.retriever.retrieve;
 f.options.retriever.retrieve=async(...args)=>{const result=await retrieve(...args);return {...result,hits:result.hits.filter(hit=>hit.sessionId===selectedId)};};
 f.inference.runtime=new AiRuntime({planner:f.planner,authorizations:f.authorizations,connections:f.manager,hooks:{reserve:async()=>({dispatch:async()=>{},outcome:async()=>{},finish:async()=>{}}),acquire:async()=>{if(held){entered=true;await admission;}return {release:()=>{}};}},generate:input=>getAiAdapter(input.selection.provider).generate({...input,fetch:(async(_url,init)=>{
  const body=JSON.parse(String(init?.body)),data=JSON.parse(body.input);uploads.push(body);
  return Response.json({status:'completed',output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:JSON.stringify({claims:[{text:data.evidence[0].quote,evidenceIds:[data.evidence[0].id]}],notFound:false})}]}]});
 }) as typeof fetch})});
 f.send('history-b-only');await f.consent();f.release();await f.service.tick();
 expect(uploads).toHaveLength(1);expect(JSON.parse(uploads[0].input).evidence.map((item:any)=>item.sessionId)).toEqual([historical.id]);expect(f.get().turns[0]?.status).toBe('completed');
 selectedId=f.session.id;f.send('current-a-only');const plan=await f.prepare(),reviewed=JSON.stringify(plan.calls);
 expect(plan.calls).toHaveLength(1);expect((plan.calls[0]!.data as any).evidence.map((item:any)=>item.sessionId)).toEqual([f.session.id]);expect(JSON.stringify((plan.calls[0]!.data as any).history)).toContain('HISTORY_B_MARKER');expect(plan.sources.map(source=>source.sessionId).sort()).toEqual([historical.id,f.session.id].sort());
 // Model the production catalog's pre-reconciliation cache, without changing the frozen sources or history.
 const catalog=f.options.catalog,frozen=catalog.resolve({kind:'library',scope}),preview=catalog.preview(scope);catalog.resolve=()=>frozen;catalog.preview=()=>preview;catalog.validate=()=>{};
 return {...f,historical,plan,reviewed,uploads,holdAdmission:()=>held=true,admissionEntered:()=>entered,releaseAdmission:release};
}
for(const change of ['version','revision','finalization'] as const)for(const timing of ['before-consent','during-admission'] as const)test(`library history-only ${change} changes invalidate reviewed content ${timing}`,async()=>{
 const f=await libraryHistoryFixture();let running:Promise<void>|undefined;
 try{
  if(timing==='during-admission'){
   f.authorizations.authorize(f.plan.id,{allowRemote:true,expectedPayloadHash:f.plan.payloadHash});f.holdAdmission();running=f.service.tick();
   for(let i=0;i<100&&!f.admissionEntered();i++)await Bun.sleep(1);expect(f.admissionEntered()).toBe(true);expect(f.uploads).toHaveLength(1);
  }
  if(change==='version')f.historical.transcriptVersion!++;
  else if(change==='revision'){f.historical.segments[0]!.text='Changed source B';f.historical.transcriptRevision=sourceRevision(f.historical);}
  else f.historical.transcriptFinalized=false;
  expect(()=>f.authorizations.authorize(f.plan.id,{allowRemote:true,expectedPayloadHash:f.plan.payloadHash})).toThrow('scope-changed');
  expect(()=>f.authorizations.assert(f.plan)).toThrow('scope-changed');
 }finally{f.releaseAdmission();await running;}
 await f.service.tick();expect(f.uploads).toHaveLength(1);expect(f.get().turns[1]?.answer).toBeUndefined();expect(JSON.stringify(f.plan.calls)).toBe(f.reviewed);expect(JSON.stringify(f.get().turns[0]?.answer)).toContain('HISTORY_B_MARKER');
});
