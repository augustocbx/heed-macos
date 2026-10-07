import { tr, useLocale } from "@/lib/i18n.ts";
import { buildUrl } from "./client.ts";
import type { TranscribeResult } from "@heed/shared";

export interface TranscribeOptions {
	url?: string;
	file?: File;
	language: string;
	diarize: boolean;
 recording_finalize?: boolean;
 vocabulary?: import("@heed/shared").VocabularySelection;
 final_model?: "parakeet-v3" | "base" | "small" | "medium" | "large-v3";
}

export interface TranscribeHandlers {
	onStep?: (msg: string) => void;
	onProgress?: (percent: number) => void;
	/** Progressive: each segment as whisper produces it (text appears immediately) */
	onSegment?: (segment: { speaker: string; start: number; end: number; text: string; channel: string }) => void;
	/** Speaker reveal: pyannote finished, here are the real names + final segments */
	onSpeakers?: (data: { speakers: string[]; segments: unknown[]; embeddings: Record<string, unknown> }) => void;
	onResult?: (result: TranscribeResult) => void | Promise<void>;
	onError?: (msg: string) => void;
}

/**
 * Streams transcription via SSE. Returns a promise that resolves when the stream closes.
 */
export async function transcribe(opts: TranscribeOptions, handlers: TranscribeHandlers = {}): Promise<void> {
	const form = new FormData();
	if (opts.file) form.append("file", opts.file);
	if (opts.url) form.append("url", opts.url);
	form.append("language", opts.language);
	form.append("diarize", String(opts.diarize));
 if (opts.recording_finalize) form.append("recording_finalize", "true");
 if(opts.vocabulary)form.append("vocabulary",JSON.stringify(opts.vocabulary));
 if (opts.final_model) form.append("final_model", opts.final_model);

	const res = await fetch(buildUrl("/api/transcribe"), { method: "POST", body: form });
	if (!res.ok) {
  let message = tr("Transcription failed (HTTP {status})", undefined, {status:res.status});
  try {const body = await res.json(); message = body.error || message;} catch {}
  throw new Error(message);
 }
 if (!res.body) throw new Error(tr("No response body"));

	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let currentEvent = "";
 let resultReceived = false;
 let finalError: Error | null = null;

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		const lines = buffer.split("\n");
		buffer = lines.pop() || "";
		for (const line of lines) {
			if (line.startsWith("event: ")) {
				currentEvent = line.slice(7);
			} else if (line.startsWith("data: ")) {
				try {
					const data = JSON.parse(line.slice(6));
					switch (currentEvent) {
						case "step":
							handlers.onStep?.(tr(data.message || ""));
							break;
						case "progress":
							handlers.onProgress?.(data.percent);
							break;
						case "segment":
							handlers.onSegment?.(data);
							break;
						case "speakers":
							handlers.onSpeakers?.(data);
							break;
						case "result":
							await handlers.onResult?.(data as TranscribeResult);
       resultReceived = true;
							break;
						case "error":
							finalError = new Error(tr(data.message || "Transcription failed"));
       handlers.onError?.(tr(data.message || ""));
							break;
					}
				} catch (error) { finalError = error as Error; }
			}
		}
	}
 if (finalError) throw finalError;
 if (opts.recording_finalize && !resultReceived) throw new Error(tr("Recovery ended without a final transcript. The audio remains available."));
}
