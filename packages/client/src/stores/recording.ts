import { create } from "zustand";
import type { Segment, TranscribeResult } from "@heed/shared";

interface RecordingState {
	recording: boolean;
	processing: boolean;
	seconds: number;
	processStep: string;
	processProgress: number;

	// Result of last recording
	transcript: string;
	segments: Segment[];
	speakers: string[];
	embeddings: Record<string, number[]>;
	files: TranscribeResult["files"] | null;
	notesText: string;
	currentSessionId: string | null;

	// Mutators
	startRecording: () => void;
	tick: () => void;
	stopRecording: () => void;
	setProcessing: (step: string, percent: number) => void;
	/** Progressive: append a single segment as whisper produces it */
	appendSegment: (seg: Segment) => void;
	/** Live "full" mode: REPLACE the single live segment for this channel each tick (full re-transcribe). */
	setLiveSegment: (seg: Segment) => void;
	/** Live "stream" mode (karaoke): upsert a chronological turn by id — append new, update text in place. */
	upsertLiveTurn: (turn: { id: number; speaker: string; channel?: "mic" | "sys"; text: string }) => void;
	/** Live audio-quality hint (heed differentiator): warns when the mic is too quiet / echoey / unclear. */
	liveQuality: { ok: boolean; hint?: string } | null;
	setLiveQuality: (q: { ok: boolean; hint?: string }) => void;
	/** Speaker reveal: replace all segments + speakers with final pyannote result */
	revealSpeakers: (speakers: string[], segments: Segment[], embeddings: Record<string, number[]>) => void;
	setResult: (result: TranscribeResult) => void;
	setNotes: (text: string) => void;
	setSessionId: (id: string | null) => void;
	reset: () => void;
}

export const useRecordingStore = create<RecordingState>((set) => ({
	recording: false,
	processing: false,
	seconds: 0,
	processStep: "",
	processProgress: 0,

	transcript: "",
	segments: [],
	speakers: [],
	embeddings: {},
	files: null,
	notesText: "",
	currentSessionId: null,

	startRecording: () =>
		set({
			recording: true,
			seconds: 0,
			processing: false,
			transcript: "",
			segments: [],
			speakers: [],
			embeddings: {},
			files: null,
			notesText: "",
			liveQuality: null,
			currentSessionId: null,
		}),

	tick: () => set((s) => ({ seconds: s.seconds + 1 })),

	stopRecording: () => set({ recording: false, processing: true, processStep: "Processing...", processProgress: 0 }),

	setProcessing: (step, percent) => set({ processStep: step, processProgress: percent }),

	appendSegment: (seg) =>
		set((s) => {
			const newSegments = [...s.segments, seg];
			const newSpeakers = s.speakers.includes(seg.speaker) ? s.speakers : [...s.speakers, seg.speaker];
			const newTranscript = s.transcript ? `${s.transcript}\n${seg.text}` : seg.text;
			return { segments: newSegments, speakers: newSpeakers, transcript: newTranscript };
		}),

	liveQuality: null,
	setLiveQuality: (q) => set({ liveQuality: q.ok ? null : q }),

	upsertLiveTurn: (turn) =>
		set((s) => {
			const idx = s.segments.findIndex((x) => x.id === turn.id);
			let next: Segment[];
			if (idx >= 0) {
				next = s.segments.slice();
				next[idx] = { ...next[idx], speaker: turn.speaker, text: turn.text };
			} else {
				next = [...s.segments, { id: turn.id, speaker: turn.speaker, channel: turn.channel, text: turn.text, start: 0, end: 0 }];
			}
			const newSpeakers = next.reduce<string[]>((acc, x) => acc.includes(x.speaker) ? acc : [...acc, x.speaker], []);
			return { segments: next, speakers: newSpeakers, transcript: next.map((x) => x.text).join("\n") };
		}),

	setLiveSegment: (seg) =>
		set((s) => {
			const channel = seg.channel ?? "mic";
			// Keep at most ONE live segment per channel; replace it each tick. Empty text clears it.
			const others = s.segments.filter((x) => (x.channel ?? "mic") !== channel);
			const next = seg.text && seg.text.trim().length > 1 ? [...others, seg] : others;
			// Stable order: mic before sys.
			next.sort((a, b) => (a.channel === "sys" ? 1 : 0) - (b.channel === "sys" ? 1 : 0));
			const newSpeakers = next.reduce<string[]>((acc, x) => acc.includes(x.speaker) ? acc : [...acc, x.speaker], []);
			const newTranscript = next.map((x) => x.text).join("\n");
			return { segments: next, speakers: newSpeakers, transcript: newTranscript };
		}),

	revealSpeakers: (speakers, segments, embeddings) =>
		set({ speakers, segments, embeddings }),

	setResult: (result) =>
		set({
			processing: false,
			transcript: result.text,
			segments: result.segments || [],
			speakers: result.speakers || [],
			embeddings: result.embeddings || {},
			files: result.files,
			processProgress: 100,
		}),

	setNotes: (text) => set({ notesText: text }),

	setSessionId: (id) => set({ currentSessionId: id }),

	reset: () =>
		set({
			recording: false,
			processing: false,
			seconds: 0,
			transcript: "",
			segments: [],
			speakers: [],
			embeddings: {},
			files: null,
			notesText: "",
			currentSessionId: null,
		}),
}));
