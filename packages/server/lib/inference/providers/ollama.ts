import { generateLocalStructured, generateLocalText } from '../../ollama-notes';
import { complete, fail, type AiAdapter } from '../contracts';
/** Local calls keep installed-model, loopback, metadata, unload and completion guards. */
export const ollamaAdapter: AiAdapter = { async generate(input) {
 if (input.selection.provider !== 'ollama' || !input.selection.model?.trim() || input.key) return fail('invalid-request');
 const common = { baseUrl: input.endpoint, model: input.selection.model, system: input.call.system, data: input.call.data, signal: input.signal, fetch: input.fetch, timeoutMs: input.timeoutMs, requireCompletion: true, contextTokens: input.call.contextTokens, maxOutputTokens: input.call.maxOutputTokens, onToken: input.onToken };
 const text = input.call.schema ? await generateLocalStructured({ ...common, outputSchema: input.call.schema }) : await generateLocalText(common);
 return complete(input, text, { supported: false });
} };
