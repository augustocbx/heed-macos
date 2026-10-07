import type {AiProviderId} from '../../../shared/types/ai';
import type {AiCategoryPrices, AiPreset, AiPriceSnapshot} from '../../../shared/types/ai-cost';
import {modelCapabilities} from './model-metadata';

export const AI_PRICE_VERIFIED_AT = '2026-10-07';
const prices = (input: number, cached: number | null, write: number | null, output: number): AiCategoryPrices =>
 ({inputTokens: input, cachedInputTokens: cached, cacheWriteTokens: write, outputTokens: output, reasoningTokens: null});
const urls = {
 openai: ['https://developers.openai.com/api/docs/pricing', 'https://developers.openai.com/api/docs/guides/your-data', 'https://developers.openai.com/api/docs/models/gpt-6-luna.md', 'https://developers.openai.com/api/docs/guides/reasoning'],
 anthropic: ['https://platform.claude.com/docs/en/about-claude/pricing', 'https://platform.claude.com/docs/en/manage-claude/api-and-data-retention', 'https://platform.claude.com/docs/en/models/haiku-4-5/overview', 'https://platform.claude.com/docs/en/build-with-claude/thinking'],
 deepseek: ['https://api-docs.deepseek.com/quick_start/pricing/', 'https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html', 'https://api-docs.deepseek.com/quick_start/pricing/', 'https://api-docs.deepseek.com/api/create-chat-completion'],
 xai: ['https://docs.x.ai/developers/pricing', 'https://docs.x.ai/developers/faq/security', 'https://docs.x.ai/developers/models/grok-4.3.md', 'https://docs.x.ai/developers/rest-api-reference/inference/responses.md'],
} as const;

function hosted(provider: keyof typeof urls, model: string, categories: AiCategoryPrices): AiPriceSnapshot {
 const [sourceUrl, dataUrl, modelUrl, usageUrl] = urls[provider];
 const capabilities = modelCapabilities(provider, model);
 if (!capabilities) throw new Error('Catalog model lacks reviewed adapter metadata');
 return {provider, model, currency: 'USD', verifiedAt: AI_PRICE_VERIFIED_AT, sourceUrl, dataUrl, modelUrl, usageUrl, categories,
  capabilities, pricingScope: 'direct-standard-default', cacheWritePossible: provider === 'openai',
  usageSemantics: provider === 'xai' ? 'unqualified' : 'normalized-subsets', contextTiers: [], premiums: [], additionalCharges: [],
  limitations: ['Prices exclude taxes and negotiated terms.', 'Complete hosted token fit is not locally proven.', 'Declared context bounds accepted input only; submitted/rejected-input billing coverage is unqualified.', 'Account access, quota, balance, credits and actual rate limits are unknown.']};
}
const luna = hosted('openai', 'gpt-6-luna', prices(100_000, 10_000, 125_000, 500_000));
// Official Markdown explicitly documents this separate ceiling; reserve full context conservatively.
luna.maxInputTokens = 922_000;
luna.contextTiers = [
 {id: 'short', minInputTokens: 0, maxInputTokens: 272_000, categories: luna.categories},
 {id: 'long', minInputTokens: 272_001, maxInputTokens: 1_050_000, categories: prices(200_000, 20_000, 250_000, 750_000)},
];
luna.premiums = [
 {id: 'fast', numerator: 2, denominator: 1, applicable: false, condition: 'Only Fast processing; current adapter requests direct Standard/default.'},
 {id: 'regional-or-fedramp', numerator: 11, denominator: 10, applicable: false, condition: 'Only eligible regional/FedRAMP processing; current endpoint is the default.'},
];
const haiku = hosted('anthropic', 'claude-haiku-4-5-20251001', prices(1_000_000, 100_000, 2_000_000, 5_000_000));
haiku.limitations.push('Cache writes: 5-minute TTL costs 1.25 USD/MTok, 1-hour TTL costs 2 USD/MTok; unqualified TTL uses the larger rate.', 'Current direct Haiku adapter sends no explicit cache control or inference geography; partner-region/Claude 4.6+ premiums do not apply.');
const flash = hosted('deepseek', 'deepseek-flash', prices(300_000, 6_000, null, 1_200_000));
const pro = hosted('deepseek', 'deepseek-v4-pro', prices(1_320_000, 44_000, null, 3_960_000));
for (const s of [flash, pro]) s.limitations.push('Reserve peak rates across uncertain dispatch: Monday–Friday 01:00–04:00 and 06:00–10:00 UTC, excluding Chinese holidays; off-peak costs half.', 'The current adapter inherits thinking-on; completion cap includes reasoning.', 'Model IDs map to the published current model version, not an immutable older snapshot.');
const grok = hosted('xai', 'grok-4.3', prices(1_250_000, 200_000, null, 2_500_000));
grok.contextTiers = [
 {id: 'short', minInputTokens: 0, maxInputTokens: 199_999, categories: grok.categories},
 {id: 'long', minInputTokens: 200_000, maxInputTokens: 1_000_000, categories: prices(2_500_000, 400_000, null, 5_000_000)},
];
grok.premiums = [{id: 'priority', numerator: 2, denominator: 1, applicable: false, condition: 'Only requests served at priority; current adapter requests default.'}];
grok.additionalCharges = [{id: 'responses-guideline-rejection', boundMicroUsd: 50_000, applicable: true, condition: 'Responses guideline violations caught before generation incur 0.05 USD per request; generation violations are still charged.'}];
grok.limitations.push('Visible-output cap excludes reasoning/function calls; total billable output remains unknown.', 'US regional endpoint currently supports Grok 4.7/4.6 only, not this model.', 'Token-usage overlap is not universally qualified; prefer validated provider-reported cost_in_usd_ticks, separate from invoice.');
const snapshots = [luna, haiku, flash, pro, grok];

