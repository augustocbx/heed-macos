import {describe, expect, test} from 'bun:test';
import {aiPresets, priceSnapshot} from './catalog';
import {estimateAiPlan, estimateAiUsage} from './cost';
import {modelCapabilities} from './model-metadata';
import type {AiCostPlan, AiPriceSnapshot} from '../../../shared/types/ai-cost';

const now = Date.parse('2026-10-07T12:00:00Z');
function plan(provider: AiCostPlan['selection']['provider'] = 'openai', model = 'gpt-6-luna', count = 1): AiCostPlan {
 return {feature: 'notes', selection: {provider, model, connectionId: null}, capabilities: modelCapabilities(provider, model) ?? undefined,
  calls: Array.from({length: count}, (_, i) => ({id: `call-${i}`, system: 'Summarize precisely. JSON.', data: {text: 'ação 日本語 👩🏽‍💻'}, schema: {type: 'object', properties: {answer: {type: 'string'}}}, contextTokens: 8192, maxOutputTokens: 1000}))};
}
function snapshot(provider: AiCostPlan['selection']['provider'] = 'openai', model = 'gpt-6-luna'): AiPriceSnapshot {
 return priceSnapshot(provider, model)!;
}

describe('conservative plan cost', () => {
 test('complete multilingual system/data/schema bytes are disclosed without pretending bytes prove hosted token fit', () => {
  const p = plan(), result = estimateAiPlan(p, snapshot(), now), call = result.calls[0]!;
  expect(call.controlledInputBytes).toBe(Buffer.byteLength(p.calls[0]!.system) + Buffer.byteLength(JSON.stringify(p.calls[0]!.data)) + Buffer.byteLength(JSON.stringify(p.calls[0]!.schema)));
  expect(call.fit).toBe('not-proven');
  expect(call.inputTokensBound).toBe(1_050_000);
  expect(call.inputBasis).toBe('accepted-declared-context');
  expect(result.status).toBe('unknown');
  expect(result.wholeAttemptBoundMicroUsd).toBeNull();
  expect(result.uncertainty).toContain('submitted-or-rejected-input-billing-unbounded');
  expect(result.knownComponentsMicroUsd).toBe(263_250);
 });
 test('includes all four calls and each bounded authorized attempt', () => {
  const p = {...plan('openai', 'gpt-6-luna', 4), feature: 'chat' as const, attempts: 3};
  const result = estimateAiPlan(p, snapshot(), now);
  expect(result.calls).toHaveLength(4);
  expect(result.knownComponentsMicroUsd).toBe(263_250 * 4 * 3);
  expect(result.attempts).toBe(3);
 });
 test('text-free runtime metadata estimates the same reviewed components without unsafe casts or retained text', () => {
  const p = plan();
  const metadata = {...p, calls: p.calls.map(c => ({id: c.id, inputBytes: Buffer.byteLength(c.system) + Buffer.byteLength(JSON.stringify(c.data)) + Buffer.byteLength(JSON.stringify(c.schema ?? {})), contextTokens: c.contextTokens, maxOutputTokens: c.maxOutputTokens}))};
  const result = estimateAiPlan(metadata, snapshot(), now);
  expect(result.knownComponentsMicroUsd).toBe(estimateAiPlan(p, snapshot(), now).knownComponentsMicroUsd);
  expect(result.uncertainty).toContain('byte-partitions-rely-on-reviewed-plan');
  expect(JSON.stringify(result)).not.toContain('Summarize precisely');
 });
 test('cold automatic cache write and long context use worst applicable rates, never an assumed hit', () => {
  const call = estimateAiPlan(plan(), snapshot(), now).calls[0]!;
  expect(call.categories.map(c => [c.category, c.rateMicroUsdPerMillion])).toEqual([['cacheWriteTokens', 250_000], ['outputTokens', 750_000]]);
  expect(call.categories[0]!.tokens).toBe(1_050_000);
 });
 test('DeepSeek reserves peak across uncertain dispatch time with thinking included in total completion', () => {
  const result = estimateAiPlan(plan('deepseek', 'deepseek-flash'), snapshot('deepseek', 'deepseek-flash'), now);
  expect(result.knownComponentsMicroUsd).toBe(301_200);
  expect(result.calls[0]!.categories[1]!.tokens).toBe(1000);
 });
 test('only explicitly applicable premiums stack; inactive regional/Fast discounts never change current direct Standard price', () => {
  const s = snapshot();
  expect(estimateAiPlan(plan(), s, now).knownComponentsMicroUsd).toBe(263_250);
  const applicable = structuredClone(s);
  applicable.premiums.forEach(p => {p.applicable = true;});
  expect(estimateAiPlan(plan(), applicable, now).knownComponentsMicroUsd).toBe(579_150);
 });
 test('xAI keeps billable reasoning unknown while retaining finite input/visible-output components', () => {
  const result = estimateAiPlan(plan('xai', 'grok-4.3'), snapshot('xai', 'grok-4.3'), now);
  expect(result.status).toBe('unknown');
  expect(result.calls[0]!.outputTokensBound).toBeNull();
  expect(result.knownComponentsMicroUsd).toBe(2_555_000);
  expect(result.uncertainty).toContain('billable-output-unbounded');
 });
 test('missing prices or required category prices stay unknown while finite other components remain visible', () => {
  expect(estimateAiPlan(plan(), null, now).knownComponentsMicroUsd).toBeNull();
  const s = snapshot(); s.categories.outputTokens = null; s.contextTiers.forEach(t => {t.categories.outputTokens = null;});
  const result = estimateAiPlan(plan(), s, now);
  expect(result.status).toBe('unknown');
  expect(result.knownComponentsMicroUsd).toBe(262_500);
  expect(result.uncertainty).toContain('unsupported-price-category');
 });
 test('over 30 days is stale, invalid/future verification is unknown, and stale prices never become a whole-attempt guarantee', () => {
  expect(estimateAiPlan(plan(), snapshot(), now + 30 * 86400000).priceStatus).toBe('stale');
  expect(estimateAiPlan(plan(), snapshot(), Date.parse('2026-11-06T00:00:00Z')).priceStatus).toBe('current');
  const s = snapshot(); s.verifiedAt = 'invalid';
  expect(estimateAiPlan(plan(), s, now).priceStatus).toBe('unknown');
  expect(estimateAiPlan(plan(), snapshot(), now - 86400000).priceStatus).toBe('unknown');
 });
 test('oversize bytes and known output/context contradictions reject without shortening consented input', () => {
  const p = plan(); p.calls[0]!.data = 'a'.repeat(65536);
  const before = JSON.stringify(p);
  expect(estimateAiPlan(p, snapshot(), now).admissibility).toBe('blocked');
  expect(JSON.stringify(p)).toBe(before);
  const overflow = plan(); overflow.calls[0]!.maxOutputTokens = 128001;
  expect(estimateAiPlan(overflow, snapshot(), now).calls[0]!.fit).toBe('known-exceeds');
  const context = plan(); context.calls[0]!.contextTokens = 1050001;
  expect(estimateAiPlan(context, snapshot(), now).admissibility).toBe('blocked');
 });
 test('unsafe arithmetic, mismatched model metadata, invalid attempts, and empty plans fail closed', () => {
  const s = snapshot(); s.categories.cacheWriteTokens = Number.MAX_SAFE_INTEGER; s.contextTiers.forEach(t => {t.categories.cacheWriteTokens = Number.MAX_SAFE_INTEGER;});
  expect(estimateAiPlan(plan(), s, now).uncertainty).toContain('cost-overflow');
  expect(estimateAiPlan(plan(), s, now).admissibility).toBe('blocked');
  expect(estimateAiPlan(plan(), snapshot('deepseek', 'deepseek-flash'), now).admissibility).toBe('blocked');
  expect(estimateAiPlan({...plan(), attempts: 0}, snapshot(), now).admissibility).toBe('blocked');
  expect(estimateAiPlan({...plan(), calls: []}, snapshot(), now).admissibility).toBe('blocked');
 });
 test('local API charges are zero, independent of token proof and device resources', () => {
  const result = estimateAiPlan(plan('ollama', 'qwen3:4b'), null, now);
  expect(result.status).toBe('known');
  expect(result.wholeAttemptBoundMicroUsd).toBe(0);
  expect(result.uncertainty).toContain('device-resources-not-estimated');
 });
});

