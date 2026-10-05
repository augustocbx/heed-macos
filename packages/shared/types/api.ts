// API request/response types

export interface HealthResponse {
	ollama: boolean;
	whisper: boolean;
	pyannote: boolean;
	whisper_info?: {
		final_model: string;
		live_model: string;
		device: "cpu" | "cuda";
		quality: "very_good" | "excellent" | "best";
		speed: "fast" | "medium" | "slower";
		reason: string;
	} | null;
	pyannote_info?: {
		model: string;
		device: "cpu" | "cuda";
		profile: string;
		batch_size: number;
		reason: string;
		cpu_threads?: number;
	} | null;
	// Engine-aware language support: which codes the active engine can transcribe and whether
	// it auto-detects. codes=null means "all Whisper languages" (the client's full list).
	languages?: {
		engine: string;
		codes: string[] | null;
		supports_auto: boolean;
	} | null;
}

export interface TranscribeResult {
	success: true;
	text: string;
	files: { wav: string; srt: string; txt: string };
	metadata: { language: string; model: string };
	speakers: string[];
	segments: import("./speaker.ts").Segment[];
	embeddings?: Record<string, number[]>;
	wordCount: number;
	timing?: { total_ms: number };
}

export interface SystemRecordStartResponse {
	recording: boolean;
	mode: string;
	path: string;
	monitor: string | null;
	mic: string;
}
