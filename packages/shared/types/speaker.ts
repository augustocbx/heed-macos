export interface Segment {
	speaker: string;
	start: number;
	end: number;
	text: string;
	/** Live "turn" id (karaoke): identifies a contiguous speaker turn so the client can update it in place. */
	id?: number;
	/** True when this segment overlaps in time with a segment from a different channel (mic vs system). */
	overlap?: boolean;
	/** Source channel: "mic" (you) or "sys" (other party). Only set on dual-capture sessions. */
	channel?: "mic" | "sys";
	/** True when this speaker was auto-recognized from a saved voice (cross-session). Shown as a subtle badge so a wrong match is easy to correct. */
	auto?: boolean;
	/** Valid ASR speech retained without a reliable diarization identity. */
	attribution?: "fallback";
}

/** Content-free measurements from the authoritative full-audio pass. */
export interface TranscriptionChannelDiagnostics {
 rawRms: number;
 rawPeak: number;
 cleanedRms: number;
 asrSegments: number;
 diarizationSegments: number;
 usableEmbeddings: number;
 retainedSegments: number;
 discardedSegments: number;
 discardReasons: Partial<Record<"echo-text-and-time", number>>;
 fallbackSegments: number;
 diarizationFailed: boolean;
}
export type TranscriptionWarning = "microphone-all-asr-filtered" | "microphone-attribution-fallback" | "system-attribution-fallback";
export interface TranscriptionDiagnostics {
 version: 1;
 channels: Partial<Record<"mic" | "sys", TranscriptionChannelDiagnostics>>;
 aecApplied: boolean;
 warnings: TranscriptionWarning[];
}

export interface DiarizationResult {
	speakers: string[];
	speaker_count: number;
	segments: Segment[];
	text: string;
	embeddings?: Record<string, number[]>;
	auto_named?: Record<string, { name: string; score: number }>;
}
