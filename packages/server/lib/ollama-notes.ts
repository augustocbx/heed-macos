import { notesPrompt } from './inference/prompts';
export class NotesGenerationError extends Error {
 constructor(readonly reason: string) { super(reason); this.name = "NotesGenerationError"; }
}
interface TransportOptions { fetch?: typeof fetch; signal?: AbortSignal; timeoutMs?: number; }
export interface LocalNotesInput extends TransportOptions {
 baseUrl: string;
 model: string;
 templatePrompt: string;
 transcript: string;
 language: string;
 numGpu?: number;
 numThread?: number;
 onProgress?: (characters: number) => void;
 onToken?: (token: string) => void;
}
const fail = (reason: string): never => { throw new NotesGenerationError(reason); };

function localBaseUrl(value: string): string {
 let url: URL;
 try { url = new URL(value); } catch { return fail("local-only"); }
 const hostname = url.hostname.replace(/^\[|\]$/g, "");
 if (!["http:", "https:"].includes(url.protocol) || !["localhost", "127.0.0.1", "::1"].includes(hostname) || url.username || url.password || url.search || url.hash || url.pathname !== "/") return fail("local-only");
 return url.origin;
}
function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
 if (signal.aborted) return Promise.reject(signal.reason || new DOMException("Aborted", "AbortError"));
 return new Promise((resolve, reject) => {
  const aborted = () => reject(signal.reason || new DOMException("Aborted", "AbortError"));
  signal.addEventListener("abort", aborted, { once: true });
  operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
 });
}
async function withTransport<T>(baseUrl: string, options: TransportOptions, work: (request: (path: string, init?: RequestInit) => Promise<Response>, signal: AbortSignal) => Promise<T>, maximumMs = 300_000): Promise<T> {
 const base = localBaseUrl(baseUrl);
 const controller = new AbortController();
 let timedOut = false;
 const timeoutMs = options.timeoutMs ?? maximumMs;
 if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > maximumMs) return fail("ollama-unavailable");
 const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
 const forwardAbort = () => controller.abort(options.signal?.reason);
 options.signal?.addEventListener("abort", forwardAbort, { once: true });
 if (options.signal?.aborted) forwardAbort();
 const request = async (path: string, init: RequestInit = {}) => {
  if (controller.signal.aborted) throw controller.signal.reason;
  const response = await abortable((options.fetch || fetch)(`${base}${path}`, { ...init, redirect: "error", credentials: "omit", signal: controller.signal }), controller.signal);
  if (!response.ok) return fail("ollama-unavailable");
  return response;
 };
 try { return await work(request, controller.signal); }
 catch (error) { if (options.signal?.aborted) throw options.signal.reason || error; if (error instanceof NotesGenerationError && !timedOut) throw error; return fail("ollama-unavailable"); }
 finally { clearTimeout(timer); options.signal?.removeEventListener("abort", forwardAbort); }
}
async function json(response: Response, signal: AbortSignal): Promise<any> {
 if (!response.body) return fail("ollama-unavailable");
 const reader = response.body.getReader(); const decoder = new TextDecoder('utf-8', { fatal: true }); let bytes = 0; let text = '';
 try {
  while (true) { const chunk = await abortable(reader.read(), signal); if (chunk.done) break; bytes += chunk.value.byteLength; if (bytes > 2_000_000) return fail("ollama-unavailable"); text += decoder.decode(chunk.value, { stream: true }); }
  return JSON.parse(text + decoder.decode());
 } catch { return fail("ollama-unavailable"); }
 finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
}
function cloudModelName(model: string): boolean { return /(^|[-/:])cloud($|[-/:])/i.test(model); }
function hasRemoteMetadata(value: unknown): boolean {
 if (!value || typeof value !== "object") return false;
 if (Array.isArray(value)) return value.some(item => item === "cloud" || hasRemoteMetadata(item));
 return Object.entries(value).some(([key, item]) => /^remote[_-]?(host|model)$/i.test(key) || (key === "family" && item === "cloud") || hasRemoteMetadata(item));
}
async function installedModels(request: (path: string, init?: RequestInit) => Promise<Response>, signal: AbortSignal): Promise<string[]> {
 const data = await json(await request("/api/tags"), signal);
 if (!Array.isArray(data?.models)) return fail("ollama-unavailable");
 return data.models.flatMap((model: any) => typeof model?.name === "string" && model.name.trim() ? [model.name] : []);
}
async function verifyLocalModel(model: string, request: (path: string, init?: RequestInit) => Promise<Response>, signal: AbortSignal, requireCompletion = false, minContext = 0): Promise<void> {
 if (cloudModelName(model)) return fail("local-only");
 const data = await json(await request("/api/show", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model }) }), signal);
 if (!data || typeof data !== "object" || Array.isArray(data)) return fail("ollama-unavailable");
 if (hasRemoteMetadata(data)) return fail("local-only");
 if (requireCompletion && (!Array.isArray(data.capabilities) || !data.capabilities.includes("completion"))) return fail("model-incompatible");
 if (minContext && !Object.entries(data.model_info ?? {}).some(([key,value]) => key.endsWith(".context_length") && typeof value === "number" && value >= minContext)) return fail("model-incompatible");
 if (!((data.details && typeof data.details === "object") || (data.model_info && typeof data.model_info === "object") || typeof data.modelfile === "string")) return fail("ollama-unavailable");
}

