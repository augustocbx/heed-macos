import {localServiceUrl} from '../../shared/lib/service-config';
import {isTranscriptionHealth} from '../../shared/lib/service-identity';
/**
 * Thin typed client for the Python transcription sidecar (the only thing that talks to the configured loopback sidecar).
 * Centralizes the base URL and the `postJSON` helper that was inlined in server.ts, and names the
 * sidecar operations so call sites read as intent (`tx.diarize(wav)`) instead of stringly-typed
 * POSTs. Keeps the network adapter in one module (hexagonal "driven adapter"), so the recording
 * orchestration depends on an interface, not on `fetch` string paths.
 */
import {configuredServicePorts} from './service-ports';
import { logger } from "./logger.ts";

const log = logger("tx-client");
export const TRANSCRIPTION_SERVER = process.env.HEED_TRANSCRIPTION_URL !== undefined ? localServiceUrl(process.env.HEED_TRANSCRIPTION_URL,"Transcription service") : `http://127.0.0.1:${configuredServicePorts().transcription}`;

// Capture is already physically stopped before finish/finalize calls. These upper bounds
// cover response headers AND bodies; the native duration-scaled worker deadline owns cleanup.
export const TRANSCRIPTION_HTTP_TIMEOUT_MS = {
 health: 5_000,
 ordinary: 120_000,
 cleanup: 60_000,
 finalize: 90 * 60_000,
} as const;
export interface TranscriptionRequestOptions { signal?: AbortSignal; timeoutMs?: number; fetch?: typeof fetch }
function requestTimeout(method: "GET" | "POST", path: string): number {
 if (method === "GET") return path === "/health" ? TRANSCRIPTION_HTTP_TIMEOUT_MS.health : TRANSCRIPTION_HTTP_TIMEOUT_MS.ordinary;
 if (["/finalize", "/transcribe", "/diarize"].includes(path)) return TRANSCRIPTION_HTTP_TIMEOUT_MS.finalize;
 if (["/stream/finish", "/diar/finish"].includes(path)) return TRANSCRIPTION_HTTP_TIMEOUT_MS.cleanup;
 return TRANSCRIPTION_HTTP_TIMEOUT_MS.ordinary;
}

async function requestJSON<T>(method: "GET" | "POST", path: string, body: unknown, options: TranscriptionRequestOptions): Promise<T | null> {
 const timeoutMs = options.timeoutMs ?? requestTimeout(method, path);
 if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > TRANSCRIPTION_HTTP_TIMEOUT_MS.finalize) {
  throw new RangeError("Invalid transcription request deadline");
 }
 const controller = new AbortController();
 const abort = () => controller.abort(options.signal?.reason);
 if (options.signal?.aborted) abort();
 else options.signal?.addEventListener("abort", abort, {once:true});
 const timer = setTimeout(() => controller.abort(new Error("Transcription request deadline exceeded")), timeoutMs);
 try {
  const response = await (options.fetch ?? fetch)(`${TRANSCRIPTION_SERVER}${path}`, {
   method,
   ...(method === "POST" ? {headers:{"Content-Type":"application/json"}, body:JSON.stringify(body)} : {}),
   signal: controller.signal,
  });
  return response.ok ? await response.json() as T : null;
 } catch (error) {
  log.debug(`${method} ${path} failed: ${error instanceof Error ? error.message : String(error)}`);
  return null;
 } finally {
  clearTimeout(timer);
  options.signal?.removeEventListener("abort", abort);
 }
}

/** POST JSON; null on failure. Aborting HTTP never terminates a shared native worker. */
export function pyPost<T = any>(path: string, body: unknown, options: TranscriptionRequestOptions = {}): Promise<T | null> {
 return requestJSON<T>("POST", path, body, options);
}

/** GET JSON; health also requires the configured sidecar's service identity. */
export async function pyGet<T = any>(path: string, options: TranscriptionRequestOptions = {}): Promise<T | null> {
 const data = await requestJSON<T>("GET", path, undefined, options);
 return path === "/health" && !isTranscriptionHealth(data) ? null : data;
}

// --- Named sidecar operations (live streaming + one-shot diarization) ---
export const tx = {
	streamStart: (language: string, channel: "mic" | "sys") => pyPost("/stream/start", { language, channel }),
	streamFeed: (wav_path: string, channel: "mic" | "sys", audio_s?: number) =>
		pyPost("/stream/feed", { wav_path, channel, audio_s }),
	streamFinish: (channel: "mic" | "sys") => pyPost("/stream/finish", { channel }),
	diarStart: () => pyPost("/diar/start", {}),
	diarFeed: (wav_path: string) => pyPost("/diar/feed", { wav_path }),
	diarFinish: () => pyPost("/diar/finish", {}),
	diarize: (wav_path: string) => pyPost("/diarize", { wav_path }),
	health: () => pyGet("/health"),
};
