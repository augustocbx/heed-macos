import type {AiUsage,AiUsageCategory} from '../../../shared/types/ai';
import type {AiPriceSnapshot} from '../../../shared/types/ai-cost';
import type {AiAttemptAccounting,AiAttemptOutcome,AiReportedCharge} from '../../../shared/types/ai-budget';
import {estimateAiUsage} from './cost';
const safe=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
const categories:AiUsageCategory[]=['inputTokens','cachedInputTokens','cacheWriteTokens','outputTokens','reasoningTokens'];
/** https://docs.x.ai/developers/cost-tracking: 10^10 ticks/USD, hence 10^4 ticks/micro-USD.
 * JSON numbers outside the safe integer range have already lost precision and are rejected.
 */
export function parseXaiCharge(value:unknown):AiReportedCharge|null {
 if(!safe(value))return null;
 return {basis:'provider-reported-request-charge',provider:'xai',currency:'USD',source:'cost_in_usd_ticks',ticks:String(value),amountMicroUsd:Number((BigInt(value)+9999n)/10000n)};
}
/** Allowlisted counts only; malformed or contradictory evidence is never repaired into zero usage. */
export function accountAiOutcome(outcome:AiAttemptOutcome,price:AiPriceSnapshot|null,now:number):AiAttemptAccounting {
 const uncertainty:string[]=[],usage:AiUsage|null=outcome.usage?{supported:outcome.usage.supported===true}:null;
 if(usage){
  for(const category of categories){const value=outcome.usage![category];if(value!==undefined){if(safe(value))usage[category]=value;else uncertainty.push('invalid-usage');}}
  if(usage.inputTokens===undefined||usage.outputTokens===undefined||BigInt(usage.cachedInputTokens??0)+BigInt(usage.cacheWriteTokens??0)>BigInt(usage.inputTokens??0)||(usage.reasoningTokens??0)>(usage.outputTokens??0))uncertainty.push('missing-or-contradictory-usage');
  if(price&&((usage.inputTokens??0)>price.capabilities.contextTokens||price.capabilities.billableOutputBound==='max-output'&&(usage.outputTokens??0)>price.capabilities.maxOutputTokens||price.capabilities.billableOutputBound==='model-limit'&&price.capabilities.maxBillableOutputTokens!==undefined&&(usage.outputTokens??0)>price.capabilities.maxBillableOutputTokens))uncertainty.push('usage-exceeds-model-capability');
  if(uncertainty.length)usage.supported=false;
 }else uncertainty.push('missing-usage');
 let reportedCharge:AiReportedCharge|null=null;
 if(outcome.reportedCharge){
  const value=outcome.reportedCharge;
  const parsed=/^(0|[1-9][0-9]{0,15})$/.test(value.ticks)?parseXaiCharge(Number(value.ticks)):null;
  if(price?.provider==='xai'&&parsed&&JSON.stringify(parsed)===JSON.stringify({basis:value.basis,provider:value.provider,currency:value.currency,source:value.source,ticks:value.ticks,amountMicroUsd:value.amountMicroUsd}))reportedCharge=parsed;
  else uncertainty.push('invalid-reported-charge');
 }
 const tokenEstimate=estimateAiUsage(usage?{...usage,supported:outcome.usage?.supported===true}: {supported:false},price,now);
 // Token estimates do not qualify a whole-attempt bill. A request charge is separate evidence.
 if(!reportedCharge)uncertainty.push('whole-attempt-charge-unknown');
 if(outcome.status!=='completed')uncertainty.push('attempt-outcome-uncertain');
 if(usage&&!usage.supported)uncertainty.push('unsupported-usage');
 return {usage,tokenEstimate,reportedCharge,uncertainty:[...new Set(uncertainty)]};
}
