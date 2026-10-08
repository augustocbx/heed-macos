import type {AiUsage, AiUsageCategory} from '../../../shared/types/ai';
import type {AiCallCostEstimate, AiCategoryPrices, AiCostCategoryAssumption, AiCostEstimate, AiCostMetadataPlan, AiCostPlan, AiPriceSnapshot, AiPriceStatus, AiUsageCostEstimate} from '../../../shared/types/ai-cost';
import {AI_INPUT_BYTES, AI_SCHEMA_BYTES, validateCallBytes} from './limits';

const safe = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
const unique = (values: string[]) => [...new Set(values)];
const maximum = BigInt(Number.MAX_SAFE_INTEGER);
function bounded(value: bigint): number {
 if (value < 0n || value > maximum) throw new Error('cost-overflow');
 return Number(value);
}
function sum(values: number[]): number {return bounded(values.reduce((total, n) => total + BigInt(n), 0n));}
export function aiPriceStatus(snapshot: AiPriceSnapshot | null, now: number): AiPriceStatus {
 if (!snapshot || !safe(now) || !/^\d{4}-\d{2}-\d{2}$/.test(snapshot.verifiedAt)) return 'unknown';
 const date = Date.parse(`${snapshot.verifiedAt}T00:00:00Z`);
 if (!Number.isFinite(date) || new Date(date).toISOString().slice(0, 10) !== snapshot.verifiedAt || date > now) return 'unknown';
 return now - date > 30 * 86400000 ? 'stale' : 'current';
}
/** Ceil once after exact integer token/rate/premium multiplication, separately per category. */
function category(snapshot: AiPriceSnapshot, name: AiUsageCategory, tokens: number, rate: number | null): AiCostCategoryAssumption {
 if (!safe(tokens) || !safe(rate)) throw new Error('unsupported-price-category');
 let numerator = BigInt(tokens) * BigInt(rate), denominator = 1_000_000n;
 for (const premium of snapshot.premiums) {
  if (!premium.applicable) continue;
  if (!safe(premium.numerator) || !safe(premium.denominator) || premium.denominator === 0 || premium.numerator < premium.denominator) throw new Error('unsupported-price-premium');
  numerator *= BigInt(premium.numerator); denominator *= BigInt(premium.denominator);
 }
 return {category: name, tokens, rateMicroUsdPerMillion: rate, boundMicroUsd: bounded((numerator + denominator - 1n) / denominator)};
}
function failure(error: unknown): string {return error instanceof Error ? error.message : 'unsupported-price-category';}
/** Context intervals apply to the entire request. An upper bound alone can span multiple tiers. */
function rates(snapshot: AiPriceSnapshot, input: number, exact = false): AiCategoryPrices {
 if (!snapshot.contextTiers.length) return snapshot.categories;
 const tiers = snapshot.contextTiers.filter(t => {
  if (!safe(t.minInputTokens) || !safe(t.maxInputTokens) || t.maxInputTokens < t.minInputTokens) throw new Error('unsupported-context-tier');
  return exact ? input >= t.minInputTokens && input <= t.maxInputTokens : t.minInputTokens <= input;
 });
 if (!tiers.length || !tiers.some(t => input <= t.maxInputTokens)) throw new Error('unsupported-context-tier');
 const result = {...snapshot.categories};
 for (const name of Object.keys(result) as AiUsageCategory[]) {
  const values = tiers.map(t => t.categories[name]);
  result[name] = values.every(safe) ? Math.max(...values) : null;
 }
 return result;
}
type CostPlan = AiCostPlan | AiCostMetadataPlan;
function callEstimate(call: CostPlan['calls'][number], plan: CostPlan, snapshot: AiPriceSnapshot): AiCallCostEstimate {
 const result: AiCallCostEstimate = {callId: call.id, controlledInputBytes: null, fit: 'not-proven', inputBasis: 'accepted-declared-context', inputTokensBound: null,
  outputTokensBound: null, categories: [], knownComponentsMicroUsd: null, conditionalAcceptedBoundMicroUsd: null, uncertainty: ['hosted-token-fit-not-proven', 'submitted-or-rejected-input-billing-unbounded']};
 let valid = true;
 try {
  if ('inputBytes' in call) {
   const inputLimit = ['chat', 'library-chat'].includes(plan.feature) ? 5500 : AI_INPUT_BYTES;
   if (!safe(call.inputBytes) || call.inputBytes > inputLimit + AI_SCHEMA_BYTES) throw new Error('invalid-input-bytes');
   result.controlledInputBytes = call.inputBytes;
   result.uncertainty.push('byte-partitions-rely-on-reviewed-plan');
  } else {
   validateCallBytes(call, plan.feature);
   result.controlledInputBytes = Buffer.byteLength(call.system) + Buffer.byteLength(JSON.stringify(call.data)) + Buffer.byteLength(JSON.stringify(call.schema ?? {}));
  }
 } catch {result.uncertainty.push('invalid-or-oversize-controlled-input'); valid = false;}
 const caps = snapshot.capabilities;
 if (!safe(call.contextTokens) || call.contextTokens === 0 || !safe(call.maxOutputTokens) || call.maxOutputTokens === 0 ||
  !safe(caps.contextTokens) || caps.contextTokens === 0 || !safe(caps.maxOutputTokens) || caps.maxOutputTokens === 0 ||
  call.contextTokens > caps.contextTokens || call.maxOutputTokens > caps.maxOutputTokens ||
  !caps.features.includes(plan.feature) || 'schema' in call && call.schema && caps.structuredOutput === 'none') {
  result.fit = 'known-exceeds'; result.uncertainty.push('invalid-or-exceeded-model-limit'); valid = false;
 }
 if (plan.capabilities && (plan.capabilities.contextTokens !== caps.contextTokens || plan.capabilities.maxOutputTokens !== caps.maxOutputTokens ||
  plan.capabilities.billableOutputBound !== caps.billableOutputBound || plan.capabilities.maxBillableOutputTokens !== caps.maxBillableOutputTokens ||
  plan.capabilities.structuredOutput !== caps.structuredOutput || plan.capabilities.streaming !== caps.streaming ||
  !plan.capabilities.features.includes(plan.feature) || [...plan.capabilities.usageCategories].sort().join(',') !== [...caps.usageCategories].sort().join(','))) {
  result.uncertainty.push('capability-snapshot-mismatch'); valid = false;
 }
 if (!valid) return result;
 // No hosted tokenizer/framing proof is qualified. Heed's 8192 declaration is not a wire-enforced hosted cap.
 result.inputTokensBound = caps.contextTokens;
 if (caps.billableOutputBound === 'max-output') result.outputTokensBound = call.maxOutputTokens;
 else if (caps.billableOutputBound === 'model-limit' && safe(caps.maxBillableOutputTokens)) result.outputTokensBound = caps.maxBillableOutputTokens;
 else result.uncertainty.push('billable-output-unbounded');
 let complete = result.outputTokensBound !== null;
 const amounts: number[] = [];
 try {
  const r = rates(snapshot, caps.contextTokens);
  const inputCandidates: Array<{name: AiUsageCategory; rate: number | null}> = [{name: 'inputTokens', rate: r.inputTokens}];
  if (snapshot.cacheWritePossible) inputCandidates.push({name: 'cacheWriteTokens', rate: r.cacheWriteTokens});
  if (inputCandidates.some(c => !safe(c.rate))) {complete = false; result.uncertainty.push('unsupported-price-category');}
  else {
   const highest = inputCandidates.reduce((a, b) => a.rate! >= b.rate! ? a : b);
   result.categories.push(category(snapshot, highest.name, caps.contextTokens, highest.rate));
  }
  // Even an unbounded reasoning request has a finite visible-output component to retain.
  result.categories.push(category(snapshot, 'outputTokens', result.outputTokensBound ?? call.maxOutputTokens, r.outputTokens));
 } catch (error) {complete = false; result.uncertainty.push(failure(error));}
 amounts.push(...result.categories.map(c => c.boundMicroUsd));
 for (const charge of snapshot.additionalCharges) if (charge.applicable) {
  if (!safe(charge.boundMicroUsd)) {complete = false; result.uncertainty.push('unsupported-additional-charge');}
  else amounts.push(charge.boundMicroUsd);
 }
 try {
  if (amounts.length) result.knownComponentsMicroUsd = sum(amounts);
  if (complete) result.conditionalAcceptedBoundMicroUsd = result.knownComponentsMicroUsd;
 } catch (error) {result.uncertainty.push(failure(error));}
 result.uncertainty = unique(result.uncertainty);
 return result;
}

