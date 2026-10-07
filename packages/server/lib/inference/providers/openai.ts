import { complete, prepareRemote, record, responseText, usage, type AiAdapter } from '../contracts';
import { requestJson, validateRemoteEndpoint } from '../transport';
/** OpenAI Responses API: output includes billable reasoning; storage disabled. */
export const openaiAdapter: AiAdapter = { async generate(input) {
 const data = prepareRemote(input, 'openai', 'schema'); validateRemoteEndpoint(input.endpoint, 'openai');
 const format = input.call.schema ? input.capabilities!.structuredOutput === 'schema' ? { type: 'json_schema', name: 'heed_result', schema: input.call.schema, strict: true } : { type: 'json_object' } : { type: 'text' };
 const body = record(await requestJson({ ...input, headers: { 'content-type': 'application/json', authorization: `Bearer ${input.key}` }, body: { model: input.selection.model, instructions: input.call.system, input: data, max_output_tokens: input.call.maxOutputTokens, stream: false, store: false, truncation: 'disabled', text: { format } } }));
 const counts = body.usage ?? {};
 return complete(input, responseText(body), usage(input, { inputTokens: counts.input_tokens, cachedInputTokens: counts.input_tokens_details?.cached_tokens, cacheWriteTokens: counts.input_tokens_details?.cache_write_tokens, outputTokens: counts.output_tokens, reasoningTokens: counts.output_tokens_details?.reasoning_tokens }));
} };
