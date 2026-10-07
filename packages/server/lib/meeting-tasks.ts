import {AiPlanError, aiErrorCode, aiFingerprint, remoteBinding, type AiDomainInference, type AiJobDraft} from './inference/planning';
import {taskPrompt,taskResponseSchema} from './inference/prompts';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AcceptTaskInput, MeetingTask, Session, TaskEvidence, TaskFields, TaskPatch, TaskReview, TaskSuggestion, TasksSnapshot } from '../../shared/types';
import { explicitTaskDate } from './task-dates';
import { atomicWriteJson } from './atomic-json';
import { notesHash, sourceRevision } from './automatic-notes';
interface Store { version:1; tasks: MeetingTask[]; reviews: Record<string,TaskReview>; decisions:Record<string,{state:'accepted'|'dismissed';acceptedTaskId?:string}>; }
interface Options {
 path:string;
 inference?:AiDomainInference;
 getModel?:()=>string;
 listSessions:()=>Session[];
 getSession:(id:string)=>Session|null;
 generate:(session:Session,signal:AbortSignal,model?:string)=>Promise<string>;
 isBusy:()=>boolean;
 now?:()=>Date;
 write?:typeof atomicWriteJson;
}
function text(value: unknown, maximum:number, required=false):string {
 if(typeof value !== 'string' || value.length>maximum || (required&&!value.trim()))throw new Error('Invalid task text');
 return value.trim();
}
function date(value:unknown):string|null {
 if(value===null)return null;
 if(typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(`${value}T12:00:00Z`)) || new Date(`${value}T12:00:00Z`).toISOString().slice(0,10)!==value)throw new Error('Invalid task date');
 return value;
}
function fields(input:unknown):TaskFields {
 if(!input || typeof input !== 'object')throw new Error('Invalid task');
 const value=input as TaskFields;
 return {title:text(value.title,500,true),description:text(value.description,10000),assignee:value.assignee===null?null:text(value.assignee,500,true),dueDate:date(value.dueDate)};
}
export function taskSegments(session:Session) {
 return session.segments?.length ? session.segments.map((segment,segmentIndex)=>({segmentIndex,speaker:segment.speaker||'Unknown speaker',start:segment.start,end:segment.end,text:segment.text})) : [{segmentIndex:0,speaker:'Unknown speaker',start:null,end:null,text:session.transcript}];
}
/** Model claims become reviewable only after validating exact transcript references. */
export function validateTaskSuggestions(session:Session,output:string):TaskSuggestion[] {
 let decoded:any;try{decoded=JSON.parse(output);}catch{throw new Error('Invalid task output');}
 if(!Array.isArray(decoded?.suggestions)||decoded.suggestions.length>100)throw new Error('Invalid task output');
 const revision=sourceRevision(session);const segments=taskSegments(session);const unique=new Map<string,TaskSuggestion>();
 for(const candidate of decoded.suggestions){
  if(!candidate || !['explicit','inferred'].includes(candidate.kind)||!Array.isArray(candidate.evidence)||!candidate.evidence.length||candidate.evidence.length>20)throw new Error('Invalid task evidence');
  const evidence:TaskEvidence[]=candidate.evidence.map((ref:any)=>{
   const segment=Number.isInteger(ref?.segmentIndex)?segments[ref.segmentIndex]:undefined;
   if(!segment||typeof ref.quote!=='string'||!ref.quote.trim()||ref.quote.length>10000||!segment.text.includes(ref.quote))throw new Error('Invalid task evidence');
   return {segmentIndex:segment.segmentIndex,sourceRevision:revision,speaker:segment.speaker,start:Number.isFinite(segment.start)?segment.start:null,end:Number.isFinite(segment.end)?segment.end:null,quote:ref.quote};
  });
  const dateQuote=candidate.dateQuote===null||candidate.dateQuote===undefined?'':text(candidate.dateQuote,500);
  let dueDate:string|null=null;let dateReview:string|null=null;
  if(candidate.dueDate!==null&&candidate.dueDate!==undefined){
   try{const proposed=date(candidate.dueDate);if(proposed&&explicitTaskDate(dateQuote)===proposed&&evidence.some(ref=>ref.quote.includes(dateQuote)))dueDate=proposed;else dateReview=dateQuote||String(candidate.dueDate);}catch{dateReview=dateQuote||String(candidate.dueDate).slice(0,500);}
  }else if(dateQuote)dateReview=dateQuote;
  const values=fields({...candidate,dueDate,assignee:candidate.assignee??null,description:candidate.description??''});
  // Repeated mentions of the same proposed action remain a single selectable suggestion.
  const key=values.title.normalize('NFKC').toLocaleLowerCase();const existing=unique.get(key);
  if(existing){for(const ref of evidence)if(!existing.evidence.some(e=>e.segmentIndex===ref.segmentIndex&&e.quote===ref.quote))existing.evidence.push(ref);continue;}
  unique.set(key,{...values,id:`suggestion-${notesHash(`${session.id}:${revision}:${key}`).slice(0,32)}`,kind:candidate.kind,evidence,dateReview,state:'suggested'});
 }
 return [...unique.values()];
}
/** Synchronous read/modify/atomic-write transactions serialize browser tabs in one local server. */
export class MeetingTasksService {
 private active?:{sessionId:string;revision:string;attemptId:string;sourceVersion:number;controller:AbortController;done:Promise<void>};
 constructor(private readonly options:Options){mkdirSync(dirname(options.path),{recursive:true});}
 get busy():boolean{return !!this.active;}
 private now():string{return (this.options.now?.()||new Date()).toISOString();}
 private read():Store {
  if(!existsSync(this.options.path))return {version:1,tasks:[],reviews:{},decisions:{}};
  const store=JSON.parse(readFileSync(this.options.path,'utf8'));
  if(store?.version!==1||!Array.isArray(store.tasks)||!store.reviews||typeof store.reviews!=='object'||Array.isArray(store.reviews))throw new Error('Invalid task store');
  if(store.decisions!==undefined&&(!store.decisions||typeof store.decisions!=='object'||Array.isArray(store.decisions)))throw new Error('Invalid task store');
  store.decisions ||= {};
  // Migrate existing review states into independent tombstones before replacing any revision.
  for(const review of Object.values(store.reviews) as TaskReview[])for(const suggestion of review.suggestions)if(suggestion.state!=='suggested')store.decisions[suggestion.id]={state:suggestion.state,acceptedTaskId:suggestion.acceptedTaskId};
  return store;
 }
 private save(store:Store):void{(this.options.write||atomicWriteJson)(this.options.path,store);}
 private session(id:string):Session {const session=this.options.getSession(id);if(!session)throw new Error('Meeting not found');return session;}
 snapshot(sessionId?:string):TasksSnapshot {
  const store=this.read();
  return {tasks:store.tasks.filter(task=>!sessionId||task.sessionId===sessionId).map(task=>{
   const session=this.options.getSession(task.sessionId);
   return {...task,sourceState:!session?'meeting-deleted':sourceRevision(session)!==task.sourceRevision?'transcript-changed':'available',audioAvailable:!!session?.files?.wav&&existsSync(session.files.wav)};
  }),...(sessionId?{review:store.reviews[sessionId]}:{})};
 }
 private review(store:Store,id:string,revision:string):TaskReview {
  const session=this.session(id);const review=store.reviews[id];
  if(!session.transcriptFinalized||sourceRevision(session)!==revision||review?.sourceRevision!==revision||review.sourceVersion!==undefined&&review.sourceVersion!==(session.transcriptVersion??0)||review.status!=='ready')throw new Error('Task suggestions changed; reload before reviewing');
  return review;
 }
 accept(id:string,revision:string,items:AcceptTaskInput[]):TasksSnapshot {
  if(!Array.isArray(items)||items.length>100)throw new Error('Invalid task selection');
  const store=this.read();const review=this.review(store,id,revision);const meeting=this.session(id);const now=this.now();
  const seen=new Set<string>();
  for(const item of items){
   const values=fields(item);const suggestion=review.suggestions.find(s=>s.id===item.suggestionId);
   if(!suggestion||suggestion.state==='dismissed')throw new Error('Suggestion no longer available');
   if(suggestion.state==='accepted'||seen.has(suggestion.id))continue;seen.add(suggestion.id);
   const task:MeetingTask={...values,...(review.provenance?{provenance:{provider:review.provenance.provider,model:review.provenance.model}}:{}),id:randomUUID(),revision:randomUUID(),sessionId:id,meetingTitle:meeting.title,suggestionId:suggestion.id,sourceRevision:revision,evidence:suggestion.evidence,kind:suggestion.kind,status:'open',completedAt:null,createdAt:now,updatedAt:now};
   store.tasks.push(task);suggestion.state='accepted';suggestion.acceptedTaskId=task.id;store.decisions[suggestion.id]={state:'accepted',acceptedTaskId:task.id};
  }
  this.save(store);return this.snapshot(id);
 }
 dismiss(id:string,revision:string,ids:string[]):TasksSnapshot {
  if(!Array.isArray(ids)||ids.length>100||ids.some(id=>typeof id!=='string'))throw new Error('Invalid task selection');
  const store=this.read();const review=this.review(store,id,revision);
  for(const id of ids){const suggestion=review.suggestions.find(s=>s.id===id);if(!suggestion||suggestion.state==='accepted')throw new Error('Suggestion no longer available');suggestion.state='dismissed';store.decisions[suggestion.id]={state:'dismissed'};}
  this.save(store);return this.snapshot(review.sessionId);
 }
 update(id:string,revision:string,patch:TaskPatch):MeetingTask {
  if(!patch||typeof patch!=='object'||Array.isArray(patch)||Object.keys(patch).some(key=>!['title','description','assignee','dueDate','status'].includes(key)))throw new Error('Invalid task patch');
  const store=this.read();const task=store.tasks.find(t=>t.id===id);if(!task)throw new Error('Task not found');if(task.revision!==revision)throw new Error('Task changed; reload before saving');
  const values=fields({...task,...patch});if(patch.status!==undefined&&!['open','completed'].includes(patch.status))throw new Error('Invalid task status');
  Object.assign(task,values);if(patch.status&&patch.status!==task.status){task.status=patch.status;task.completedAt=patch.status==='completed'?this.now():null;}
  task.updatedAt=this.now();task.revision=randomUUID();this.save(store);return task;
 }
 delete(id:string,revision:string):void {
  const store=this.read();const task=store.tasks.find(t=>t.id===id);if(!task)return;if(task.revision!==revision)throw new Error('Task changed; reload before deleting');
  store.tasks=store.tasks.filter(t=>t.id!==id);this.save(store); // Keep acceptance tombstones: stale retries cannot recreate deleted tasks.
 }
 retry(id:string):void {
  const meeting=this.session(id);if(!meeting.transcriptFinalized)throw new Error('Final transcript required');
  const store=this.read();const old=store.reviews[id];const revision=sourceRevision(meeting);
  if(old?.sourceRevision===revision&&(old.sourceVersion===undefined||old.sourceVersion===(meeting.transcriptVersion??0))){
   if(['running','ready'].includes(old.status))return;
   const selection=this.options.inference?.planner.selection('tasks',this.options.getModel?.()??'');
   if(['queued','waiting'].includes(old.status)&&(!selection||aiFingerprint(selection)===aiFingerprint(old.ai?.selection)))return;
  }
  store.reviews[id]=this.newReview(meeting);this.save(store);
 }
 private newReview(session:Session):TaskReview {
  const review:TaskReview={sessionId:session.id,sourceRevision:sourceRevision(session),sourceVersion:session.transcriptVersion??0,attemptId:randomUUID(),status:'queued',suggestions:[],updatedAt:this.now()};
  try{const selection=this.options.inference?.planner.selection('tasks',this.options.getModel?.()??'');if(selection)review.ai={selection};}
  catch{review.status='failed';review.error='settings-recovery';}
  return review;
 }
 async prepareAi(sessionId:string):Promise<AiJobDraft>{
  const session=this.session(sessionId),review=this.read().reviews[sessionId];
  if(!this.options.inference||!review||!remoteBinding(review)||!['queued','waiting'].includes(review.status))throw new AiPlanError('job-not-reviewable');
  const selection=review.ai!.selection,attemptId=review.attemptId;
  const validate=()=>{
   const current=this.session(sessionId),live=this.read().reviews[sessionId];
   if(!live||!['queued','waiting','running'].includes(live.status)||!current.transcriptFinalized||sourceRevision(current)!==review.sourceRevision||(current.transcriptVersion??0)!==review.sourceVersion||aiFingerprint(live.ai?.selection)!==aiFingerprint(selection))throw new AiPlanError('source-changed');
   if(live.attemptId!==attemptId)throw new AiPlanError('review-invalidated');
  };
  return {jobId:`tasks:${sessionId}:${review.sourceRevision}`,feature:'tasks',selection,calls:[{id:'tasks',...taskPrompt(session.language,taskSegments(session)),schema:taskResponseSchema(),contextTokens:8192,maxOutputTokens:1800}],sources:[{sessionId,sourceRevision:review.sourceRevision,sourceVersion:review.sourceVersion}],validate,
   attach:plan=>{validate();const store=this.read();store.reviews[sessionId]!.ai={selection,planId:plan.id};this.save(store);},
   dispatched:()=>{const store=this.read();store.reviews[sessionId]!.ai!.dispatched=true;this.save(store);}};
 }
 async preempt():Promise<void>{const active=this.active;if(!active)return;active.controller.abort();await active.done;}
 async tick():Promise<void>{
  if(this.active)return;const store=this.read();let changed=false;
  for(const review of Object.values(store.reviews))if(review.status==='running'){review.status=remoteBinding(review)?'failed':'waiting';review.error=remoteBinding(review)?'remote-attempt-uncertain':'interrupted';changed=true;}
  for(const session of this.options.listSessions())if(session.transcriptFinalized&&session.transcript.trim()){
   const revision=sourceRevision(session);if(store.reviews[session.id]?.sourceRevision!==revision){store.reviews[session.id]=this.newReview(session);changed=true;}
  }
  if(changed)this.save(store);if(this.options.isBusy())return;
  const review=Object.values(store.reviews).find(candidate=>{
   if(!['queued','waiting'].includes(candidate.status))return false;
   const source=this.options.getSession(candidate.sessionId);
   if(!source||!source.transcriptFinalized||sourceRevision(source)!==candidate.sourceRevision||candidate.sourceVersion!==undefined&&candidate.sourceVersion!==(source.transcriptVersion??0)){candidate.status='superseded';this.save(store);return false;}
   if(!remoteBinding(candidate))return true;
   try{if(!candidate.ai?.planId||!this.options.inference)throw new AiPlanError('authorization-required');this.options.inference.authorizations.assert(this.options.inference.planner.get(candidate.ai.planId));return true;}
   catch(error){const reason=error instanceof AiPlanError?error.code:'review-invalidated';if(candidate.status!=='waiting'||candidate.error!==reason){candidate.status='waiting';candidate.error=reason;this.save(store);}return false;}
  });if(!review)return;
  const session=this.options.getSession(review.sessionId);if(!session||!session.transcriptFinalized||sourceRevision(session)!==review.sourceRevision||review.sourceVersion!==undefined&&review.sourceVersion!==(session.transcriptVersion??0)){review.status='superseded';this.save(store);return;}
  review.sourceVersion??=session.transcriptVersion??0;
  if(!remoteBinding(review))review.attemptId=randomUUID();review.attemptId??=randomUUID();review.status='running';delete review.error;review.updatedAt=this.now();this.save(store);
  const controller=new AbortController();const active={sessionId:session.id,revision:review.sourceRevision,attemptId:review.attemptId,sourceVersion:review.sourceVersion,controller,done:Promise.resolve()};this.active=active;
  active.done=this.execute(session,active);try{await active.done;}finally{if(this.active===active)this.active=undefined;}
 }
 private async execute(session:Session,active:{revision:string;attemptId:string;sourceVersion:number;controller:AbortController}):Promise<void>{
  let suggestions:TaskSuggestion[]|undefined;let error:string|undefined;let safeError:string|undefined;
  let provenance:import('../../shared/types/ai').AiProvenance|undefined;
  try{
   const review=this.read().reviews[session.id]!,inference=this.options.inference;
   const plan=remoteBinding(review)?inference!.planner.get(review.ai!.planId!):undefined;
   const actualModel=review.ai?.selection.model??this.options.getModel?.();
   const generate=()=>this.options.generate(session,active.controller.signal,actualModel);
   const results=plan?await inference!.runtime.execute(plan,active.controller.signal):undefined;
   const output=results?results[0]!.text:inference?await inference.runtime.local('tasks',actualModel??'',active.controller.signal,generate):await generate();
   if(plan)inference!.planner.assertCurrent(plan);provenance=results?.[0]?.provenance??(actualModel?{provider:'ollama',model:actualModel}:undefined);
   suggestions=validateTaskSuggestions(session,output);
  }catch(failure){error=(failure as Error).message;safeError=aiErrorCode(failure);}
  const store=this.read();const review=store.reviews[session.id];if(!review||review.sourceRevision!==active.revision||review.attemptId!==active.attemptId||review.status!=='running')return;
  const current=this.options.getSession(session.id);
  if(!current||!current.transcriptFinalized||sourceRevision(current)!==active.revision||(current.transcriptVersion??0)!==active.sourceVersion)review.status='superseded';
  else if(active.controller.signal.aborted){review.status=remoteBinding(review)?'failed':'waiting';review.error=remoteBinding(review)?'remote-attempt-uncertain':'interrupted';}
  else if(error){review.status='failed';review.error=safeError??(['model-missing','local-only','ollama-unavailable','incomplete-output','Invalid task output','Invalid task evidence','Invalid task text','Invalid task'].includes(error)?error:'generation-failed');}
  else{review.status='ready';if(provenance)review.provenance=provenance;review.suggestions=suggestions!.map(suggestion=>({...suggestion,...store.decisions[suggestion.id]}));delete review.error;}
  review.updatedAt=this.now();this.save(store);
 }
}
