import {afterEach,expect,test} from 'bun:test';
import {join} from 'node:path';
import {AutomaticNotesService} from '../automatic-notes';
import {MeetingTasksService} from '../meeting-tasks';
import {fixture,cleanupFixtures} from './connection-fixtures';
import {AiPlanner} from './planning';
import {AiAuthorizations} from './authorization';
import {AiRuntime} from './runtime';
afterEach(cleanupFixtures);
async function setup(){
 const f=fixture(),c=await f.manager.register({provider:'openai',model:'gpt-6-luna',key:'SECRET_KEY'});await f.manager.validate(c.id);
 for(const feature of ['notes','tasks'] as const)f.manager.saveSelection(feature,{provider:'openai',connectionId:c.id,model:c.model});
 const planner=new AiPlanner(f.manager),authorizations=new AiAuthorizations(planner);let uploads=0,resources=0;
 let generation=(input:import('./contracts').AiAdapterRequest)=>Promise.resolve(input.call.id==='tasks'?'{"suggestions":[]}':'Reviewed notes');
 const runtime=new AiRuntime({planner,authorizations,connections:f.manager,hooks:{reserve:async()=>({dispatch:async()=>{},outcome:async()=>{},finish:async()=>{}}),acquire:async()=>{resources++;return {release:()=>{}};}},generate:async input=>{uploads++;return {text:await generation(input),finish:'completed',usage:{supported:false},provenance:{provider:input.selection.provider,model:input.selection.model!}};}});
 const inference={planner,authorizations,runtime};let template='Use only transcript';
 const notesOptions:ConstructorParameters<typeof AutomaticNotesService>[0]={sessionsDir:join(f.root,'sessions'),getSettings:()=>({enabled:true,model:'local',templateId:'t',language:'meeting'}),loadTemplate:()=>({id:'t',name:'T',description:'',prompt:template}),isBusy:()=>false,generate:async()=>{throw Error('legacy local callback must not receive remote');},inference};
 const notes=new AutomaticNotesService(notesOptions);
 const tasksOptions={path:join(f.root,'tasks.json'),listSessions:()=>notes.list(),getSession:(id:string)=>notes.get(id),isBusy:()=>false,generate:async()=>{throw Error('legacy local callback must not receive remote');},inference,getModel:()=> 'local'};
 const tasks=new MeetingTasksService(tasksOptions);
 planner.register('notes',command=>notes.prepareAi(command.sessionId!,command.jobId));planner.register('tasks',command=>tasks.prepareAi(command.sessionId!));
 const session=notes.create({id:'meeting',title:'Selected',language:'en',transcript:'I will send the report.',segments:[],transcriptFinalized:true,embeddings:{excluded:'EMBEDDING_MARKER'} as any,summary:'CALENDAR_MARKER',files:{wav:'AUDIO_MARKER'}});
 return {...f,notes,tasks,notesOptions,tasksOptions,setGenerate:(next:typeof generation)=>generation=next,planner,authorizations,runtime,session,uploads:()=>uploads,resources:()=>resources,template:()=>template='Changed template'};
}
test('automatic remote notes and historical tasks wait for source-specific consent',async()=>{
 const f=await setup();await f.notes.tick();await f.tasks.tick();expect(f.uploads()).toBe(0);
 expect(Object.values(f.notes.get('meeting')!.notesJobs!)[0]!.reason).toBe('authorization-required');expect(f.tasks.snapshot('meeting').review?.error).toBe('authorization-required');
 const plan=await f.planner.prepare({feature:'notes',sessionId:'meeting'});expect(JSON.stringify(plan.calls)).toContain('I will send');for(const excluded of ['AUDIO_MARKER','EMBEDDING_MARKER','CALENDAR_MARKER'])expect(JSON.stringify(plan.calls)).not.toContain(excluded);
 f.authorizations.authorize(plan.id,{allowRemote:true,expectedPayloadHash:plan.payloadHash});await f.notes.tick();expect(f.uploads()).toBe(1);expect(f.notes.get('meeting')!.aiNotes).toBe('Reviewed notes');
 expect(Object.values(f.notes.get('meeting')!.notesJobs!)).toHaveLength(1);
});
test('template edits invalidate notes review before dispatch',async()=>{
 const f=await setup(),plan=await f.planner.prepare({feature:'notes',sessionId:'meeting'});f.authorizations.authorize(plan.id,{allowRemote:true,expectedPayloadHash:plan.payloadHash});f.template();await f.notes.tick();expect(f.uploads()).toBe(0);expect(f.notes.get('meeting')!.aiNotes).toBe('');
});
test('task execution stays in the existing review ledger and requires acceptance',async()=>{
 const f=await setup();await f.tasks.tick();const before=f.tasks.snapshot('meeting').review!;const plan=await f.planner.prepare({feature:'tasks',sessionId:'meeting'});f.authorizations.authorize(plan.id,{allowRemote:true,expectedPayloadHash:plan.payloadHash});await f.tasks.tick();
 const after=f.tasks.snapshot('meeting');expect(after.review?.sourceRevision).toBe(before.sourceRevision);expect(after.review?.status).toBe('ready');expect(after.tasks).toEqual([]);expect(f.uploads()).toBe(1);
});

