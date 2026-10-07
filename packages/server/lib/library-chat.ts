import type { AiWaitingReason } from "@heed/shared";
import {randomUUID} from 'node:crypto';
import {existsSync,lstatSync,mkdirSync,readdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tagKey,uniqueTags,type Session,type LibraryChatScope,type LibraryChatPreview,type LibraryChatSnapshot,type LibraryChatThread,type LibraryChatContext,type LibraryChatTurn,type ChatCommand,type ChatAnswer} from '@heed/shared';
import {atomicWriteJson} from './atomic-json';
import {notesHash,sourceRevision} from './automatic-notes';
import {answerMeetingQuestion,transcriptEvidence,ChatError,type ChatGenerator} from './meeting-chat';

export function normalizeChatScope(value:unknown):LibraryChatScope {
 const scope=value as LibraryChatScope;
 if(!scope||!['labels','all'].includes(scope.mode)||!['any','all'].includes(scope.match)||!Array.isArray(scope.labels)||scope.labels.length>50||scope.labels.some(label=>typeof label!=='string'||label.length>200))throw new ChatError('invalid-scope');
 const labels=[...new Set(scope.labels.map(tagKey).filter(Boolean))].sort();
 if(scope.mode==='all'&&labels.length)throw new ChatError('invalid-scope');
 return {mode:scope.mode,labels,match:scope.mode==='all'?'any':scope.match};
}
const scopeId=(scope:LibraryChatScope)=>notesHash(JSON.stringify(scope));
interface Options {directory:string;listSessions:()=>Session[];isBusy:()=>boolean;waitingReason?:()=>AiWaitingReason;generate:ChatGenerator;write?:typeof atomicWriteJson;}

