/**
 * Thin typed client for the Python transcription sidecar (the only thing that talks to :5002).
 * Centralizes the base URL and the `postJSON` helper that was inlined in server.ts, and names the
 * sidecar operations so call sites read as intent (`tx.diarize(wav)`) instead of stringly-typed
 * POSTs. Keeps the network adapter in one module (hexagonal "driven adapter"), so the recording
 * orchestration depends on an interface, not on `fetch` string paths.
 */
import { logger } from "./logger.ts";

const log = logger("tx-client");
export const TRANSCRIPTION_SERVER = process.env.HEED_TRANSCRIPTION_URL || "http://127.0.0.1:5002";

/** POST JSON to the sidecar; returns parsed JSON, or null on any failure (logged at debug). */
export async function pyPost<T = any>(path: string, body: unknown): Promise<T | null> {
	try {
		const r = await fetch(`${TRANSCRIPTION_SERVER}${path}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		return r.ok ? ((await r.json()) as T) : null;
	} catch (e) {
		log.debug(`POST ${path} failed: ${e instanceof Error ? e.message : String(e)}`);
		return null;
	}
}

/** GET JSON from the sidecar (e.g. /health); null on failure. */
export async function pyGet<T = any>(path: string): Promise<T | null> {
	try {
		const r = await fetch(`${TRANSCRIPTION_SERVER}${path}`);
		return r.ok ? ((await r.json()) as T) : null;
	} catch {
		return null;
	}
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
