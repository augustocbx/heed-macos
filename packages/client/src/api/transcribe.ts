import { buildUrl } from "./client.ts";
import type { TranscribeResult } from "@heed/shared";

export interface TranscribeOptions {
	url?: string;
	file?: File;
	language: string;
	diarize: boolean;
}

export interface TranscribeHandlers {
	onStep?: (msg: string) => void;
	onProgress?: (percent: number) => void;
	/** Progressive: each segment as whisper produces it (text appears immediately) */
	onSegment?: (segment: { speaker: string; start: number; end: number; text: string; channel: string }) => void;
	/** Speaker reveal: pyannote finished, here are the real names + final segments */
	onSpeakers?: (data: { speakers: string[]; segments: unknown[]; embeddings: Record<string, unknown> }) => void;
	onResult?: (result: TranscribeResult) => void;
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

	const res = await fetch(buildUrl("/api/transcribe"), { method: "POST", body: form });
	if (!res.body) throw new Error("No response body");

	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let currentEvent = "";

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
							handlers.onStep?.(data.message);
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
							handlers.onResult?.(data as TranscribeResult);
							break;
						case "error":
							handlers.onError?.(data.message);
							break;
					}
				} catch {}
			}
		}
	}
}
