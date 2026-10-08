import type {AiCapabilities, AiProviderId} from '../../../shared/types/ai';

/** Verified 2026-10-07. These are buffered adapter contracts, not vendor-wide claims.
 * Official exact-model sources:
 * https://developers.openai.com/api/docs/models/gpt-6-luna
 * https://platform.claude.com/docs/en/models/haiku-4-5/overview
 * https://api-docs.deepseek.com/quick_start/pricing/
 * https://api-docs.deepseek.com/api/create-chat-completion
 * https://docs.x.ai/developers/models/grok-4.3
 * https://docs.x.ai/developers/rest-api-reference/inference/responses.md
 * Anthropic uses validated JSON for Heed's bounded schemas. xAI's visible-output
 * limit does not bound reasoning charges. DeepSeek's 1M context is conservatively
 * limited to 1,000,000 here; its numeric API output ceiling is 393,216.
 */
export const MODEL_METADATA_VERIFIED_AT = '2026-10-07';
export function modelCapabilities(provider:AiProviderId, model:string):AiCapabilities|null {
 const common:Pick<AiCapabilities,'features'|'streaming'>={features:['notes','tasks','chat','library-chat'],streaming:false};
 if(provider==='openai'&&model==='gpt-6-luna')return {...common,structuredOutput:'schema',contextTokens:1_050_000,maxOutputTokens:128_000,usageCategories:['inputTokens','cachedInputTokens','cacheWriteTokens','outputTokens','reasoningTokens'],billableOutputBound:'max-output'};
 if(provider==='anthropic'&&model==='claude-haiku-4-5-20251001')return {...common,structuredOutput:'validated-json',contextTokens:200_000,maxOutputTokens:64_000,usageCategories:['inputTokens','cachedInputTokens','cacheWriteTokens','outputTokens'],billableOutputBound:'max-output'};
 if(provider==='deepseek'&&['deepseek-flash','deepseek-v4-pro'].includes(model))return {...common,structuredOutput:'validated-json',contextTokens:1_000_000,maxOutputTokens:393_216,usageCategories:['inputTokens','cachedInputTokens','outputTokens','reasoningTokens'],billableOutputBound:'max-output'};
 if(provider==='xai'&&model==='grok-4.3')return {...common,structuredOutput:'schema',contextTokens:1_000_000,maxOutputTokens:128_000,usageCategories:['inputTokens','cachedInputTokens','outputTokens','reasoningTokens'],billableOutputBound:'unknown'};
 return null;
}
