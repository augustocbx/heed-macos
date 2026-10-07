import { afterEach, expect, test, vi } from 'vitest';
import { meetingExportApi } from './meeting-export';
import type { MeetingExportPreviewInput } from '@heed/shared';
afterEach(() => vi.unstubAllGlobals());
const input: MeetingExportPreviewInput = { expectedTranscriptRevision: 'revision', expectedTranscriptVersion: 3, format: 'pdf', selection: { transcript: true, notes: false, taskIds: [], speakers: false, timestamps: false } };
test('encodes IDs and posts the exact typed preview/validate payload', async () => {
 const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ valid: true, snapshotKey: 'key' })); vi.stubGlobal('fetch', fetcher);
 await meetingExportApi.preview('meeting / name', input);
 expect(fetcher.mock.calls[0]).toEqual(['/api/sessions/meeting%20%2F%20name/export-preview', expect.objectContaining({ method: 'POST', body: JSON.stringify(input) })]);
 await meetingExportApi.validate('meeting', { ...input, snapshotKey: 'key' });
 expect(fetcher.mock.calls[1]?.[0]).toBe('/api/sessions/meeting/export-validate');
});
test.each([409, 413])('preserves actionable HTTP %i errors', async status => {
 vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'Refresh and review selected content.' }, { status })));
 await expect(meetingExportApi.preview('meeting', input)).rejects.toMatchObject({ status, message: 'Refresh and review selected content.' });
});
