import { test, expect, beforeEach } from "vitest";
import { useRecordingStore } from "./recording.ts";

// Characterization tests for the recording store's three live mutation patterns (append / replace /
// upsert) — the ones the architecture audit flagged as the trickiest, incompatible bits of state.
// Pins their current behavior so the planned normalization can be verified as behavior-preserving.

beforeEach(() => useRecordingStore.getState().reset());

test("appendSegment (chunk mode) accumulates segments, speakers, transcript", () => {
	const s = useRecordingStore.getState();
	s.appendSegment({ speaker: "Me", start: 0, end: 1, text: "hola" });
	s.appendSegment({ speaker: "Speaker 1", start: 1, end: 2, text: "qué tal" });
	s.appendSegment({ speaker: "Me", start: 2, end: 3, text: "bien" });
	const st = useRecordingStore.getState();
	expect(st.segments).toHaveLength(3);
	expect(st.speakers).toEqual(["Me", "Speaker 1"]); // de-duped, first-seen order
	expect(st.transcript).toBe("hola\nqué tal\nbien");
});

test("upsertLiveTurn (stream/karaoke mode) appends a new id and updates text in place", () => {
	const s = useRecordingStore.getState();
	s.upsertLiveTurn({ id: 1, speaker: "Me", channel: "mic", text: "ho" });
	s.upsertLiveTurn({ id: 1, speaker: "Me", channel: "mic", text: "hola" }); // same id → update
	s.upsertLiveTurn({ id: 2, speaker: "Speaker 1", channel: "sys", text: "hi" }); // new id → append
	const st = useRecordingStore.getState();
	expect(st.segments).toHaveLength(2);
	expect(st.segments[0]).toMatchObject({ id: 1, text: "hola" });
	expect(st.segments[1]).toMatchObject({ id: 2, speaker: "Speaker 1" });
	expect(st.transcript).toBe("hola\nhi");
});

test("setLiveSegment (full mode) keeps at most one segment per channel and replaces it", () => {
	const s = useRecordingStore.getState();
	s.setLiveSegment({ speaker: "Me", channel: "mic", start: 0, end: 5, text: "first" });
	s.setLiveSegment({ speaker: "Me", channel: "mic", start: 0, end: 5, text: "first refined" });
	s.setLiveSegment({ speaker: "Speaker 1", channel: "sys", start: 0, end: 5, text: "other party" });
	const st = useRecordingStore.getState();
	expect(st.segments).toHaveLength(2); // one mic + one sys
	expect(st.segments.find((x) => x.channel === "mic")?.text).toBe("first refined");
	expect(st.segments[0].channel).toBe("mic"); // stable order: mic before sys
});

test("setLiveSegment clears a channel when text becomes empty", () => {
	const s = useRecordingStore.getState();
	s.setLiveSegment({ speaker: "Me", channel: "mic", start: 0, end: 5, text: "something" });
	s.setLiveSegment({ speaker: "Me", channel: "mic", start: 0, end: 5, text: "" });
	expect(useRecordingStore.getState().segments).toHaveLength(0);
});

test("reset clears everything back to idle", () => {
	const s = useRecordingStore.getState();
	s.appendSegment({ speaker: "Me", start: 0, end: 1, text: "x" });
	s.reset();
	const st = useRecordingStore.getState();
	expect(st.segments).toHaveLength(0);
	expect(st.transcript).toBe("");
	expect(st.recording).toBe(false);
});
