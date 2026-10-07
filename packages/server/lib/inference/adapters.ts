import type { AiProviderId } from '../../../shared/types/ai';
import { fail, type AiAdapter, type AiAdapterRequest } from './contracts';
import { openaiAdapter } from './providers/openai';
import { anthropicAdapter } from './providers/anthropic';
import { deepseekAdapter } from './providers/deepseek';
import { xaiAdapter } from './providers/xai';
import { compatibleAdapter } from './providers/compatible';
import { ollamaAdapter } from './providers/ollama';
export { AI_ENDPOINTS } from './transport';
const adapters: Record<AiProviderId, AiAdapter> = { ollama: ollamaAdapter, openai: openaiAdapter, anthropic: anthropicAdapter, deepseek: deepseekAdapter, xai: xaiAdapter, compatible: compatibleAdapter };
function frozen<T>(value: T, seen = new WeakSet<object>()): T {
 if (value && typeof value === 'object' && !seen.has(value)) { seen.add(value); for (const child of Object.values(value)) frozen(child, seen); Object.freeze(value); }
 return value;
}
export function getAiAdapter(provider: AiProviderId): AiAdapter {
 if (!Object.hasOwn(adapters, provider)) return fail('unsupported-capability');
 return { async generate(input) {
  let snapshot: AiAdapterRequest;
  try { snapshot = Object.freeze({ ...input, ...frozen(structuredClone({ selection: input.selection, call: input.call, capabilities: input.capabilities })) }); }
  catch { return fail('invalid-request'); }
  return adapters[provider].generate(snapshot);
 } };
}
