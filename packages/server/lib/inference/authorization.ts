import type {AiAuthorizationDecision,AiPreview} from '../../../shared/types/ai';
import {AiPlanError,type AiJobPlan,type AiPlanner} from './planning';
export interface AiAuthorization {planId:string;payloadHash:string;expiresAt:number;allowUnknownCost:boolean;consumed:boolean;}
/** Deliberately ephemeral grants: process restart invalidates every unsubmitted review. */
export class AiAuthorizations {
 private grants=new Map<string,AiAuthorization>();
 constructor(private planner:AiPlanner,private now:()=>number=Date.now){}
 preview(plan:AiJobPlan):AiPreview{this.planner.assertCurrent(plan);return structuredClone({...plan,excluded:['audio','calendar','embeddings','unselected-sources'],costStatus:'unknown' as const});}
 authorize(planId:string,decision:AiAuthorizationDecision):AiAuthorization{
  for(const [id,grant] of this.grants)if(grant.expiresAt<=this.now())this.grants.delete(id);
  const plan=this.planner.get(planId);this.planner.assertCurrent(plan);
  if(!decision||decision.allowRemote!==true||decision.expectedPayloadHash!==plan.payloadHash||Object.keys(decision).some(k=>!['allowRemote','expectedPayloadHash','allowUnknownCost'].includes(k))||decision.allowUnknownCost!==undefined&&decision.allowUnknownCost!==true)throw new AiPlanError('payload-changed');
  const previous=this.grants.get(planId);if(previous?.consumed)throw new AiPlanError('authorization-consumed');
  // Admission may be awaiting a ledger/resource/key lookup. The accepted cost
  // decision cannot change underneath that operation; a change needs a new plan.
  if(previous){if(previous.allowUnknownCost!==(decision.allowUnknownCost===true))throw new AiPlanError('authorization-conflict');return {...previous};}
  const grant={planId,payloadHash:plan.payloadHash,expiresAt:plan.expiresAt,allowUnknownCost:decision.allowUnknownCost===true,consumed:false};this.grants.set(planId,grant);return {...grant};
 }
 assert(plan:AiJobPlan):void {
  this.planner.assertCurrent(plan);if(plan.selection.provider==='ollama')return;
  const grant=this.grants.get(plan.id);if(!grant)throw new AiPlanError('authorization-required');if(grant.consumed)throw new AiPlanError('authorization-consumed');if(this.now()>=grant.expiresAt)throw new AiPlanError('authorization-expired');
 }
 consume(plan:AiJobPlan):AiAuthorization|undefined {this.assert(plan);const grant=this.grants.get(plan.id);if(grant)grant.consumed=true;return grant?{...grant}:undefined;}
 decision(plan:AiJobPlan):{allowUnknownCost:boolean}{this.assert(plan);return {allowUnknownCost:this.grants.get(plan.id)?.allowUnknownCost??false};}
}
