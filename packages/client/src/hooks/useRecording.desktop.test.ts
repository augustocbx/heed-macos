import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRecording } from './useRecording';
import { recordingApi } from '@/api/recording';
import { useRecordingStore } from '@/stores/recording';
beforeEach(() => {
 useRecordingStore.getState().reset();
 useRecordingStore.getState().startRecording();
 vi.spyOn(recordingApi,'stop').mockResolvedValue({path:'/test.wav'});
});
afterEach(() => {vi.restoreAllMocks();vi.unstubAllGlobals();});
for (const [label,stream] of [['SSE error','event: error\ndata: {"message":"Transcription failed"}\n\n'],['unfinished stream','event: step\ndata: {"message":"Processing"}\n\n']]) {
 it(`rejects ${label} and releases the processing state`, async () => {
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(stream)));
  const {result}=renderHook(() => useRecording({micBars:{current:[]},systemBars:{current:[]},getLanguage:()=> 'pt'}));
  let success:boolean|undefined;
  await act(async () => {success=await result.current.stop('pt');});
  expect(success).toBe(false);
  expect(useRecordingStore.getState().processing).toBe(false);
 });
}