/** Selection filtering precedes evidence extraction, history selection and generation. */
export class LibraryChatService {
 private active?:{id:string;turnId:string;attempt:number;controller:AbortController;done:Promise<void>};
 constructor(private options:Options){
  mkdirSync(options.directory,{recursive:true});
  for(const file of readdirSync(options.directory).filter(file=>file.endsWith('.json'))){const thread=this.read(file.slice(0,-5));let changed=false;for(const turn of thread.turns)if(turn.status==='waiting'||turn.status==='running'){turn.status='failed';turn.reason='interrupted';changed=true;}if(changed)this.save(thread);}
 }
 preview(value:LibraryChatScope):LibraryChatPreview {
  const scope=normalizeChatScope(value);const sessions=this.options.listSessions();
  const matching=scope.mode==='labels'&&!scope.labels.length?[]:sessions.filter(session=>{
   if(scope.mode==='all')return true;const tags=new Set((session.tags||[]).map(tagKey));return scope.match==='all'?scope.labels.every(label=>tags.has(label)):scope.labels.some(label=>tags.has(label));
  });
  const eligible=matching.filter(session=>session.transcriptFinalized&&(session.segments?.length?session.segments.some(segment=>segment.text.trim()):session.transcript?.trim()));
  const sources=eligible.map(session=>({sessionId:session.id,title:session.title,tags:uniqueTags(session.tags||[]).sort(),sourceRevision:sourceRevision(session)})).sort((a,b)=>a.sessionId.localeCompare(b.sessionId));
  const snapshot={key:notesHash(JSON.stringify({scope,sources})),scope,sources};
  return {snapshot,ready:sources.length>0,matchingCount:matching.length,unavailableCount:matching.length-eligible.length,availableLabels:uniqueTags(sessions.flatMap(session=>session.tags||[])).sort()};
 }
 private path(id:string){if(!/^[a-f0-9]{64}$/.test(id))throw new ChatError('invalid-chat-file',500);const path=join(this.options.directory,`${id}.json`);if(existsSync(path)&&!lstatSync(path).isFile())throw new ChatError('invalid-chat-file',500);return path;}
 private read(id:string,scope?:LibraryChatScope):LibraryChatThread{
  const path=this.path(id);if(!existsSync(path)){if(!scope)throw new ChatError('invalid-chat-file',500);return {id,revision:'empty',scope,turns:[]};}
  const thread=JSON.parse(readFileSync(path,'utf8')) as LibraryChatThread;
  if(!thread||thread.id!==id||scopeId(normalizeChatScope(thread.scope))!==id||typeof thread.revision!=='string'||!Array.isArray(thread.turns)||thread.turns.some(turn=>!turn.snapshot||turn.sourceRevision!==turn.snapshot.key||!Array.isArray(turn.snapshot.sources)))throw new ChatError('invalid-chat-file',500);
  return thread;
 }
 private save(thread:LibraryChatThread){for(const turn of thread.turns)delete turn.waitingReason;thread.revision=randomUUID();(this.options.write||atomicWriteJson)(this.path(thread.id),thread);return thread;}
 get(value:LibraryChatScope):LibraryChatContext{
  const preview=this.preview(value);const thread=this.read(scopeId(preview.snapshot.scope),preview.snapshot.scope);let changed=false;
  for(const turn of thread.turns){
   if(turn.status==='running'&&!(this.active?.id===thread.id&&this.active.turnId===turn.id)){turn.status='failed';turn.reason='interrupted';changed=true;}
   if((turn.status==='waiting'||turn.status==='running')&&turn.snapshot.key!==preview.snapshot.key){turn.status='failed';turn.reason='scope-changed';changed=true;if(this.active?.id===thread.id&&this.active.turnId===turn.id)this.active.controller.abort();}
  }
  if(changed)this.save(thread);
  return {preview,thread:{...thread,turns:thread.turns.map(turn=>({...turn,stale:turn.snapshot.key!==preview.snapshot.key,waitingReason:turn.status==='waiting'?this.options.waitingReason?.():undefined}))}};
 }
 get busy(){return !!this.active;}
 get pending():boolean{return readdirSync(this.options.directory).filter(file=>file.endsWith('.json')).some(file=>this.read(file.slice(0,-5)).turns.some(turn=>turn.status==='waiting'));}
 command(value:LibraryChatScope,command:ChatCommand):LibraryChatThread{
  const {preview,thread}=this.get(value);if(!command||typeof command!=='object')throw new ChatError('invalid-command');
  if(command.action==='clear'){
   if(command.expectedThreadRevision!==thread.revision)throw new ChatError('history-changed',409);
   const saved=this.save({...thread,turns:[]});if(this.active?.id===thread.id)this.active.controller.abort();return saved;
  }
  if(command.action==='send'){
   if(typeof command.requestId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(command.requestId)||typeof command.question!=='string'||!command.question.trim()||command.question.length>2000||typeof command.model!=='string'||!command.model.trim()||command.model.length>200)throw new ChatError('invalid-question');
   const duplicate=thread.turns.find(turn=>turn.requestId===command.requestId);if(duplicate){if(duplicate.question!==command.question.trim()||(duplicate.initialModel||duplicate.model)!==command.model)throw new ChatError('request-conflict',409);return thread;}
   if(!preview.ready)throw new ChatError('scope-empty',409);
   if(command.expectedSourceRevision!==preview.snapshot.key)throw new ChatError('scope-changed',409);
   if(command.expectedThreadRevision!==undefined&&command.expectedThreadRevision!==thread.revision)throw new ChatError('history-changed',409);
   if(thread.turns.length>=200)throw new ChatError('history-full',409);
   const now=new Date().toISOString();thread.turns.push({id:randomUUID(),requestId:command.requestId,question:command.question.trim(),model:command.model,initialModel:command.model,sourceRevision:preview.snapshot.key,snapshot:structuredClone(preview.snapshot),status:'waiting',createdAt:now,updatedAt:now,attempts:0});
  }else if(command.action==='cancel'||command.action==='retry'){
   const turn=thread.turns.find(turn=>turn.id===command.turnId);if(!turn)throw new ChatError('turn-not-found',404);
   if(command.action==='cancel'){if(!['waiting','running'].includes(turn.status))return thread;turn.status='cancelled';turn.reason='cancelled';}
   else{
    if(!['failed','cancelled'].includes(turn.status))throw new ChatError('turn-not-retryable',409);
    if(!preview.ready)throw new ChatError('scope-empty',409);
    if(turn.snapshot.key!==preview.snapshot.key)throw new ChatError('scope-changed',409);
    if(command.model!==undefined){if(typeof command.model!=='string'||!command.model.trim()||command.model.length>200)throw new ChatError('invalid-question');turn.initialModel??=turn.model;turn.model=command.model;}
    turn.status='waiting';delete turn.reason;delete turn.answer;
   }turn.updatedAt=new Date().toISOString();
  }else throw new ChatError('invalid-command');
  const saved=this.save(thread);if(command.action==='cancel'&&this.active?.id===thread.id&&this.active.turnId===command.turnId)this.active.controller.abort();void this.tick().catch(()=>{});return saved;
 }
 async preempt(){const active=this.active;if(!active)return;const thread=this.read(active.id);const turn=thread.turns.find(turn=>turn.id===active.turnId);if(turn?.status==='running'){turn.status='cancelled';turn.reason='resources-busy';this.save(thread);}active.controller.abort();await active.done;}
 private sources(snapshot:LibraryChatSnapshot):Session[]{
  if(this.preview(snapshot.scope).snapshot.key!==snapshot.key)throw new ChatError('scope-changed',409);
  const sessions=this.options.listSessions();return snapshot.sources.map(source=>{const session=sessions.find(session=>session.id===source.sessionId);if(!session||!session.transcriptFinalized||sourceRevision(session)!==source.sourceRevision)throw new ChatError('scope-changed',409);return structuredClone(session);});
 }
 source(scope:LibraryChatScope,snapshotKey:string,evidenceId:string):Session{
  const preview=this.preview(scope);if(preview.snapshot.key!==snapshotKey)throw new ChatError('scope-changed',409);
  if(typeof evidenceId!=='string'||evidenceId.length>500)throw new ChatError('invalid-evidence');
  const session=this.sources(preview.snapshot).find(session=>transcriptEvidence(session).some(evidence=>evidence.id===evidenceId));if(!session)throw new ChatError('invalid-evidence',409);return {...session,transcriptRevision:sourceRevision(session)};
 }
 async tick():Promise<void>{
  if(this.active||this.options.isBusy())return;
  for(const file of readdirSync(this.options.directory).filter(file=>file.endsWith('.json'))){
   const original=this.read(file.slice(0,-5));const {thread}=this.get(original.scope);const turn=thread.turns.find(turn=>turn.status==='waiting');if(!turn)continue;
   const sessions=this.sources(turn.snapshot);turn.status='running';turn.attempts++;turn.updatedAt=new Date().toISOString();this.save(thread);
   const controller=new AbortController();const active={id:thread.id,turnId:turn.id,attempt:turn.attempts,controller,done:Promise.resolve()};this.active=active;
   active.done=this.execute(sessions,thread,turn,controller);try{await active.done;}finally{if(this.active===active)this.active=undefined;}return;
  }
 }
 private async execute(sessions:Session[],thread:LibraryChatThread,snapshot:LibraryChatTurn,controller:AbortController){
  let answer:ChatAnswer|undefined,reason:string|undefined;
  try{
   const history=thread.turns.filter(turn=>turn.id!==snapshot.id&&turn.createdAt<=snapshot.createdAt&&turn.status==='completed'&&turn.snapshot.key===snapshot.snapshot.key).slice(-4).map(turn=>({question:turn.question,answer:turn.answer}));
   answer=await answerMeetingQuestion({sessions,question:snapshot.question,model:snapshot.model,history,signal:controller.signal,generate:async input=>{this.sources(snapshot.snapshot);const result=await this.options.generate(input);this.sources(snapshot.snapshot);return result;}});
  }catch(error){reason=error instanceof Error?error.message:'generation-failed';}
  if(controller.signal.aborted)return;
  const current=this.read(thread.id);const turn=current.turns.find(turn=>turn.id===snapshot.id);if(!turn||turn.status!=='running'||turn.attempts!==snapshot.attempts)return;
  if(this.preview(thread.scope).snapshot.key!==snapshot.snapshot.key)reason='scope-changed';
  turn.updatedAt=new Date().toISOString();if(reason){turn.status='failed';turn.reason=reason;delete turn.answer;}else{turn.status='completed';turn.answer=answer;delete turn.reason;}this.save(current);
 }
}

export async function libraryChatResponse(request:Request,service:LibraryChatService,allowed:boolean):Promise<Response|null>{
 const path=new URL(request.url).pathname;if(!['/api/library-chat/context','/api/library-chat/command','/api/library-chat/source'].includes(path))return null;
 if(!allowed)return Response.json({error:'local-only'},{status:403});if(request.method!=='POST')return new Response(null,{status:405});
 try{if(Number(request.headers.get('content-length'))>20000)throw new ChatError('invalid-command');const text=await request.text();if(text.length>20000)throw new ChatError('invalid-command');let body:any;try{body=JSON.parse(text);}catch{throw new ChatError('invalid-command');}return Response.json(path.endsWith('/context')?service.get(body?.scope):path.endsWith('/source')?service.source(body?.scope,body?.snapshotKey,body?.evidenceId):service.command(body?.scope,body?.command));}
 catch(error){return Response.json({error:error instanceof ChatError?error.message:'chat-storage-failed'},{status:error instanceof ChatError?error.status:500});}
}
