import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRecording } from "./useRecording";
import { useRecordingStore } from "@/stores/recording";
import { recordingApi } from "@/api/recording";
import { createRecordingSession } from "@/lib/recordingSession";

vi.mock("@/api/recording", () => ({ recordingApi: { start: vi.fn(), stop: vi.fn() } }));
vi.mock("@/lib/recordingSession", () => ({ createRecordingSession: vi.fn() }));
vi.mock("@/stores/sessions", () => ({ useSessionsStore: (select: (s: unknown) => unknown) => select({ load: vi.fn() }) }));

afterEach(() => vi.unstubAllGlobals());

const options = { micBars: { current: [] }, systemBars: { current: [] }, getLanguage: () => "pt" };
beforeEach(() => {
 vi.clearAllMocks();
 useRecordingStore.getState().reset();
 vi.stubGlobal("EventSource", class { close() {} });
 vi.mocked(recordingApi.start).mockResolvedValue({ success: true } as never);
 vi.mocked(createRecordingSession).mockResolvedValue({ id: "saved" } as never);
});

describe("recording language and finalization", () => {
 it("starts in English even when a previous recording used Portuguese", async () => {
  const { result } = renderHook(() => useRecording(options));
  await act(async () => { await result.current.start("pt"); });
  expect(recordingApi.start).toHaveBeenCalledWith("both", "en");
 });
 it("finishes native start even when browser microphone permission never resolves", async () => {
  vi.stubGlobal("navigator", {mediaDevices:{getUserMedia:vi.fn(() => new Promise(() => {}))}});
  const { result } = renderHook(() => useRecording(options));
  await act(async () => { expect(await result.current.start()).toBe(true); });
  expect(useRecordingStore.getState().recording).toBe(true);
 });
 it("saves the detected final language and precise full-audio timestamps", async () => {
  useRecordingStore.getState().startRecording();
  vi.mocked(recordingApi.stop).mockResolvedValue({ path: "audio.wav", finalized: true, duration:720, liveModel:"base", language: "pt", model: "parakeet-v3", turns: [{ id: 0, speaker: "Me", channel: "mic", text: "Bom dia", start: 2.1, end: 3.4 }] });
  const { result } = renderHook(() => useRecording(options));
  await act(async () => { expect(await result.current.stop("en")).toBe(true); });
  expect(recordingApi.stop).toHaveBeenCalledWith();
  expect(createRecordingSession).toHaveBeenCalledWith(expect.objectContaining({ transcriptFinalized:true, language: "pt", duration:720, liveModel:"base", transcriptionModel:"parakeet-v3", transcript: "Bom dia", segments: [expect.objectContaining({ start: 2.1, end: 3.4 })] }));
  expect(useRecordingStore.getState().resultLanguage).toBe("pt");
 });
 it("does not save live text when the final pass fails", async () => {
  useRecordingStore.getState().startRecording();
  vi.mocked(recordingApi.stop).mockResolvedValue({ path: "audio.wav", finalized: false });
  const { result } = renderHook(() => useRecording(options));
  await act(async () => { expect(await result.current.stop()).toBe(false); });
  expect(createRecordingSession).not.toHaveBeenCalled();
 });
 it("does not acknowledge a recording when final persistence fails", async () => {
  useRecordingStore.getState().startRecording();
  vi.mocked(recordingApi.stop).mockResolvedValue({ path:"audio.wav", finalized:true, language:"en", turns:[{id:0,speaker:"Ana",channel:"sys",text:"A decision",start:0,end:2}] });
  vi.mocked(createRecordingSession).mockRejectedValue(new Error("Final save failed"));
  const { result } = renderHook(() => useRecording(options));
  await act(async () => { expect(await result.current.stop()).toBe(false); });
  expect(useRecordingStore.getState().currentSessionId).toBeNull();
  expect(useRecordingStore.getState().transcript).toBe("A decision");
  expect(useRecordingStore.getState().processing).toBe(false);
 });
});
