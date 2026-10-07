import { chatText, complete, prepareRemote, record, usage, type AiAdapter } from '../contracts';
import { requestJson, validateRemoteEndpoint } from '../transport';
/** DeepSeek JSON Output is validated JSON, not a native JSON Schema promise. */
export const deepseekAdapter: AiAdapter = { async generate(input) {
 const data = prepareRemote(input, 'deepseek', 'validated-json'); validateRemoteEndpoint(input.endpoint, 'deepseek');
 const body = record(await requestJson({ ...input, maxRequestBytes:input.call.maxRequestBytes, headers: { 'content-type': 'application/json', authorization: `Bearer ${input.key}` }, body: { model: input.selection.model, messages: [{ role: 'system', content: input.call.system }, { role: 'user', content: data }], max_tokens: input.call.maxOutputTokens, stream: false, ...(input.call.schema ? { response_format: { type: 'json_object' } } : {}) } }));
 const counts = body.usage ?? {};
 return complete(input, chatText(body), usage(input, { inputTokens: counts.prompt_tokens, cachedInputTokens: counts.prompt_cache_hit_tokens, outputTokens: counts.completion_tokens, reasoningTokens: counts.completion_tokens_details?.reasoning_tokens }));
} };