test('a consent-waiting job cannot starve a later authorized meeting',async()=>{
 const f=await setup();const later=f.notes.create({id:'later',createdAt:'2099-01-01T00:00:00Z',title:'Later',language:'en',transcript:'Later selected text.',transcriptFinalized:true});
 const plan=await f.planner.prepare({feature:'notes',sessionId:later.id});f.authorizations.authorize(plan.id,{allowRemote:true,expectedPayloadHash:plan.payloadHash});await f.notes.tick();
 expect(f.notes.get(later.id)!.aiNotes).toBe('Reviewed notes');expect(f.notes.get('meeting')!.aiNotes).toBe('');
 await f.tasks.tick();const taskPlan=await f.planner.prepare({feature:'tasks',sessionId:'meeting'});f.authorizations.authorize(taskPlan.id,{allowRemote:true,expectedPayloadHash:taskPlan.payloadHash});await f.tasks.tick();expect(f.tasks.snapshot('meeting').review?.status).toBe('ready');
});
test('duplicate pending retry requests preserve notes and task reviewed identity',async()=>{
 const f=await setup();await f.tasks.tick();const notesPlan=await f.planner.prepare({feature:'notes',sessionId:'meeting'}),taskPlan=await f.planner.prepare({feature:'tasks',sessionId:'meeting'});
 f.notes.retry('meeting');f.tasks.retry('meeting');
 expect(Object.values(f.notes.get('meeting')!.notesJobs!)[0]?.ai?.planId).toBe(notesPlan.id);expect(f.tasks.snapshot('meeting').review?.ai?.planId).toBe(taskPlan.id);
});
function delayed(){let resolve!:(value:string)=>void;const promise=new Promise<string>(r=>resolve=r);return {promise,resolve};}
async function until(test:()=>boolean){for(let i=0;i<200&&!test();i++)await Bun.sleep(1);expect(test()).toBe(true);}
async function consent(f:Awaited<ReturnType<typeof setup>>,feature:'notes'|'tasks'){
 const plan=await f.planner.prepare({feature,sessionId:'meeting'});f.authorizations.authorize(plan.id,{allowRemote:true,expectedPayloadHash:plan.payloadHash});return plan;
}
test('remote notes capture preemption never timer-replays, and explicit retry requires a fresh review',async()=>{
 const f=await setup(),pending=delayed();f.setGenerate(()=>pending.promise);const plan=await consent(f,'notes');const running=f.notes.tick();await until(()=>f.uploads()===1);
 const preempt=f.notes.preempt();pending.resolve('Late remote notes');await preempt;await running;await f.notes.tick();expect(f.uploads()).toBe(1);expect(f.notes.get('meeting')!.aiNotes).toBe('');
 expect(Object.values(f.notes.get('meeting')!.notesJobs!)[0]?.reason).toBe('remote-attempt-uncertain');
 f.notes.retry('meeting');await f.notes.tick();expect(f.uploads()).toBe(1);expect(()=>f.authorizations.authorize(plan.id,{allowRemote:true,expectedPayloadHash:plan.payloadHash})).toThrow();
 f.setGenerate(async()=> 'Explicit retry notes');const retry=await consent(f,'notes');expect(retry.id).not.toBe(plan.id);await f.notes.tick();expect(f.uploads()).toBe(2);expect(f.notes.get('meeting')!.aiNotes).toBe('Explicit retry notes');
});
test('remote task restart and late completions cannot overwrite a newer attempt',async()=>{
 const f=await setup(),first=delayed(),second=delayed();await f.tasks.tick();f.setGenerate(()=>first.promise);await consent(f,'tasks');const old=f.tasks.tick();await until(()=>f.uploads()===1);
 const restarted=new MeetingTasksService(f.tasksOptions);await restarted.tick();expect(restarted.snapshot('meeting').review?.error).toBe('remote-attempt-uncertain');await restarted.tick();expect(f.uploads()).toBe(1);
 first.resolve('{"suggestions":[]}');await old;expect(restarted.snapshot('meeting').review?.status).toBe('failed');
 restarted.retry('meeting');f.planner.register('tasks',command=>restarted.prepareAi(command.sessionId!));f.setGenerate(()=>second.promise);await consent(f,'tasks');const next=restarted.tick();await until(()=>f.uploads()===2);second.resolve('{"suggestions":[]}');await next;expect(restarted.snapshot('meeting').review?.status).toBe('ready');
});
test('remote task sourceVersion changes and invented evidence block persistence',async()=>{
 for(const change of ['version','citation'] as const){const f=await setup(),pending=delayed();await f.tasks.tick();await consent(f,'tasks');f.setGenerate(()=>pending.promise);const running=f.tasks.tick();await until(()=>f.uploads()===1);
 if(change==='version'){const session=f.notes.get('meeting')!;const {writeFileSync}=await import('node:fs');writeFileSync(join(f.root,'sessions','meeting.json'),JSON.stringify({...session,transcriptVersion:session.transcriptVersion!+1}));}
 pending.resolve(change==='citation'?JSON.stringify({suggestions:[{title:'Invented',description:'',kind:'explicit',assignee:null,dueDate:null,evidence:[{segmentIndex:0,quote:'Never said'}]}]}):'{"suggestions":[]}');await running;
 expect(f.tasks.snapshot('meeting').review?.status).toBe(change==='version'?'superseded':'failed');expect(f.tasks.snapshot('meeting').tasks).toEqual([]);
 }
});
test('manual notes and key replacement reject remote completion without overwriting current content',async()=>{
 for(const change of ['notes','key'] as const){const f=await setup(),pending=delayed();await consent(f,'notes');f.setGenerate(()=>pending.promise);const running=f.notes.tick();await until(()=>f.uploads()===1);
 if(change==='notes')f.notes.patch('meeting',{aiNotes:'User-authored notes'});else{const c=f.manager.snapshot().connections[0]!;await f.manager.replace(c.id,{provider:'openai',model:c.model,key:'REPLACED_SECRET'});}
 pending.resolve('Obsolete generated notes');await running;expect(f.notes.get('meeting')!.aiNotes).toBe(change==='notes'?'User-authored notes':'');await f.notes.tick();expect(f.uploads()).toBe(1);
 }
});
test('remote task rate limits expose only the stable provider error code',async()=>{
 const f=await setup();await f.tasks.tick();await consent(f,'tasks');const {AiInferenceError}=await import('./contracts');f.setGenerate(async()=>{throw new AiInferenceError('rate-limited');});await f.tasks.tick();expect(f.tasks.snapshot('meeting').review?.error).toBe('rate-limited');
});