/** Pure, content-free result; estimates neither upload text nor authorize/reserve an attempt. */
export function estimateAiPlan(plan: CostPlan, snapshot: AiPriceSnapshot | null, now = Date.now()): AiCostEstimate {
 const attempts = plan.attempts ?? 1;
 const result: AiCostEstimate = {status: 'unknown', priceStatus: aiPriceStatus(snapshot, now), currency: 'USD', admissibility: 'eligible-for-policy-review', attempts,
  knownComponentsMicroUsd: null, conditionalAcceptedBoundMicroUsd: null, wholeAttemptBoundMicroUsd: null, calls: [], uncertainty: []};
 if (!safe(attempts) || attempts < 1 || attempts > 3 || !plan.calls.length || plan.calls.length > (['notes', 'tasks'].includes(plan.feature) ? 1 : 4) || new Set(plan.calls.map(c => c.id)).size !== plan.calls.length || plan.calls.some(c => !c.id)) {
  result.admissibility = 'blocked'; result.uncertainty.push('invalid-plan'); return result;
 }
 if (plan.selection.provider === 'ollama') {
  result.status = 'known'; result.priceStatus = 'current'; result.knownComponentsMicroUsd = 0; result.conditionalAcceptedBoundMicroUsd = 0; result.wholeAttemptBoundMicroUsd = 0;
  result.uncertainty = ['device-resources-not-estimated']; return result;
 }
 if (!snapshot) {result.uncertainty.push('missing-price-snapshot'); return result;}
 if (snapshot.provider !== plan.selection.provider || snapshot.model !== plan.selection.model || snapshot.currency !== 'USD' || snapshot.pricingScope !== 'direct-standard-default') {
  result.admissibility = 'blocked'; result.uncertainty.push('price-snapshot-mismatch'); return result;
 }
 if (result.priceStatus !== 'current') result.uncertainty.push(result.priceStatus === 'stale' ? 'stale-price-snapshot' : 'unverified-price-date');
 result.calls = plan.calls.map(call => callEstimate(call, plan, snapshot));
 result.uncertainty.push(...result.calls.flatMap(c => c.uncertainty));
 if (result.calls.some(c => c.fit === 'known-exceeds' || c.uncertainty.includes('invalid-or-oversize-controlled-input') || c.uncertainty.includes('capability-snapshot-mismatch'))) result.admissibility = 'blocked';
 try {
  const amounts = result.calls.flatMap(c => c.knownComponentsMicroUsd === null ? [] : [c.knownComponentsMicroUsd]);
  if (amounts.length) result.knownComponentsMicroUsd = bounded(BigInt(sum(amounts)) * BigInt(attempts));
  if (result.calls.every(c => c.conditionalAcceptedBoundMicroUsd !== null)) result.conditionalAcceptedBoundMicroUsd = result.knownComponentsMicroUsd;
 } catch (error) {result.uncertainty.push(failure(error));}
 result.status = result.priceStatus === 'stale' ? 'stale' : 'unknown';
 result.uncertainty = unique(result.uncertainty);
 // A numeric overflow is a known amount beyond the representable policy range, not an exception loophole.
 if (result.uncertainty.includes('cost-overflow')) result.admissibility = 'blocked';
 return result;
}