describe('normalized provider usage estimates', () => {
 test('cache/write are exclusive input partitions and reasoning is an output subset', () => {
  const result = estimateAiUsage({supported: true, inputTokens: 100, cachedInputTokens: 40, cacheWriteTokens: 10, outputTokens: 20, reasoningTokens: 15}, snapshot(), now);
  expect(result.amountMicroUsd).toBe(18); // 50 ordinary + 40 cached + 10 writes + 20 total output; ceil each category.
  expect(result.basis).toBe('estimated-from-provider-token-counts');
 });
 test('Anthropic normalized total is split once, with no first-party Haiku geography premium', () => {
  const result = estimateAiUsage({supported: true, inputTokens: 100, cachedInputTokens: 40, cacheWriteTokens: 10, outputTokens: 20}, snapshot('anthropic', 'claude-haiku-4-5-20251001'), now);
  expect(result.amountMicroUsd).toBe(174); // worst supported write TTL: 50 + 4 + 20 + 100.
 });
 test('missing/contradictory/unsupported categories and stale price leave token cost unresolved', () => {
  expect(estimateAiUsage({supported: false, inputTokens: 10}, snapshot(), now).amountMicroUsd).toBeNull();
  expect(estimateAiUsage({supported: true, inputTokens: 10, cachedInputTokens: 11, outputTokens: 1}, snapshot(), now).amountMicroUsd).toBeNull();
  expect(estimateAiUsage({supported: true, inputTokens: 10, outputTokens: 1, reasoningTokens: 2}, snapshot(), now).amountMicroUsd).toBeNull();
  expect(estimateAiUsage({supported: true, inputTokens: 10, outputTokens: 1}, snapshot('xai', 'grok-4.3'), now).amountMicroUsd).toBeNull();
  expect(estimateAiUsage({supported: true, inputTokens: 10, outputTokens: 1}, snapshot(), now + 31 * 86400000).amountMicroUsd).toBeNull();
 });
 test('rounds fractional micro-USD upward, including every tiny category', () => {
  expect(estimateAiUsage({supported: true, inputTokens: 1, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 1}, snapshot(), now).amountMicroUsd).toBe(2);
 });
});

test('catalog keeps API entitlements unknown, recurring sharing offer separate from paid Luna, and optimizations disabled', () => {
 const presets = aiPresets();
 expect(presets[0]!.access).toBe('local');
 const luna = presets.find(p => p.model === 'gpt-6-luna')!;
 expect(luna.access).toBe('paid');
 expect(luna.consumerSubscriptionProvidesApiCredit).toBe(false);
 expect(luna.offers[0]!.kind).toBe('free-quota');
 expect(luna.offers[0]!.accountEligibility).toBe('unknown');
 expect(luna.offers[0]!.dataSharingRequired).toBe(true);
 expect(presets.every(p => p.optimizations.batchEnabled === false && p.optimizations.hostedCacheEnabled === false)).toBe(true);
 expect(presets.some(p => p.model.includes('gemini'))).toBe(false);
 expect(priceSnapshot('openai', 'invented-model')).toBeNull();
 // Callers cannot mutate the process-wide metadata used by later reviews.
 luna.price!.categories.inputTokens = 0;
 expect(priceSnapshot('openai', 'gpt-6-luna')!.categories.inputTokens).toBe(100_000);
});
