import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRecording } from './useRecording';
import { recordingApi } from '@/api/recording';
import { useRecordingStore } from '@/stores/recording';
beforeEach(() => {
 useRecordingStore.getState().reset();
 useRecordingStore.getState().startRecording();
 vi.spyOn(recordingApi,'stop').mockResolvedValue({path:'/test.wav', finalized:false});
});
afterEach(() => {vi.restoreAllMocks();vi.unstubAllGlobals();});
for (const label of ['failed final pass', 'unfinished final pass']) {
 it(`rejects ${label} and releases the processing state`, async () => {
  if (label === 'failed final pass') vi.mocked(recordingApi.stop).mockRejectedValue(new Error('Transcription failed'));
  const {result}=renderHook(() => useRecording({micBars:{current:[]},systemBars:{current:[]},getLanguage:()=> 'pt'}));
  let success:boolean|undefined;
  await act(async () => {success=await result.current.stop('pt');});
  expect(success).toBe(false);
  expect(useRecordingStore.getState().processing).toBe(false);
 });
}
