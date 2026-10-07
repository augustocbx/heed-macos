import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useDesktopControl } from "./useDesktopControl";
import { useRecordingStore } from "@/stores/recording";
beforeEach(() => {useRecordingStore.getState().reset(); vi.useFakeTimers();});
afterEach(() => {vi.useRealTimers();vi.unstubAllGlobals();});
it("a newly opened tab reflects native capture instead of displaying an idle timer", async () => {
 vi.stubGlobal("fetch",vi.fn().mockImplementation(async () => new Response(JSON.stringify({command:null,status:{recording:true,seconds:666}}))));
 renderHook(() => useDesktopControl());
 await act(async () => {await vi.advanceTimersByTimeAsync(0);});
 expect(useRecordingStore.getState().recording).toBe(true);
 expect(useRecordingStore.getState().seconds).toBe(666);
});
it("a tab follows authoritative stop status without retaining a phantom recording", async () => {
 useRecordingStore.getState().startRecording();
 vi.stubGlobal("fetch",vi.fn().mockImplementation(async () => new Response(JSON.stringify({command:null,status:{recording:false,seconds:50}}))));
 renderHook(() => useDesktopControl());
 await act(async () => {await vi.advanceTimersByTimeAsync(0);});
 expect(useRecordingStore.getState().recording).toBe(false);
 expect(useRecordingStore.getState().seconds).toBe(50);
});
it("a newly opened idle tab ignores the previous controller's elapsed time", async () => {
 vi.stubGlobal("fetch",vi.fn().mockImplementation(async () => new Response(JSON.stringify({command:null,status:{recording:false,seconds:4}}))));
 renderHook(() => useDesktopControl());
 await act(async () => {await vi.advanceTimersByTimeAsync(1000);});
 expect(fetch).toHaveBeenCalledTimes(2);
 expect(useRecordingStore.getState().recording).toBe(false);
 expect(useRecordingStore.getState().seconds).toBe(0);
});
it("resetting a recording leaves an empty idle timer despite later stale polls", async () => {
 useRecordingStore.setState({seconds:4});
 vi.stubGlobal("fetch",vi.fn().mockImplementation(async () => new Response(JSON.stringify({command:null,status:{recording:false,seconds:4}}))));
 renderHook(() => useDesktopControl());
 await act(async () => {await vi.advanceTimersByTimeAsync(0);});
 expect(useRecordingStore.getState().seconds).toBe(0);
 useRecordingStore.getState().reset();
 await act(async () => {await vi.advanceTimersByTimeAsync(1000);});
 expect(fetch).toHaveBeenCalledTimes(2);
 expect(useRecordingStore.getState().seconds).toBe(0);
});
it.each([
 {processing:true},
 {transcript:"Finished meeting"},
 {segments:[{id:0,speaker:"Speaker 1",text:"Finished meeting",start:0,end:50}]},
])("idle polls preserve the duration of local processing or results: %j", async (result) => {
 useRecordingStore.setState({seconds:50,...result});
 vi.stubGlobal("fetch",vi.fn().mockImplementation(async () => new Response(JSON.stringify({command:null,status:{recording:false,seconds:4}}))));
 renderHook(() => useDesktopControl());
 await act(async () => {await vi.advanceTimersByTimeAsync(1000);});
 expect(useRecordingStore.getState().seconds).toBe(50);
});
