import { complete, fail, prepareRemote, record, tokenCount, usage, type AiAdapter } from '../contracts';
import { requestJson, validateRemoteEndpoint } from '../transport';
function verifyNativeSchema(value: Record<string, any>): void {
 if (['minimum', 'maximum', 'minLength', 'maxLength', 'maxItems', 'uniqueItems'].some(key => value[key] !== undefined) || (value.minItems !== undefined && value.minItems !== 0 && value.minItems !== 1) || (value.type === 'object' && value.additionalProperties !== false)) return fail('unsupported-capability');
 for (const child of Object.values(value.properties ?? {})) verifyNativeSchema(child as Record<string, any>);
 if (value.items) verifyNativeSchema(value.items);
 for (const child of value.anyOf ?? []) verifyNativeSchema(child);
}
/** Native Messages API; cache components are exclusive in the wire input count. */
export const anthropicAdapter: AiAdapter = { async generate(input) {
 const data = prepareRemote(input, 'anthropic', 'schema'); validateRemoteEndpoint(input.endpoint, 'anthropic');
 if (input.call.schema && input.capabilities!.structuredOutput === 'schema') verifyNativeSchema(input.call.schema);
 const body = record(await requestJson({ ...input, maxRequestBytes:input.call.maxRequestBytes, headers: { 'content-type': 'application/json', 'x-api-key': input.key!, 'anthropic-version': '2023-06-01' }, body: { model: input.selection.model, system: input.call.system, messages: [{ role: 'user', content: data }], max_tokens: input.call.maxOutputTokens, stream: false, ...(input.call.schema && input.capabilities!.structuredOutput === 'schema' ? { output_config: { format: { type: 'json_schema', schema: input.call.schema } } } : {}) } }));
 if (body.type !== 'message' || body.role !== 'assistant' || !Array.isArray(body.content)) return fail('invalid-output');
 if (body.stop_reason !== 'end_turn') return fail('incomplete-output');
 const text = body.content.map((value: unknown) => { const block = record(value); if (block.type === 'thinking' || block.type === 'redacted_thinking') return ''; if (block.type !== 'text' || typeof block.text !== 'string') return fail('invalid-output'); return block.text; }).join('');
 const counts = body.usage ?? {}; const ordinary = tokenCount(counts.input_tokens); const cached = tokenCount(counts.cache_read_input_tokens); const written = tokenCount(counts.cache_creation_input_tokens);
 return complete(input, text, usage(input, { inputTokens: ordinary !== undefined && cached !== undefined && written !== undefined ? ordinary + cached + written : undefined, cachedInputTokens: cached, cacheWriteTokens: written, outputTokens: counts.output_tokens, reasoningTokens: counts.output_tokens_details?.thinking_tokens }));
} };
