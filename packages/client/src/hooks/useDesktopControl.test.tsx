import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useDesktopControl } from "./useDesktopControl";
import { useRecordingStore } from "@/stores/recording";
beforeEach(() => {useRecordingStore.getState().reset(); vi.useFakeTimers();});
afterEach(() => {vi.useRealTimers();vi.unstubAllGlobals();});
it("a newly opened tab reflects native capture instead of displaying an idle timer", async () => {
 vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response(JSON.stringify({command:null,status:{recording:true,seconds:666}}))));
 renderHook(() => useDesktopControl({start:vi.fn(),stop:vi.fn()},vi.fn()));
 await act(async () => {await vi.advanceTimersByTimeAsync(0);});
 expect(useRecordingStore.getState().recording).toBe(true);
 expect(useRecordingStore.getState().seconds).toBe(666);
});
it("a tab follows authoritative stop status without retaining a phantom recording", async () => {
 useRecordingStore.getState().startRecording();
 vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response(JSON.stringify({command:null,status:{recording:false,seconds:50}}))));
 renderHook(() => useDesktopControl({start:vi.fn(),stop:vi.fn()},vi.fn()));
 await act(async () => {await vi.advanceTimersByTimeAsync(0);});
 expect(useRecordingStore.getState().recording).toBe(false);
 expect(useRecordingStore.getState().seconds).toBe(50);
});