test('explicit retry refreshes changed settings on pending reviews while preserving domain identity',async()=>{
 const f=await setup();await f.tasks.tick();const old=await consent(f,'notes');f.template();f.notes.retry('meeting');const refreshed=await f.planner.prepare({feature:'notes',sessionId:'meeting'});expect(refreshed.jobId).toBe(old.jobId);expect(JSON.stringify(refreshed.calls)).toContain('Changed template');
 f.manager.saveSelection('tasks',{provider:'ollama',connectionId:null,model:'other-local'});f.tasks.retry('meeting');expect(f.tasks.snapshot('meeting').review?.ai?.selection.model).toBe('other-local');
});

test('task plans explicitly require structured output before remote admission',async()=>{
 const f=await setup();await f.tasks.tick();const plan=await f.planner.prepare({feature:'tasks',sessionId:'meeting'});expect(plan.calls[0]?.schema).toMatchObject({type:'object',required:['suggestions']});
});

test('remote tasks preempt to explicit retry and notes restart never resubmits a dispatched job',async()=>{
 for(const feature of ['tasks','notes'] as const){const f=await setup(),pending=delayed();if(feature==='tasks')await f.tasks.tick();await consent(f,feature);f.setGenerate(()=>pending.promise);const service=feature==='tasks'?f.tasks:f.notes,running=service.tick();await until(()=>f.uploads()===1);
 if(feature==='tasks'){const preempt=f.tasks.preempt();pending.resolve('{"suggestions":[]}');await preempt;await running;await f.tasks.tick();expect(f.tasks.snapshot('meeting').review?.error).toBe('remote-attempt-uncertain');}
 else{const restarted=new AutomaticNotesService(f.notesOptions);restarted.recover();await restarted.tick();expect(Object.values(restarted.get('meeting')!.notesJobs!)[0]?.reason).toBe('remote-attempt-uncertain');pending.resolve('Old attempt');await running;expect(restarted.get('meeting')!.aiNotes).toBe('');}
 expect(f.uploads()).toBe(1);
 }
});
test('legacy queued jobs remain local after remote feature selection, with resource hooks still applied',async()=>{
 const f=await setup();const {readFileSync,writeFileSync}=await import('node:fs');
 const session=JSON.parse(readFileSync(join(f.root,'sessions','meeting.json'),'utf8'));for(const job of Object.values(session.notesJobs) as any[])delete job.ai;writeFileSync(join(f.root,'sessions','meeting.json'),JSON.stringify(session));
 let localCalls=0;const legacyNotes=new AutomaticNotesService({...f.notesOptions,generate:async()=>{localCalls++;return 'Legacy local notes';}});await legacyNotes.tick();expect(localCalls).toBe(1);expect(f.uploads()).toBe(0);
 await f.tasks.tick();const store=JSON.parse(readFileSync(join(f.root,'tasks.json'),'utf8'));delete store.reviews.meeting.ai;writeFileSync(join(f.root,'tasks.json'),JSON.stringify(store));
 const legacyTasks=new MeetingTasksService({...f.tasksOptions,generate:async()=>{localCalls++;return '{"suggestions":[]}';}});await legacyTasks.tick();expect(localCalls).toBe(2);expect(f.uploads()).toBe(0);expect(f.resources()).toBe(2);
});

