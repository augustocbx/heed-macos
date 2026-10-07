import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRecording } from "./useRecording";
import { useRecordingStore } from "@/stores/recording";
import { recordingApi } from "@/api/recording";
import { createRecordingSession } from "@/lib/recordingSession";
import {useVocabularyStore} from '@/stores/vocabulary';
import {ApiError} from '@/api/client';

vi.mock("@/api/recording", () => ({ recordingApi: { start: vi.fn(), recordFinalOnly:vi.fn(), stop: vi.fn(), status:vi.fn() } }));
vi.mock("@/lib/recordingSession", () => ({ createRecordingSession: vi.fn() }));
vi.mock("@/stores/sessions", () => ({ useSessionsStore:Object.assign((select: (s: unknown) => unknown) => select({ load: vi.fn() }),{getState:()=>({load:vi.fn().mockResolvedValue(undefined)})}) }));

afterEach(() => vi.unstubAllGlobals());

const options = { micBars: { current: [] }, systemBars: { current: [] } };
beforeEach(() => {
 vi.clearAllMocks();
 useVocabularyStore.getState().setSelection({});
 useRecordingStore.getState().reset();
 vi.stubGlobal("EventSource", class { close() {} });
 vi.mocked(recordingApi.start).mockResolvedValue({ success: true } as never);
 vi.mocked(createRecordingSession).mockResolvedValue({ id: "saved" } as never);
});

describe("recording language and finalization", () => {
 it('offers an explicit final-only action after unsupported admission without saving a preference automatically',async()=>{
  vi.mocked(recordingApi.start).mockRejectedValue(new ApiError('unsupported',409,'live-language-unsupported'));
  vi.mocked(recordingApi.recordFinalOnly).mockResolvedValue({success:true} as never);
  const {result,unmount}=renderHook(()=>useRecording(options));
  await act(async()=>{expect(await result.current.start()).toBe(false);});
  expect(result.current.liveStartError).toBe('live-language-unsupported');expect(recordingApi.recordFinalOnly).not.toHaveBeenCalled();
  await act(async()=>{expect(await result.current.recordFinalOnly()).toBe(true);});
  expect(recordingApi.recordFinalOnly).toHaveBeenCalledWith('both',expect.any(String),{});
  unmount();expect(recordingApi.stop).not.toHaveBeenCalled();
 });
 it('subscribes without a language override and closure releases observers without stopping capture',()=>{
  const source=vi.fn();vi.stubGlobal('EventSource',class{constructor(url:string){source(url);}close(){}addEventListener(){}});
  useRecordingStore.getState().startRecording();
  const {unmount}=renderHook(()=>useRecording(options));
  expect(source).toHaveBeenCalledWith('/api/sysrecord/live');expect(source).not.toHaveBeenCalledWith(expect.stringContaining('?lang='));
  unmount();expect(recordingApi.stop).not.toHaveBeenCalled();
 });
 it("delegates speech language to authoritative admission", async () => {
  const { result } = renderHook(() => useRecording(options));
  await act(async () => { await result.current.start(); });
  expect(recordingApi.start).toHaveBeenCalledWith("both", expect.any(String), {});
 });
 it("finishes native start even when browser microphone permission never resolves", async () => {
  vi.stubGlobal("navigator", {mediaDevices:{getUserMedia:vi.fn(() => new Promise(() => {}))}});
  const { result } = renderHook(() => useRecording(options));
  await act(async () => { expect(await result.current.start()).toBe(true); });
  expect(useRecordingStore.getState().recording).toBe(true);
 });
 it("displays the backend-saved final language and precise full-audio timestamps without saving again", async () => {
  useRecordingStore.getState().startRecording();
  useRecordingStore.setState({coordinatorMeetingId:"meeting-1"});
  const session={id:"saved",transcriptFinalized:true,language:"pt",duration:720,transcript:"Bom dia",segments:[{id:0,speaker:"Me",channel:"mic",text:"Bom dia",start:2.1,end:3.4}],speakers:["Me"],files:{wav:"audio.wav"},transcriptionModel:"parakeet-v3",liveModel:"base"};
  vi.mocked(recordingApi.stop).mockResolvedValue({path:"audio.wav",finalized:true,snapshot:{meetingId:"meeting-1",state:"completed",revision:8,startedAt:100,path:"audio.wav",seconds:720,mode:"both",segments:session.segments,speakerNames:{},session,error:null,maintenance:false}} as never);
  const { result } = renderHook(() => useRecording(options));
  await act(async () => { expect(await result.current.stop()).toBe(true); });
  expect(recordingApi.stop).toHaveBeenCalledWith("meeting-1",expect.any(String));
  expect(createRecordingSession).not.toHaveBeenCalled();
  expect(useRecordingStore.getState().resultLanguage).toBe("pt");
  expect(useRecordingStore.getState().currentSessionId).toBe("saved");
  expect(useRecordingStore.getState().segments[0].start).toBe(2.1);
 });
 it("does not save live text when the final pass fails", async () => {
  useRecordingStore.getState().startRecording();
  useRecordingStore.setState({coordinatorMeetingId:"meeting-1"});
  vi.mocked(recordingApi.stop).mockResolvedValue({ path: "audio.wav", finalized: false });
  const { result } = renderHook(() => useRecording(options));
  await act(async () => { expect(await result.current.stop()).toBe(false); });
  expect(createRecordingSession).not.toHaveBeenCalled();
 });
 it("does not acknowledge a recording when final persistence fails", async () => {
  useRecordingStore.getState().startRecording();
  useRecordingStore.setState({coordinatorMeetingId:"meeting-1",transcript:"A decision"});
  vi.mocked(recordingApi.stop).mockResolvedValue({ path:"audio.wav", finalized:true, language:"en", turns:[{id:0,speaker:"Ana",channel:"sys",text:"A decision",start:0,end:2}] });
  vi.mocked(createRecordingSession).mockRejectedValue(new Error("Final save failed"));
  const { result } = renderHook(() => useRecording(options));
  await act(async () => { expect(await result.current.stop()).toBe(false); });
  expect(useRecordingStore.getState().currentSessionId).toBeNull();
  expect(useRecordingStore.getState().transcript).toBe("A decision");
  expect(useRecordingStore.getState().processing).toBe(false);
 });
});

it('preserves rejected meeting additions, then consumes admitted additions before the next meeting',async()=>{
 const selection={glossaryId:'work',additions:[{term:'Private A'}]};useVocabularyStore.getState().setSelection(selection);
 vi.mocked(recordingApi.start).mockRejectedValueOnce(Error('admission failed')).mockResolvedValue({success:true} as never);
 const first=renderHook(()=>useRecording(options));await act(async()=>{expect(await first.result.current.start()).toBe(false);});expect(useVocabularyStore.getState().selection).toEqual(selection);
 await act(async()=>{expect(await first.result.current.start()).toBe(true);});expect(recordingApi.start).toHaveBeenLastCalledWith('both',expect.any(String),selection);expect(useVocabularyStore.getState().selection).toEqual({glossaryId:'work'});
 first.unmount();useRecordingStore.getState().reset();const second=renderHook(()=>useRecording(options));await act(async()=>{expect(await second.result.current.start()).toBe(true);});expect(recordingApi.start).toHaveBeenLastCalledWith('both',expect.any(String),{glossaryId:'work'});second.unmount();
});