/** AiUsage has already normalized vendor-specific overlap. This is not a reported charge or invoice. */
export function estimateAiUsage(usage: AiUsage, snapshot: AiPriceSnapshot | null, now = Date.now()): AiUsageCostEstimate {
 const result: AiUsageCostEstimate = {status: 'unknown', amountMicroUsd: null, basis: 'estimated-from-provider-token-counts', categories: [], uncertainty: []};
 const priceStatus = aiPriceStatus(snapshot, now);
 if (!snapshot || priceStatus !== 'current' || snapshot.usageSemantics !== 'normalized-subsets' || !usage.supported) {
  result.status = priceStatus === 'stale' ? 'stale' : 'unknown'; result.uncertainty.push('unqualified-price-or-usage'); return result;
 }
 const input = usage.inputTokens, output = usage.outputTokens;
 const cached = usage.cachedInputTokens, written = usage.cacheWriteTokens;
 if (!safe(input) || !safe(output) || (snapshot.categories.cachedInputTokens !== null && !safe(cached)) ||
  (snapshot.categories.cacheWriteTokens !== null && !safe(written)) || cached !== undefined && !safe(cached) || written !== undefined && !safe(written) ||
  BigInt(cached ?? 0) + BigInt(written ?? 0) > BigInt(input) || usage.reasoningTokens !== undefined && (!safe(usage.reasoningTokens) || usage.reasoningTokens > output)) {
  result.uncertainty.push('missing-or-contradictory-usage'); return result;
 }
 try {
  const r = rates(snapshot, input, true);
  const partitions: Array<[AiUsageCategory, number]> = [['inputTokens', input - (cached ?? 0) - (written ?? 0)], ['cachedInputTokens', cached ?? 0], ['cacheWriteTokens', written ?? 0], ['outputTokens', output]];
  for (const [name, tokens] of partitions) if (tokens) result.categories.push(category(snapshot, name, tokens, r[name]));
  result.amountMicroUsd = sum(result.categories.map(c => c.boundMicroUsd)); result.status = 'known';
 } catch (error) {result.uncertainty.push(failure(error));}
 return result;
}
