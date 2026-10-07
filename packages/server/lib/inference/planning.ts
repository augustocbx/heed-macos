import {createHash,randomUUID} from 'node:crypto';
import type {AiCapabilities,AiFeature,AiSelection} from '../../../shared/types/ai';
import {AiInferenceError,type AiCall} from './contracts';
import {AiConnectionError,type AiConnections,type AiConnectionCheckpoint} from './connections';
import type {AiAuthorizations} from './authorization';
import type {AiRuntime} from './runtime';
export class AiPlanError extends Error {constructor(readonly code:string){super(code);this.name='AiPlanError';}}
export function aiErrorCode(error:unknown):string|undefined{return error instanceof AiPlanError||error instanceof AiConnectionError||error instanceof AiInferenceError?error.code:undefined;}
export interface AiSourceGuard {sessionId:string;sourceRevision:string;sourceVersion?:number;expectedNotesHash?:string;}
export interface AiPlanCommand {feature:AiFeature;sessionId?:string;jobId?:string;turnId?:string;scope?:unknown;}
export interface AiJobPlan {
 id:string;jobId:string;feature:AiFeature;selection:AiSelection;calls:AiCall[];sources:AiSourceGuard[];
 settingsVersion:number;connectionGeneration:number;credentialGeneration:number;trustGeneration:number;
 payloadHash:string;expiresAt:number;capabilities?:AiCapabilities;
}
export interface AiJobDraft {
 jobId:string;feature:AiFeature;selection:AiSelection;calls:AiCall[];sources:AiSourceGuard[];
 /** Synchronous guards also run immediately before persistence. Never compare status-only thread revisions. */
 validate:()=>void;attach:(plan:AiJobPlan)=>void;dispatched:()=>void;
}
export interface AiDomainInference {planner:AiPlanner;authorizations:AiAuthorizations;runtime:AiRuntime;}
export function aiFingerprint(value:unknown):string{return createHash('sha256').update(JSON.stringify(value)??'undefined').digest('hex');}
function freeze<T>(value:T):T {if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}
export function remoteBinding(value:{ai?:{selection:AiSelection}}):boolean{return !!value.ai&&value.ai.selection.provider!=='ollama';}
/** Exact plaintext exists only in this short-lived process memory, never an authorization/accounting file. */
export class AiPlanner {
 private entries=new Map<string,{plan:AiJobPlan;draft:AiJobDraft;timer:ReturnType<typeof setTimeout>}>();
 private preparers=new Map<AiFeature,(command:AiPlanCommand)=>Promise<AiJobDraft>>();
 constructor(readonly connections:AiConnections,private now:()=>number=Date.now){}
 selection(feature:AiFeature,localModel:string):AiSelection {const snapshot=this.connections.snapshot();if(snapshot.unavailable)throw new AiPlanError('settings-recovery');const selection=snapshot.selections[feature];return structuredClone({...selection,model:selection.model??localModel});}
 register(feature:AiFeature,prepare:(command:AiPlanCommand)=>Promise<AiJobDraft>):void{this.preparers.set(feature,prepare);}
 async prepare(command:AiPlanCommand):Promise<AiJobPlan>{
  if(!command||!this.preparers.has(command.feature))throw new AiPlanError('invalid-command');
  const draft=await this.preparers.get(command.feature)!(structuredClone(command));
  const snapshot=this.connections.snapshot(),connection=snapshot.connections.find(c=>c.id===draft.selection.connectionId);
  if(snapshot.unavailable)throw new AiPlanError('settings-recovery');
  if(draft.feature!==command.feature)throw new AiPlanError('invalid-command');
  const configured=snapshot.selections[draft.feature];
  if(configured.provider!==draft.selection.provider||configured.connectionId!==draft.selection.connectionId||configured.model!==null&&configured.model!==draft.selection.model)throw new AiPlanError('settings-changed');
  if(draft.selection.provider!=='ollama'){
   if(!connection||connection.provider!==draft.selection.provider||connection.model!==draft.selection.model||connection.validation!=='validated')throw new AiPlanError('connection-unvalidated');
   if(!connection.capabilities?.features.includes(draft.feature))throw new AiPlanError('unsupported-capability');
  }
  if(!draft.selection.model||draft.calls.length>(['notes','tasks'].includes(draft.feature)?1:4)||new Set(draft.calls.map(call=>call.id)).size!==draft.calls.length||draft.calls.some(c=>!c.id||!c.system||!Number.isSafeInteger(c.contextTokens)||c.contextTokens<=0||!Number.isSafeInteger(c.maxOutputTokens)||c.maxOutputTokens<=0))throw new AiPlanError('invalid-plan');
  for(const call of draft.calls){if(connection?.capabilities&&(call.contextTokens>connection.capabilities.contextTokens||call.maxOutputTokens>connection.capabilities.maxOutputTokens||call.schema&&connection.capabilities.structuredOutput==='none'))throw new AiPlanError('unsupported-capability');}
  const content={jobId:draft.jobId,feature:draft.feature,selection:draft.selection,calls:draft.calls,sources:draft.sources,settingsVersion:snapshot.version,connectionGeneration:connection?.connectionGeneration??0,credentialGeneration:connection?.credentialGeneration??0,trustGeneration:connection?.trustVersion??0,...(connection?.capabilities?{capabilities:connection.capabilities}:{})};
  const plan=freeze(structuredClone({...content,id:randomUUID(),expiresAt:this.now()+600000,payloadHash:aiFingerprint(content)}));
  draft.validate();
  // A second preview replaces the same command's old review, never its durable job.
  for(const [id,entry] of this.entries)if(entry.plan.expiresAt<=this.now()||entry.plan.jobId===plan.jobId&&entry.plan.feature===plan.feature)this.forget(id);
  draft.attach(plan);const id=plan.id,timer=setTimeout(()=>this.forget(id),600000);timer.unref();this.entries.set(id,{plan,draft,timer});return plan;
 }
 private forget(id:string):void{const entry=this.entries.get(id);if(entry)clearTimeout(entry.timer);this.entries.delete(id);}
 get(id:string):AiJobPlan{const entry=this.entries.get(id);if(!entry)throw new AiPlanError('plan-not-found');if(entry.plan.expiresAt<=this.now()){this.forget(id);throw new AiPlanError('authorization-expired');}return entry.plan;}
 checkpoint(plan:AiJobPlan):AiConnectionCheckpoint{return {settingsVersion:plan.settingsVersion,connectionId:plan.selection.connectionId,connectionGeneration:plan.connectionGeneration,credentialGeneration:plan.credentialGeneration,trustVersion:plan.trustGeneration};}
 assertCurrent(plan:AiJobPlan):void {
  if(this.get(plan.id)!==plan)throw new AiPlanError('payload-changed');
  if(this.now()>=plan.expiresAt)throw new AiPlanError('authorization-expired');
  this.connections.assertCurrent(this.checkpoint(plan));this.entries.get(plan.id)!.draft.validate();
 }
 dispatched(plan:AiJobPlan):void{this.assertCurrent(plan);this.entries.get(plan.id)!.draft.dispatched();}
}
