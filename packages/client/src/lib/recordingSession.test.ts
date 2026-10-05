import { beforeEach, expect, test, vi } from "vitest";
import { useRecordingStore } from "@/stores/recording.ts";
import { sessionsApi } from "@/api/sessions.ts";
import { createRecordingSession } from "./recordingSession.ts";
import { applySpeakerNames } from "./speakerNames.ts";
vi.mock("@/api/sessions.ts", () => ({ sessionsApi: { create: vi.fn(), patch: vi.fn() } }));
beforeEach(() => { vi.clearAllMocks(); useRecordingStore.getState().reset(); });
const segment = { speaker: "Speaker 1", start: 1.25, end: 3.5, text: "hello", channel: "sys" as const, auto: true };

test("saves manual names in session data without losing synchronization or embeddings", async () => {
 useRecordingStore.getState().renameSpeaker("Speaker 1", "Ana");
 vi.mocked(sessionsApi.create).mockResolvedValue({ id: "session" } as never);
 await createRecordingSession({ segments: [segment], speakers: ["Speaker 1"], embeddings: { "Speaker 1": [1, 2] } });
 expect(sessionsApi.create).toHaveBeenCalledWith({
  segments: [{ ...segment, speaker: "Ana", auto: false }], speakers: ["Ana"], embeddings: { Ana: [1, 2] },
 });
 expect(sessionsApi.patch).not.toHaveBeenCalled();
});

test("saves edits made while the session was being created", async () => {
 let resolve!: (value: never) => void;
 vi.mocked(sessionsApi.create).mockImplementation(() => new Promise(r => { resolve = r; }));
 vi.mocked(sessionsApi.patch).mockResolvedValue({ id: "session" } as never);
 const pending = createRecordingSession({ segments: [segment], speakers: ["Speaker 1"] });
 useRecordingStore.getState().renameSpeaker("Speaker 1", "Ana");
 resolve({ id: "session" } as never);
 await pending;
 expect(sessionsApi.patch).toHaveBeenCalledWith("session", expect.objectContaining({ speakers: ["Ana"] }));
});

test("renaming a session produces persistable data and preserves other participants", () => {
 const other = { ...segment, speaker: "Speaker 2", start: 4, end: 6 };
 const saved = applySpeakerNames([segment, other], ["Speaker 1", "Speaker 2"], { "Speaker 1": [1], "Speaker 2": [2] }, { "Speaker 1": "Ana" });
 expect(saved.segments).toEqual([{ ...segment, speaker: "Ana", auto: false }, other]);
 expect(saved.speakers).toEqual(["Ana", "Speaker 2"]);
 expect(saved.embeddings).toEqual({ Ana: [1], "Speaker 2": [2] });
});

test("renumbered indices use voice timing instead of the previous number", async () => {
 const { reconcileSpeakerNames } = await import("./speakerNames.ts");
 const previous = [{ ...segment, start: 1, end: 4 }];
 const final = [{ ...segment, speaker: "Speaker 2", start: 1, end: 4 }, { ...segment, speaker: "Speaker 1", start: 8, end: 10 }];
 expect(reconcileSpeakerNames(previous, final, { "Speaker 1": "Ana" })).toEqual({ "Speaker 2": "Ana" });
});

test("ambiguous overlap does not transfer a name to another participant", async () => {
 const { reconcileSpeakerNames } = await import("./speakerNames.ts");
 expect(reconcileSpeakerNames([{ ...segment, start: 0, end: 4 }], [
  { ...segment, start: 0, end: 2 }, { ...segment, speaker: "Speaker 2", start: 2, end: 4 },
 ], { "Speaker 1": "Ana" })).toEqual({});
});

test("a new automatic name preserves the manual choice for the same turn", () => {
 const state = useRecordingStore.getState();
 state.upsertLiveTurn({ id: 1, speaker: "Speaker 1", channel: "sys", text: "hello", start: 1, end: 2 });
 state.renameSpeaker("Speaker 1", "Ana");
 state.upsertLiveTurn({ id: 1, speaker: "Automatic name", channel: "sys", text: "hello again", start: 1, end: 3 });
 expect(useRecordingStore.getState().speakerNames["Automatic name"]).toBe("Ana");
 expect(useRecordingStore.getState().segments[0]).toMatchObject({ start: 1, end: 3 });
});

test("diarization merging two voices does not arbitrarily select a manual name", async () => {
 const { reconcileSpeakerNames } = await import("./speakerNames.ts");
 const previous = [
  { ...segment, speaker: "Speaker 1", start: 0, end: 2 },
  { ...segment, speaker: "Speaker 2", start: 3, end: 5 },
 ];
 const final = [
  { ...segment, speaker: "Speaker 3", start: 0, end: 2 },
  { ...segment, speaker: "Speaker 3", start: 3, end: 5 },
 ];
 expect(reconcileSpeakerNames(previous, final, { "Speaker 1": "Ana", "Speaker 2": "Bruno" })).toEqual({});
});
