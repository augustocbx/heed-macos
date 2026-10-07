import { chatText, complete, prepareRemote, record, usage, type AiAdapter } from '../contracts';
import { requestJson, validateRemoteEndpoint } from '../transport';
/** Custom OpenAI Chat Completions wire contract; capabilities require explicit declaration. */
export const compatibleAdapter: AiAdapter = { async generate(input) {
 const data = prepareRemote(input, 'compatible', 'schema'); validateRemoteEndpoint(input.endpoint, 'compatible');
 const format = input.call.schema ? input.capabilities!.structuredOutput === 'schema' ? { type: 'json_schema', json_schema: { name: 'heed_result', schema: input.call.schema, strict: true } } : { type: 'json_object' } : { type: 'text' };
 const body = record(await requestJson({ ...input, headers: { 'content-type': 'application/json', authorization: `Bearer ${input.key}` }, body: { model: input.selection.model, messages: [{ role: 'system', content: input.call.system }, { role: 'user', content: data }], max_tokens: input.call.maxOutputTokens, stream: false, response_format: format } }));
 const counts = body.usage ?? {};
 return complete(input, chatText(body), usage(input, { inputTokens: counts.prompt_tokens, cachedInputTokens: counts.prompt_tokens_details?.cached_tokens, cacheWriteTokens: counts.prompt_tokens_details?.cache_write_tokens, outputTokens: counts.completion_tokens, reasoningTokens: counts.completion_tokens_details?.reasoning_tokens }));
} };
