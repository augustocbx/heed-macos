import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Session } from '../../shared/types';
import { MeetingTasksService, validateTaskSuggestions } from './meeting-tasks';
import { sourceRevision } from './automatic-notes';
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
 const directory = mkdtempSync(join(tmpdir(), 'heed-tasks-')); dirs.push(directory);
 let meeting: Session | null = { id:'m', title:'Fixture meeting', createdAt:'2026-10-05T12:00:00Z',duration:10,language:'en',transcript:'I will send the report on 2026-10-09. Maybe update the checklist next Friday.',speakers:['Ana','Ben'],segments:[{speaker:'Ana',start:0,end:3,text:'I will send the report on 2026-10-09.'},{speaker:'Ben',start:4,end:7,text:'Maybe update the checklist next Friday.'}],aiNotes:'',summary:'',tags:[],pinned:false,transcriptFinalized:true };
 const raw = [ { title:'Send report',description:'Send the report',kind:'explicit',assignee:'Ana',dueDate:'2026-10-09',dateQuote:'2026-10-09',evidence:[{segmentIndex:0,quote:'I will send the report on 2026-10-09.'}]}, {title:'Update checklist',description:'Review checklist',kind:'inferred',assignee:null,dueDate:'2026-10-09',dateQuote:'next Friday',evidence:[{segmentIndex:1,quote:'Maybe update the checklist next Friday.'}]} ];
 let generation = async () => JSON.stringify({suggestions:raw});
 const options = { path:join(directory,'tasks.json'),listSessions:()=>meeting ? [meeting] : [],getSession:()=>meeting,generate:(session:Session,signal:AbortSignal)=>generation(),isBusy:()=>false,now:()=>new Date('2026-10-05T12:30:00Z') };
 const service = new MeetingTasksService(options);
 return { service, options, raw, get meeting(){return meeting!;},change:(patch:Partial<Session>)=>{meeting={...meeting!,...patch};},remove:()=>{meeting=null;},setGenerate:(callback:()=>Promise<string>)=>{generation=callback;} };
}
test('validates exact evidence, distinguishes inference and refuses relative invented dates', () => {
 const f=fixture();const suggestions=validateTaskSuggestions(f.meeting,JSON.stringify({suggestions:f.raw}));
 expect(suggestions[0]).toMatchObject({kind:'explicit',assignee:'Ana',dueDate:'2026-10-09',evidence:[{segmentIndex:0,speaker:'Ana',start:0,end:3,quote:f.raw[0].evidence[0].quote}]});
 expect(suggestions[1]).toMatchObject({kind:'inferred',dueDate:null,dateReview:'next Friday'});
 expect(()=>validateTaskSuggestions(f.meeting,JSON.stringify({suggestions:[{...f.raw[0],evidence:[{segmentIndex:0,quote:'invented'}]}]}))).toThrow('Invalid task evidence');
 expect(()=>validateTaskSuggestions(f.meeting,JSON.stringify({suggestions:[{...f.raw[0],evidence:[{segmentIndex:99,quote:'invented'}]}]}))).toThrow('Invalid task evidence');
});
test('accepts selected suggestions only and survives retries and two tabs after restart', async () => {
 const f=fixture();await f.service.tick();const before=f.service.snapshot('m');
 expect(before.tasks).toHaveLength(0);expect(before.review?.suggestions).toHaveLength(2);
 const suggestion=before.review!.suggestions[0];const item={suggestionId:suggestion.id,title:'Edited report',description:'User reviewed',assignee:null,dueDate:null};
 f.service.accept('m',before.review!.sourceRevision,[item]);
 const second=new MeetingTasksService(f.options);second.accept('m',before.review!.sourceRevision,[item]);
 const after=second.snapshot('m');expect(after.tasks).toHaveLength(1);expect(after.tasks[0]).toMatchObject({title:'Edited report',dueDate:null,status:'open',completedAt:null,sessionId:'m'});
 expect(after.review?.suggestions.find(s=>s.id===suggestion.id)?.state).toBe('accepted');
});
test('accepting none is valid and dismissal does not create tasks', async () => {
 const f=fixture();await f.service.tick();const review=f.service.snapshot('m').review!;
 f.service.accept('m',review.sourceRevision,[]);f.service.dismiss('m',review.sourceRevision,[review.suggestions[0].id]);
 expect(f.service.snapshot('m').tasks).toHaveLength(0);expect(f.service.snapshot('m').review!.suggestions[0].state).toBe('dismissed');
 expect(()=>f.service.accept('m',review.sourceRevision,[{suggestionId:review.suggestions[0].id,title:'x',description:'',assignee:null,dueDate:null}])).toThrow('Suggestion no longer available');
});
test('dates and completion can be cleared independently with revision protection', async () => {
 const f=fixture();await f.service.tick();const review=f.service.snapshot('m').review!;
 f.service.accept('m',review.sourceRevision,[{suggestionId:review.suggestions[0].id,...review.suggestions[0]}]);let task=f.service.snapshot().tasks[0];
 task=f.service.update(task.id,task.revision,{status:'completed',dueDate:null});expect(task.completedAt).toBe('2026-10-05T12:30:00.000Z');expect(task.dueDate).toBeNull();
 expect(()=>f.service.update(task.id,'old',{title:'Overwrite'})).toThrow('Task changed');
 task=f.service.update(task.id,task.revision,{status:'open',dueDate:'2026-11-01'});expect(task.completedAt).toBeNull();expect(task.dueDate).toBe('2026-11-01');
 expect(()=>f.service.update(task.id,task.revision,{dueDate:'2026-02-30'})).toThrow('Invalid task date');
});
test('accepted tasks persist through transcript regeneration, source deletion and task deletion retries',async()=>{
 const f=fixture();await f.service.tick();const review=f.service.snapshot('m').review!;const item={suggestionId:review.suggestions[0].id,...review.suggestions[0]};
 f.service.accept('m',review.sourceRevision,[item]);const accepted=f.service.snapshot().tasks[0];
 f.change({aiNotes:'Regenerated notes'});expect(f.service.snapshot().tasks[0].title).toBe(accepted.title);
 f.change({transcript:'Changed',segments:[{speaker:'Ana',start:0,end:3,text:'Changed'}]});expect(f.service.snapshot().tasks[0].sourceState).toBe('transcript-changed');
 f.remove();expect(f.service.snapshot().tasks[0]).toMatchObject({sourceState:'meeting-deleted',audioAvailable:false});
 const restored=new MeetingTasksService(f.options);expect(restored.snapshot().tasks).toHaveLength(1);restored.delete(accepted.id,accepted.revision);expect(restored.snapshot().tasks).toHaveLength(0);
});
test('generation failures are durable and retryable; zero tasks is a completed result',async()=>{
 const f=fixture();f.setGenerate(async()=>{throw new Error('model-missing');});await f.service.tick();expect(f.service.snapshot('m').review).toMatchObject({status:'failed',error:'model-missing'});
 f.setGenerate(async()=>JSON.stringify({suggestions:[]}));f.service.retry('m');await f.service.tick();expect(f.service.snapshot('m').review).toMatchObject({status:'ready',suggestions:[]});
});
test('stale generation and two concurrent ticks cannot publish outdated suggestions',async()=>{
 const f=fixture();let finish!:(value:string)=>void;let calls=0;
 f.setGenerate(()=>{calls++;return new Promise(resolve=>{finish=resolve;});});const running=f.service.tick();await Promise.resolve();await f.service.tick();expect(calls).toBe(1);
 f.change({transcript:'Changed',segments:[{speaker:'Ana',start:0,end:3,text:'Changed'}]});finish(JSON.stringify({suggestions:f.raw}));await running;
 expect(f.service.snapshot('m').review?.sourceRevision).not.toBe(sourceRevision(f.meeting));expect(f.service.snapshot('m').review?.status).toBe('superseded');
});
test('persistence failure leaves acceptance atomic and retriable',async()=>{
 const f=fixture();await f.service.tick();const review=f.service.snapshot('m').review!;const initial=readFileSync(f.options.path,'utf8');
 const blocked=new MeetingTasksService({...f.options,write:()=>{throw new Error('Disk full');}});
 expect(()=>blocked.accept('m',review.sourceRevision,[{suggestionId:review.suggestions[0].id,...review.suggestions[0]}])).toThrow('Disk full');
 expect(readFileSync(f.options.path,'utf8')).toBe(initial);expect(f.service.snapshot().tasks).toHaveLength(0);
});
test('a malformed persisted store is surfaced without silently overwriting it',()=>{
 const f=fixture();mkdirSync(f.options.path);expect(()=>f.service.snapshot()).toThrow();
});
test('acceptance tombstones survive transcript A-B-A and deleted tasks stay deleted',async()=>{
 const f=fixture();const original=structuredClone(f.meeting);await f.service.tick();const review=f.service.snapshot('m').review!;
 const item={suggestionId:review.suggestions[0].id,...review.suggestions[0]};f.service.accept('m',review.sourceRevision,[item]);const accepted=f.service.snapshot().tasks[0];f.service.delete(accepted.id,accepted.revision);
 f.change({transcript:'Changed',segments:[{speaker:'Ana',start:0,end:3,text:'Changed'}]});f.setGenerate(async()=>JSON.stringify({suggestions:[]}));await f.service.tick();
 f.change(original);f.setGenerate(async()=>JSON.stringify({suggestions:f.raw}));await f.service.tick();f.service.accept('m',review.sourceRevision,[item]);
 expect(f.service.snapshot().tasks).toHaveLength(0);expect(f.service.snapshot('m').review!.suggestions[0].state).toBe('accepted');
});
test.each([
 ['en','I will send it on October 9, 2026.','October 9, 2026'],
 ['pt','Vou enviar em 9 de outubro de 2026.','9 de outubro de 2026'],
 ['fr','Je vais envoyer le 9 octobre 2026.','9 octobre 2026'],
 ['de','Ich sende es am 9. Oktober 2026.','9. Oktober 2026'],
])('validates an explicit spoken calendar date in %s',(language,quote,dateQuote)=>{
 const f=fixture();f.change({language,transcript:quote,segments:[{speaker:'Ana',start:0,end:2,text:quote}]});
 const output={suggestions:[{title:'Send report',description:'',kind:'explicit',assignee:null,dueDate:'2026-10-09',dateQuote,evidence:[{segmentIndex:0,quote}]}]};
 expect(validateTaskSuggestions(f.meeting,JSON.stringify(output))[0].dueDate).toBe('2026-10-09');
});
test('duplicate mentions become one suggestion with both sources and ambiguous numeric dates remain unset',()=>{
 const f=fixture();const first={...f.raw[0],dueDate:'2026-06-05',dateQuote:'05/06/2026'};
 const quoted='I will send the report on 05/06/2026.';f.change({transcript:quoted,segments:[{speaker:'Ana',start:0,end:3,text:quoted},{speaker:'Ben',start:4,end:7,text:quoted}]});
 first.evidence=[{segmentIndex:0,quote:quoted}];const second={...first,evidence:[{segmentIndex:1,quote:quoted}]};
 const suggestions=validateTaskSuggestions(f.meeting,JSON.stringify({suggestions:[first,second]}));expect(suggestions).toHaveLength(1);expect(suggestions[0].evidence).toHaveLength(2);expect(suggestions[0]).toMatchObject({dueDate:null,dateReview:'05/06/2026'});
});