/** Detached metadata must be bound to the exact plan/pricing review by the admission layer. */
export function priceSnapshot(provider: AiProviderId, model: string): AiPriceSnapshot | null {
 const found = snapshots.find(s => s.provider === provider && s.model === model);
 return found ? structuredClone(found) : null;
}

export function aiPresets(): AiPreset[] {
 const local: AiPreset = {id: 'local-qwen3-4b', provider: 'ollama', model: 'qwen3:4b', access: 'local', features: ['notes', 'tasks', 'chat', 'library-chat'],
  capabilities: null, price: null, verifiedAt: AI_PRICE_VERIFIED_AT, sourceUrl: 'https://ollama.com/library/qwen3:4b', dataUrl: 'https://docs.ollama.com/faq', apiCharges: 'zero', consumerSubscriptionProvidesApiCredit: false,
  offers: [], limitations: ['Requires an installed local model and live local capability validation.', 'Adequacy, measured memory and EN/PT quality qualification are pending issue #67; no universal quality recommendation.', 'Zero API charges does not mean zero device resources.'],
  dataHandling: ['Inference remains on the protected local Ollama transport.'], rateLimits: ['Limited by device resources; no provider API quota.'],
  optimizations: {hostedCacheEnabled: false, batchEnabled: false, evaluation: ['Hosted caching/batching do not apply to local inference.']}};
 const remote = snapshots.map((price): AiPreset => ({id: `${price.provider}-${price.model}`, provider: price.provider, model: price.model, access: 'paid',
  features: [...price.capabilities.features], capabilities: price.capabilities, price, verifiedAt: price.verifiedAt, sourceUrl: price.sourceUrl, dataUrl: price.dataUrl,
  apiCharges: 'paid-rates', consumerSubscriptionProvidesApiCredit: false, offers: [], limitations: [...price.limitations, 'Consumer chat subscriptions do not establish API entitlement.'],
  dataHandling: [], rateLimits: ['Published limits depend on account, project, model, region and tier; actual access/rate limits remain unknown.'],
  optimizations: {hostedCacheEnabled: false, batchEnabled: false, evaluation: ['Do not assume cache hits; reserve cold applicable rates.', 'Explicit hosted cache controls are disabled: source retention/TTL and repeat-prefix benefit need separate review.', 'Batch is disabled: delayed completion and source revisions do not justify changing the current interactive transport.', 'Do not enlarge source scope to seek discounts.']}}));
 for (const p of remote) {
  if (p.provider === 'openai') {
   p.dataHandling = ['Default API data is not used for training unless explicitly opted in.', 'Abuse logs may retain content up to 30 days with exceptions; store:false does not eliminate them.'];
   p.offers = [{kind: 'free-quota', accountEligibility: 'unknown', sourceUrl: 'https://help.openai.com/en/articles/10306912-sharing-feedback-evaluation-and-fine-tuning-data-and-api-inputs-and-outputs-with-openai', verifiedAt: AI_PRICE_VERIFIED_AT, dataSharingRequired: true,
    quota: {period: 'daily', reset: '00:00 UTC', sharedAcrossModels: true, buildTokens: 250_000, launchGrowTokens: 1_000_000},
    conditions: ['Eligible Build/Launch/Grow organizations only; owner enrollment and a positive balance are required.', 'Only shared traffic on enabled projects; tools, evals, training and fine-tuned models are excluded.', 'Sharing may train/improve models; do not submit sensitive, confidential or proprietary data.', 'Enterprise/ZDR cannot enroll; program may end on 30 days notice.', 'If one request exceeds remaining quota, the entire request is paid.', 'Account eligibility, enrollment and remaining allowance are unknown; reserve full paid rates.']}];
  } else if (p.provider === 'anthropic') {
   p.dataHandling = ['Retained API data is not trained on without express permission.', 'API documentation states no default conversation retention except Covered Models; commercial terms describe deletion within 30 days with exceptions. Do not promise zero retention for an uninspected account.', 'Commercial retention source: https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data'];
   p.offers = [{kind: 'promotional-credit', accountEligibility: 'unknown', sourceUrl: p.sourceUrl, verifiedAt: AI_PRICE_VERIFIED_AT, dataSharingRequired: false, conditions: ['Introductory credits for some new users are not recurring quota.', 'Amount, expiry and this account entitlement are unknown; reserve paid rates.']}];
  } else if (p.provider === 'deepseek') {
   p.dataHandling = ['Published privacy policy permits improvement/training and storage in China.', 'API-specific no-training assurance, fixed retention and account exceptions remain unknown.'];
   p.offers = [{kind: 'promotional-credit', accountEligibility: 'unknown', sourceUrl: p.sourceUrl, verifiedAt: AI_PRICE_VERIFIED_AT, dataSharingRequired: false, conditions: ['Granted balance is used before purchased balance; no grant to this account is established.', 'Amount, expiry and eligibility are unknown; no recurring quota was qualified; reserve paid rates.']}];
  } else p.dataHandling = ['API data is not trained on without permission; encrypted audit retention is normally 30 days.', 'store:false disables Responses state storage, not audit retention; ZDR requires a separate arrangement.'];
 }
 return structuredClone([local, ...remote]);
}
