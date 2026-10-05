import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import type { Session } from '@heed/shared';
import { useAutomaticNotesPolling } from './useAutomaticNotesPolling';
import { useSessionsStore } from '@/stores/sessions';
const session = { id: 's', transcriptRevision: 'r', aiNotes: '', notesJobs: { 'notes-r': { sourceRevision: 'r', status: 'running' } } } as unknown as Session;
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
test('refreshes open notes from saved sessions and stops its timer on unmount', async () => {
 vi.useFakeTimers();
 const saved = { ...session, aiNotes: 'Saved automatic notes', notesJobs: { 'notes-r': { sourceRevision: 'r', status: 'completed' } } };
 const fetchMock = vi.fn(async () => Response.json({ sessions: [saved], tags: [], revision: "current" })); vi.stubGlobal('fetch', fetchMock);
 useSessionsStore.setState({ sessions: [session], viewing: session });
 const view = renderHook(() => useAutomaticNotesPolling());
 await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
 expect(useSessionsStore.getState().viewing?.aiNotes).toBe('Saved automatic notes');
 view.unmount(); const calls = fetchMock.mock.calls.length;
 await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
 expect(fetchMock).toHaveBeenCalledTimes(calls);
});