test('real provider adapter receives only the reviewed notes call through the durable service',async()=>{
 const f=await setup();const {getAiAdapter}=await import('./adapters');const requests:RequestInit[]=[];
 f.notesOptions.inference!.runtime=new AiRuntime({planner:f.planner,authorizations:f.authorizations,connections:f.manager,hooks:{reserve:async()=>({dispatch:async()=>{},outcome:async()=>{},finish:async()=>{}}),acquire:async()=>({release:()=>{}})},generate:input=>getAiAdapter(input.selection.provider).generate({...input,fetch:(async(_url,init)=>{requests.push(init!);return Response.json({status:'completed',output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'Fixture provider notes'}]}],usage:{input_tokens:20,output_tokens:4}});}) as typeof fetch})});
 await f.notes.tick();expect(requests).toHaveLength(0);const plan=await consent(f,'notes');await f.notes.tick();expect(requests).toHaveLength(1);
 const body=JSON.parse(String(requests[0]!.body));expect(JSON.stringify(body)).toContain('I will send the report.');expect(JSON.stringify(body)).not.toContain('AUDIO_MARKER');expect(JSON.stringify(body)).not.toContain('CALENDAR_MARKER');expect(JSON.stringify(body)).not.toContain('SECRET_KEY');expect(f.notes.get('meeting')!.aiNotes).toBe('Fixture provider notes');expect(plan.selection.provider).toBe('openai');
});

test('explicit retry can refresh a legacy pending record to the selected provider without uploading',async()=>{
 const f=await setup();await f.tasks.tick();const {readFileSync,writeFileSync}=await import('node:fs');
 for(const [file,select] of [[join(f.root,'sessions','meeting.json'),(record:any)=>Object.values(record.notesJobs)[0]],[join(f.root,'tasks.json'),(record:any)=>record.reviews.meeting]] as const){const record=JSON.parse(readFileSync(file,'utf8'));delete (select(record) as any).ai;writeFileSync(file,JSON.stringify(record));}
 f.notes.retry('meeting');f.tasks.retry('meeting');expect(Object.values(f.notes.get('meeting')!.notesJobs!)[0]?.ai?.selection.provider).toBe('openai');expect(f.tasks.snapshot('meeting').review?.ai?.selection.provider).toBe('openai');expect(f.uploads()).toBe(0);
});

test('unreadable AI settings preserve new recordings and fail jobs without silently selecting local inference',async()=>{
 const f=await setup();const {writeFileSync}=await import('node:fs'),{AiConnections}=await import('./connections');writeFileSync(join(f.root,'ai','connections.json'),'broken');
 f.notesOptions.inference!.planner=new AiPlanner(new AiConnections(f.options));
 const saved=f.notes.create({id:'recovery',transcript:'Preserved recording.',language:'en',transcriptFinalized:true});expect(saved.transcript).toBe('Preserved recording.');expect(Object.values(saved.notesJobs!)[0]?.reason).toBe('settings-recovery');
 await f.tasks.tick();expect(f.tasks.snapshot('recovery').review?.error).toBe('settings-recovery');expect(f.uploads()).toBe(0);
});