/** Lists already installed local models; never downloads or starts a model. */
export async function listLocalNotesModels(baseUrl: string, options: TransportOptions = {}): Promise<string[]> {
 return withTransport(baseUrl, { timeoutMs: 15_000, ...options }, async (request, signal) => {
  const names = await installedModels(request, signal); const local: string[] = [];
  for (const model of names) {
   try { await verifyLocalModel(model, request, signal); local.push(model); }
   catch (error) { if (!(error instanceof NotesGenerationError) || error.reason !== "local-only") throw error; }
  }
  return local;
 }, 15_000);
}

/** Chat supports installed completion models only, never embedding-only models. */
export async function listLocalChatModels(baseUrl: string, options: TransportOptions = {}): Promise<string[]> {
 return withTransport(baseUrl, { timeoutMs: 15_000, ...options }, async (request, signal) => {
  const local: string[] = [];
  for (const model of await installedModels(request, signal)) {
   try { await verifyLocalModel(model, request, signal, true, 8192); local.push(model); }
   catch (error) { if (!(error instanceof NotesGenerationError) || !["local-only", "model-incompatible"].includes(error.reason)) throw error; }
  }
  return local;
 }, 15_000);
}

/** Explicit unload is bounded and uses a fresh signal after generation is aborted. */
export async function unloadLocalNotesModel(baseUrl: string, model: string, options: TransportOptions = {}): Promise<void> {
 await withTransport(baseUrl, { timeoutMs: 5_000, ...options }, async request => {
  if (cloudModelName(model)) return fail("local-only");
  await request("/api/generate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model, prompt: "", stream: false, keep_alive: 0 }) });
 }, 5_000);
}

export interface LocalStructuredInput extends TransportOptions {
 outputSchema?: Record<string, unknown>;
 maxOutputTokens?: number;
 baseUrl: string;
 model: string;
 system: string;
 data: unknown;
 requireCompletion?: boolean;
 contextTokens?: number;
 maxInputBytes?: number;
 numGpu?: number;
 numThread?: number;
 onToken?: (token: string) => void;
}

/** Structured local output shares the installed-model and completed-stream guards. */
export function generateLocalStructured(input: LocalStructuredInput): Promise<string> {
 const prompt = JSON.stringify(input.data);
 if (input.outputSchema !== undefined) {
  if (!input.outputSchema || typeof input.outputSchema !== 'object' || Array.isArray(input.outputSchema)) return Promise.reject(new NotesGenerationError('generation-failed'));
  let encoded: string; try { encoded = JSON.stringify(input.outputSchema); } catch { return Promise.reject(new NotesGenerationError('generation-failed')); }
  if (new TextEncoder().encode(encoded).length > 16384) return Promise.reject(new NotesGenerationError('context-limit'));
 }
 if (input.maxInputBytes && new TextEncoder().encode(input.system + prompt).length > input.maxInputBytes) return Promise.reject(new NotesGenerationError("context-limit"));
 return generateLocalOutput({ ...input, prompt, format: input.outputSchema ?? "json" });
}

/** Provider-neutral text output without adding notes or JSON instructions. */
export function generateLocalText(input: Omit<LocalStructuredInput, "outputSchema">): Promise<string> {
 const prompt = JSON.stringify(input.data);
 if (input.maxInputBytes && new TextEncoder().encode(input.system + prompt).length > input.maxInputBytes) return Promise.reject(new NotesGenerationError("context-limit"));
 return generateLocalOutput({ ...input, prompt });
}

export function generateLocalNotes(input: LocalNotesInput): Promise<string> {
 if (!input.templatePrompt?.trim()) return Promise.reject(new NotesGenerationError("template-missing"));
 if (!input.transcript?.trim()) return Promise.reject(new NotesGenerationError("transcript-empty"));
 const { system, data } = notesPrompt(input);
 return generateLocalOutput({ ...input, system, prompt: JSON.stringify(data) });
}

interface LocalGenerationInput extends TransportOptions {
 baseUrl: string; model: string; system: string; prompt: string; format?: "json" | Record<string, unknown>; requireCompletion?: boolean;
 contextTokens?: number;
 maxOutputTokens?: number;
 maxInputBytes?: number;
 numGpu?: number; numThread?: number; onProgress?: (characters: number) => void; onToken?: (token: string) => void;
}

/** A completed stream is required; partial output is never eligible for persistence. */
async function generateLocalOutput(input: LocalGenerationInput): Promise<string> {
 return withTransport(input.baseUrl, input, async (request, signal) => {
  if (!input.model?.trim()) return fail("model-missing");
  if (cloudModelName(input.model)) return fail("local-only");
  if (!input.system?.trim() || !input.prompt?.trim()) return fail("generation-failed");
  if (!(await installedModels(request, signal)).includes(input.model)) return fail("model-missing");
  await verifyLocalModel(input.model, request, signal, input.requireCompletion, input.contextTokens);

  const options: Record<string, number> = { temperature: 0.2 };
  if (input.contextTokens) { options.num_ctx = input.contextTokens; options.num_predict = input.maxOutputTokens ?? 1800; }
  if (input.maxOutputTokens !== undefined && (!Number.isSafeInteger(input.maxOutputTokens) || input.maxOutputTokens <= 0)) return fail("context-limit");
  if (input.maxOutputTokens !== undefined) options.num_predict = input.maxOutputTokens;
  if (input.numGpu !== undefined) options.num_gpu = Math.max(0, Math.floor(input.numGpu));
  if (input.numThread !== undefined) options.num_thread = Math.max(1, Math.floor(input.numThread));
  try {
  const response = await request("/api/generate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: input.model, system: input.system, prompt: input.prompt, ...(input.format ? { format: input.format } : {}), stream: true, keep_alive: 0, options }) });
  if (!response.body) return fail("incomplete-output");
  const reader = response.body.getReader(); const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = ""; let text = ""; let done = false; let responseBytes = 0;
  const frame = (line: string) => {
   if (!line.trim()) return;
   if (done) return fail("incomplete-output");
   let data: any; try { data = JSON.parse(line); } catch { return fail("incomplete-output"); }
   if (!data || typeof data !== "object" || Array.isArray(data)) return fail("incomplete-output");
   if (data.error) return fail("generation-failed");
   if ((data.response !== undefined && typeof data.response !== "string") || typeof data.done !== "boolean") return fail("incomplete-output");
   text += data.response || "";
   if (text.length > 2_000_000) return fail("incomplete-output");
   if (data.done && data.done_reason === "length") return fail("context-limit");
   done = data.done;
   input.onProgress?.(text.length);
   if (data.response) input.onToken?.(data.response);
  };
  try {
   while (true) {
    const chunk = await abortable(reader.read(), signal);
    if (chunk.done) { buffer += decoder.decode(); break; }
    responseBytes += chunk.value.byteLength;
    if (responseBytes > 2_000_000) return fail("incomplete-output");
    buffer += decoder.decode(chunk.value, { stream: true });
    if (buffer.length > 2_000_000) return fail("incomplete-output");
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) { frame(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1); }
   }
   frame(buffer);
   if (!done || !text.trim()) return fail("incomplete-output");
   return text;
  } catch (error) { if (error instanceof TypeError && !signal.aborted) return fail("incomplete-output"); throw error; }
  finally {
   void reader.cancel().catch(() => {}); reader.releaseLock();
  }
  } finally {
   if (signal.aborted) await unloadLocalNotesModel(input.baseUrl, input.model, { fetch: input.fetch }).catch(() => {});
  }
 });
}
