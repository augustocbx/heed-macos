import { AiInferenceError, fail } from './contracts';
import type { AiProviderId } from '../../../shared/types/ai';
export const AI_ENDPOINTS: Readonly<Record<AiProviderId, string>> = Object.freeze({
 ollama: 'http://127.0.0.1:11434', openai: 'https://api.openai.com/v1/responses',
 anthropic: 'https://api.anthropic.com/v1/messages', deepseek: 'https://api.deepseek.com/chat/completions',
 xai: 'https://api.x.ai/v1/responses', compatible: '',
});
/** Exact trusted HTTPS URL only; connection authorization owns custom destination trust. */
export function validateRemoteEndpoint(endpoint: string, provider?: AiProviderId): string {
 let url: URL; try { url = new URL(endpoint); } catch { return fail('invalid-endpoint'); }
 const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
 if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !host) return fail('invalid-endpoint');
 if (provider && provider !== 'compatible' && endpoint !== AI_ENDPOINTS[provider]) return fail('invalid-endpoint');
 return url.href;
}
export interface JsonRequest { endpoint: string; headers: HeadersInit; signal: AbortSignal; body?: unknown; fetch?: typeof fetch; timeoutMs?: number; validation?: boolean; }
function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
 if (signal.aborted) return Promise.reject(new AiInferenceError('cancelled'));
 return new Promise((resolve, reject) => {
  const aborted = () => reject(new AiInferenceError('cancelled'));
  signal.addEventListener('abort', aborted, { once: true });
  operation.then(value => { signal.removeEventListener('abort', aborted); resolve(value); }, error => { signal.removeEventListener('abort', aborted); reject(error); });
 });
}
/** One request attempt, capped across headers and body, including noncooperative fetch fixtures. */
export async function requestJson(input: JsonRequest): Promise<unknown> {
 const endpoint = validateRemoteEndpoint(input.endpoint);
 const maximum = input.validation ? 15_000 : 300_000;
 const timeoutMs = input.timeoutMs ?? maximum;
 if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > maximum) return fail('invalid-request');
 if (input.signal.aborted) return fail('cancelled');
 const controller = new AbortController(); let timedOut = false;
 const forward = () => controller.abort(); input.signal.addEventListener('abort', forward, { once: true });
 const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
 let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
 try {
  const response = await abortable((input.fetch ?? fetch)(endpoint, { method: input.body === undefined ? 'GET' : 'POST', headers: input.headers, ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }), redirect: 'error', credentials: 'omit', signal: controller.signal }), controller.signal);
  if (response.redirected || (response.url && response.url !== endpoint) || (response.status >= 300 && response.status < 400)) return fail('invalid-endpoint');
  if (!response.ok) {
   void response.body?.cancel().catch(() => {});
   if (response.status === 401 || response.status === 403) return fail('authentication-failed');
   if (response.status === 429) return fail('rate-limited');
   return fail(response.status >= 500 ? 'provider-unavailable' : 'request-rejected');
  }
  const length = response.headers.get('content-length');
  if (length && /^\d+$/.test(length) && Number(length) > 2_000_000) { void response.body?.cancel().catch(() => {}); return fail('response-too-large'); }
  if (!response.body) return fail('invalid-output');
  reader = response.body.getReader(); let size = 0; let text = ''; const decoder = new TextDecoder('utf-8', { fatal: true });
  while (true) {
   const chunk = await abortable(reader.read(), controller.signal);
   if (chunk.done) break;
   size += chunk.value.byteLength; if (size > 2_000_000) return fail('response-too-large');
   text += decoder.decode(chunk.value, { stream: true });
  }
  text += decoder.decode();
  try { return JSON.parse(text); } catch { return fail('invalid-output'); }
 } catch (error) {
  if (input.signal.aborted) return fail('cancelled');
  if (timedOut) return fail('provider-timeout');
  if (error instanceof AiInferenceError) throw error;
  return fail(reader ? 'invalid-output' : 'provider-unavailable');
 } finally {
  clearTimeout(timer); input.signal.removeEventListener('abort', forward); controller.abort();
  if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock(); }
 }
}
