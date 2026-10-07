import type {AiBudget} from './budget';
import type {AiAttemptOutcome} from '../../../shared/types/ai-budget';
import type {AiCapabilities,AiFeature,AiResult,AiSelection} from '../../../shared/types/ai';
import type {AiAdapterRequest} from './contracts';
import {getAiAdapter} from './adapters';
import type {AiConnections} from './connections';
import {AiPlanError,aiBudgetMetadata,aiErrorCode,type AiJobPlan,type AiPlanner} from './planning';
import type {AiAuthorizations} from './authorization';
/** No text, source excerpts, credentials or opaque credential references enter admission/accounting. */
export interface AiAdmissionSummary {
 planId:string;jobId:string;feature:AiFeature;selection:AiSelection;payloadHash:string;
 calls:Array<{id:string;inputBytes:number;contextTokens:number;maxOutputTokens:number}>;
 capabilities?:AiCapabilities;allowUnknownCost:boolean;
}
export interface AiReservation {
 /** Persist the liability before network dispatch. A crash after this hook is uncertain. */
 dispatch:(callId:string)=>Promise<void>;
 outcome:(callId:string,result:AiAttemptOutcome)=>Promise<void>;
 assertCurrent?:()=>void;
 /** Release only known-unsubmitted calls; dispatched unknown outcomes retain liability. */
 finish:(status:'completed'|'unsubmitted'|'uncertain')=>Promise<void>;
}
export interface AiAdmissionHooks {
 reserve?:(summary:AiAdmissionSummary)=>Promise<AiReservation>;
 acquire?:(summary:AiAdmissionSummary,signal:AbortSignal)=>Promise<{release:()=>void|Promise<void>}>;
}
interface Options {planner:AiPlanner;authorizations:AiAuthorizations;connections:AiConnections;budget?:AiBudget;hooks?:AiAdmissionHooks;generate?:(input:AiAdapterRequest)=>Promise<AiResult>;}
export class AiRuntime {
 private active=false;
 constructor(private options:Options){}
 async execute(plan:AiJobPlan,signal:AbortSignal):Promise<AiResult[]>{
  const {planner,authorizations,connections,hooks}=this.options;authorizations.assert(plan);
  if(this.active)throw new AiPlanError('resources-busy');this.active=true;
  const remote=plan.selection.provider!=='ollama';let reservation:AiReservation|undefined,lease:Awaited<ReturnType<NonNullable<AiAdmissionHooks['acquire']>>>|undefined,dispatched=false,completed=false;
  const controller=new AbortController(),abort=()=>controller.abort();signal.addEventListener('abort',abort,{once:true});
  const unsubscribe=connections.subscribe(()=>controller.abort());
  const check=()=>{if(signal.aborted||controller.signal.aborted)throw new AiPlanError('cancelled');planner.assertCurrent(plan);reservation?.assertCurrent?.();};
  try{
   const metadata=aiBudgetMetadata(plan);
   const summary:AiAdmissionSummary={...metadata,calls:metadata.calls.map(call=>({...call})),...authorizations.decision(plan)};
   check();if(remote){
    if(this.options.budget){
     if(!plan.costReview)throw new AiPlanError('budget-review-changed');
     const budget=this.options.budget,receipt=budget.reserve(aiBudgetMetadata(plan),plan.costReview,{planId:plan.id,expectedPayloadHash:plan.payloadHash,reviewIdentity:plan.costReview.identity,allowUnknownCost:summary.allowUnknownCost});
     const attempt=(callId:string)=>{const value=receipt.attempts.find(a=>a.callId===callId&&a.round===receipt.attempts[0]?.round);if(!value)throw new AiPlanError('attempt-not-reserved');return value.id;};
     reservation={assertCurrent:()=>budget.assertCurrent(receipt.id),dispatch:async callId=>budget.dispatch(receipt.id,callId,attempt(callId)),outcome:async(callId,outcome)=>budget.settle(attempt(callId),outcome),finish:async()=>budget.cancelUnsubmitted(receipt.id)};
    }else{if(!hooks?.reserve)throw new AiPlanError('budget-unavailable');reservation=await hooks.reserve(structuredClone(summary));}
   }check();
   if(remote&&!hooks?.acquire)throw new AiPlanError('resources-unavailable');
   lease=await hooks?.acquire?.(structuredClone(summary),controller.signal);check();
   // Key retrieval happens only after explicit consent and whole-job admission.
   const resolved=await connections.resolve(plan.selection);check();connections.assertCurrent(resolved.checkpoint);
   authorizations.consume(plan);const results:AiResult[]=[];
   for(const call of plan.calls){
    check();planner.dispatched(plan);dispatched=true;await reservation?.dispatch(call.id);check();
    let result:AiResult;
    try{
     result=await (this.options.generate??(input=>getAiAdapter(input.selection.provider).generate(input)))({...resolved,call,signal:controller.signal});
    }catch(error){await reservation?.outcome(call.id,{status:outcomeStatus(error,controller.signal.aborted)});throw error;}
    await reservation?.outcome(call.id,{status:controller.signal.aborted?'cancelled':'completed',usage:result.usage,reportedCharge:result.reportedCharge});check();results.push(result);
   }
   check();completed=true;return results;
  }finally{
   try{await reservation?.finish(completed?'completed':dispatched?'uncertain':'unsubmitted');}finally{try{await lease?.release();}finally{unsubscribe();signal.removeEventListener('abort',abort);this.active=false;}}
  }
 }
 /** Legacy jobs still use their installed-model callbacks, while sharing optional resource/concurrency admission. */
 async local<T>(feature:AiFeature,model:string,signal:AbortSignal,generate:()=>Promise<T>):Promise<T>{
  if(this.active)throw new AiPlanError('resources-busy');this.active=true;let lease:Awaited<ReturnType<NonNullable<AiAdmissionHooks['acquire']>>>|undefined;
  try{if(signal.aborted)throw new AiPlanError('cancelled');lease=await this.options.hooks?.acquire?.({planId:'legacy-local',jobId:'legacy-local',feature,selection:{provider:'ollama',connectionId:null,model},payloadHash:'',calls:[],allowUnknownCost:false},signal);if(signal.aborted)throw new AiPlanError('cancelled');return await generate();}
  finally{try{await lease?.release();}finally{this.active=false;}}
 }
}

function outcomeStatus(error:unknown,cancelled:boolean):AiAttemptOutcome['status'] {
 const code=aiErrorCode(error);return cancelled||code==='cancelled'?'cancelled':code==='provider-timeout'?'timeout':code==='rate-limited'?'rate-limited':['request-rejected','invalid-output','incomplete-output'].includes(code??'')?'rejected':'uncertain';
}
