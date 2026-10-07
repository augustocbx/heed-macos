import { tr, useLocale } from "@/lib/i18n.ts";
import { reconcileSpeakerNames } from "@/lib/speakerNames.ts";
import { create } from "zustand";
import type { Segment, TranscribeResult } from "@heed/shared";
import type { LiveCaptureOptions, LiveSpeechLanguage, CoordinatorState } from "@heed/shared";

interface RecordingState {
 realTimeTranscription: boolean;
 liveOptions: LiveCaptureOptions | null;
 liveSpeechLanguage: LiveSpeechLanguage;
 liveModel: string | null;
 coordinatorMeetingId: string | null;
 coordinatorRevision: number;
 dismissedMeetingId: string | null;
 coordinatorState: CoordinatorState;
 coordinatorError: string | null;
 coordinatorPath: string | null;
	speakerNames: Record<string, string>;
 finalSavePending: boolean;
	renameSpeaker: (original: string, name: string) => void;
	recording: boolean;
	processing: boolean;
	seconds: number;
	processStep: string;
	processProgress: number;

	// Result of last recording
	transcript: string;
 resultLanguage: string;
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
	upsertLiveTurn: (turn: { id: number; speaker: string; channel?: "mic" | "sys"; text: string; start?: number; end?: number }) => void;
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

export const useRecordingStore = create<RecordingState>((set, get) => ({
 realTimeTranscription:true,
 liveOptions:null,liveSpeechLanguage:"en",liveModel:null,
 coordinatorMeetingId: null,
 coordinatorRevision: -1,
 dismissedMeetingId: null,
 coordinatorState:"idle",
 coordinatorError:null,
 coordinatorPath:null,
	speakerNames: {},
 finalSavePending: false,
	renameSpeaker: (original, name) => set((s) => s.finalSavePending ? {} : ({ speakerNames: { ...s.speakerNames, [original]: name } })),
	recording: false,
	processing: false,
	seconds: 0,
	processStep: "",
	processProgress: 0,

	transcript: "",
 resultLanguage: "en",
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
    resultLanguage: "en",
			segments: [],
			speakers: [],
			embeddings: {},
			files: null,
			notesText: "",
			liveQuality: null,
			currentSessionId: null,
				speakerNames: {},
    finalSavePending: false,
		}),

	tick: () => set((s) => ({ seconds: s.seconds + 1 })),

	stopRecording: () => set({ recording: false, processing: true, processStep: tr("Processing..."), processProgress: 0 }),

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
				next[idx] = { ...next[idx], speaker: turn.speaker, text: turn.text, start: turn.start ?? next[idx].start, end: turn.end ?? next[idx].end };
			} else {
				next = [...s.segments, { id: turn.id, speaker: turn.speaker, channel: turn.channel, text: turn.text, start: turn.start ?? 0, end: turn.end ?? 0 }];
			}
			const newSpeakers = next.reduce<string[]>((acc, x) => acc.includes(x.speaker) ? acc : [...acc, x.speaker], []);
			const speakerNames = { ...s.speakerNames };
			if (idx >= 0 && s.speakerNames[s.segments[idx].speaker]) {
				speakerNames[turn.speaker] = s.speakerNames[s.segments[idx].speaker];
			}
			return { segments: next, speakers: newSpeakers, speakerNames, transcript: next.map((x) => x.text).join("\n") };
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
		set((s) => ({ speakers, segments, embeddings, speakerNames: reconcileSpeakerNames(s.segments, segments, s.speakerNames) })),

	setResult: (result) =>
		set((s) => ({
			speakerNames: reconcileSpeakerNames(s.segments, result.segments || [], s.speakerNames),
			processing: false,
			transcript: result.text,
   resultLanguage: result.metadata.language,
			segments: result.segments || [],
			speakers: result.speakers || [],
			embeddings: result.embeddings || {},
			files: result.files,
			processProgress: 100,
		})),

	setNotes: (text) => set({ notesText: text }),

	setSessionId: (id) => set({ currentSessionId: id }),

	reset: () =>
		set({
   realTimeTranscription:true,
 liveOptions:null,liveSpeechLanguage:"en",liveModel:null,
   dismissedMeetingId:get().coordinatorMeetingId,
   coordinatorMeetingId:null,
   coordinatorRevision:-1,
   coordinatorState:"idle",
   coordinatorError:null,
   coordinatorPath:null,
			recording: false,
			processing: false,
			seconds: 0,
			transcript: "",
   resultLanguage: "en",
			segments: [],
			speakers: [],
			embeddings: {},
			files: null,
			notesText: "",
			currentSessionId: null,
				speakerNames: {},
    finalSavePending: false,
		}),
}));
