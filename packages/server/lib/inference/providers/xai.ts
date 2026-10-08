import { complete, prepareRemote, record, responseText, tokenCount, usage, type AiAdapter } from '../contracts';
import { requestJson, validateRemoteEndpoint } from '../transport';
/** xAI Responses limits visible output only; billable reasoning bound may be unknown. */
export const xaiAdapter: AiAdapter = { async generate(input) {
 const data = prepareRemote(input, 'xai', 'schema'); validateRemoteEndpoint(input.endpoint, 'xai');
 const format = input.call.schema ? input.capabilities!.structuredOutput === 'schema' ? { type: 'json_schema', name: 'heed_result', schema: input.call.schema, strict: true } : { type: 'json_object' } : { type: 'text' };
 const body = record(await requestJson({ ...input, maxRequestBytes:input.call.maxRequestBytes, headers: { 'content-type': 'application/json', authorization: `Bearer ${input.key}` }, body: { model: input.selection.model, instructions: input.call.system, input: data, max_output_tokens: input.call.maxOutputTokens, stream: false, store: false, text: { format } } }));
 const counts = body.usage ?? {};
 const incoming = tokenCount(counts.input_tokens); const visible = tokenCount(counts.output_tokens); const reasoning = tokenCount(counts.output_tokens_details?.reasoning_tokens); const total = tokenCount(counts.total_tokens);
 // Official xAI examples vary: only a verified total relationship establishes overlap.
 let outgoing: number | undefined;
 if (incoming !== undefined && visible !== undefined && total !== undefined) {
  if (reasoning !== undefined && incoming + visible + reasoning === total) outgoing = visible + reasoning;
  else if (incoming + visible === total && (reasoning === undefined || reasoning <= visible)) outgoing = visible;
 }
 return complete(input, responseText(body), usage(input, { inputTokens: incoming, cachedInputTokens: counts.input_tokens_details?.cached_tokens, outputTokens: outgoing, reasoningTokens: reasoning }));
} };
