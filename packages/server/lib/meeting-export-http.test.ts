import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AutomaticNotesService } from './automatic-notes';
import { desktopRequestAllowed } from './desktop-permissions';
import { meetingExportResponse } from './meeting-export-http';
import type { TaskView } from '../../shared/types/tasks';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
function fixture() {
 const dir = mkdtempSync(join(tmpdir(), 'heed-export-http-'));
 const notes = new AutomaticNotesService({ sessionsDir: dir, getSettings: () => ({ enabled: false, templateId: '', model: null, language: 'meeting' }), loadTemplate: () => undefined, generate: async () => { throw Error('Unexpected model call'); }, isBusy: () => false });
 const session = notes.create({ id: 'synthetic', title: 'Meeting', transcript: 'Ana: ação', duration: 2, language: 'pt', transcriptFinalized: true,
  speakers: ['Ana'], segments: [{ speaker: 'Ana', start: 0, end: 2, text: 'ação' }], aiNotes: 'Earlier notes', files: { wav: '/PRIVATE/audio' } });
 let tasks: TaskView[] = [];
 const readers = { session: (id: string) => notes.get(id), tasks: () => tasks, now: () => '2026-10-07T03:00:00Z' };
 const server: Bun.Server<undefined> = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req): Promise<Response> { return await meetingExportResponse(req, readers, desktopRequestAllowed(req, server.port!)) ?? new Response(null, { status: 404 }); } });
 cleanups.push(() => { server.stop(true); rmSync(dir, { recursive: true, force: true }); });
 const base = `http://127.0.0.1:${server.port}`;
 const input = { expectedTranscriptRevision: session.transcriptRevision!, expectedTranscriptVersion: session.transcriptVersion!, format: 'pdf', selection: { transcript: true, notes: false, taskIds: [], speakers: true, timestamps: true } };
 const request = (action: string, value: unknown = input, init: RequestInit = {}) => fetch(`${base}/api/sessions/synthetic/export-${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value), ...init });
 return { notes, dir, readers, server, input, session, base, request, setTasks: (value: TaskView[]) => { tasks = value; } };
}
test('actual HTTP preview and validation are protected, sanitized and read-only', async () => {
 const f = fixture(); const before = readFileSync(join(f.dir, 'synthetic.json'), 'utf8');
 const denied = await f.request('preview', undefined, { headers: { origin: 'https://outside.example' } }); expect(denied.status).toBe(403);
 const response = await f.request('preview'); expect(response.status).toBe(200); const preview = await response.json();
 expect(JSON.stringify(preview)).not.toContain('PRIVATE');
 const validated = await f.request('validate', { ...f.input, snapshotKey: preview.snapshot.snapshotKey }); expect(validated.status).toBe(200);
 expect(await validated.json()).toEqual({ valid: true, snapshotKey: preview.snapshot.snapshotKey });
 expect(readFileSync(join(f.dir, 'synthetic.json'), 'utf8')).toBe(before);
});
test('actual HTTP parsing rejects malformed/unknown/oversized bodies and unsafe decoded IDs', async () => {
 const f = fixture();
 expect((await f.request('preview', null)).status).toBe(400);
 expect((await f.request('preview', f.input, { body: '{' })).status).toBe(400);
 expect((await f.request('preview', { ...f.input, unknown: true })).status).toBe(400);
 expect((await f.request('preview', f.input, { body: 'x'.repeat(16_000_001) })).status).toBe(413);
 for (const id of ['%2fprivate', 'synthetic%00', '%ZZ', 'synthetic%2ejson']) {
  expect((await fetch(`${f.base}/api/sessions/${id}/export-preview`, { method: 'POST', body: JSON.stringify(f.input) })).status).toBe(400);
 }
 expect((await fetch(`${f.base}/api/sessions/missing/export-preview`, { method: 'POST', body: JSON.stringify(f.input) })).status).toBe(404);
 const chunks = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(8_000_000)); controller.enqueue(new Uint8Array(8_000_001)); controller.close(); } });
 const streamed = new Request(`${f.base}/api/sessions/synthetic/export-preview`, { method: 'POST', body: chunks, headers: { 'content-length': '1' }, duplex: 'half' } as RequestInit);
 expect((await meetingExportResponse(streamed, f.readers, true))?.status).toBe(413);
 let read = false; const hostile = new Request(`${f.base}/api/sessions/synthetic/export-preview`, { method: 'POST', body: new ReadableStream({ pull() { read = true; throw Error('Must not read'); } }) , duplex: 'half' } as RequestInit);
 expect((await meetingExportResponse(hostile, f.readers, false))?.status).toBe(403);
 // Request construction may pull once, so permission protection is also checked with a throwing body accessor.
 const denied = new Request(`${f.base}/api/sessions/synthetic/export-preview`, { method: 'POST' });
 Object.defineProperty(denied, 'body', { get() { throw Error('Denied body read'); } });
 expect((await meetingExportResponse(denied, f.readers, false))?.status).toBe(403);
 void read;
});
test('old HTTP export review conflicts after rename and edit/revert ABA; frozen preview stays unchanged', async () => {
 const f = fixture(); const p = await (await f.request('preview')).json();
 const validate = { ...f.input, snapshotKey: p.snapshot.snapshotKey };
 f.notes.patch('synthetic', { title: 'Renamed' }); expect((await f.request('validate', validate)).status).toBe(409);
 f.notes.patch('synthetic', { title: 'Meeting' }); expect((await f.request('validate', validate)).status).toBe(200);
 const edited = f.notes.commitTranscript('synthetic', { ...f.input, action: 'edit', requestId: 'correct', target: { kind: 'segment', index: 0 }, text: 'Corrected' });
 expect((await f.request('validate', validate)).status).toBe(409);
 f.notes.commitTranscript('synthetic', { expectedTranscriptRevision: edited.transcriptRevision!, expectedTranscriptVersion: edited.transcriptVersion!, action: 'revert', requestId: 'undo', editId: edited.transcriptEditing!.edits[0]!.id });
 expect(f.notes.get('synthetic')!.transcriptRevision).toBe(f.session.transcriptRevision);
 expect((await f.request('validate', validate)).status).toBe(409);
 expect(p.snapshot.transcript).toBe('ação');
});
test('selected notes and accepted task mutations invalidate HTTP review without exporting foreign evidence', async () => {
 const f = fixture();
 const t: TaskView = { id: 'task', revision: 'r1', sessionId: f.session.id, meetingTitle: 'Meeting', suggestionId: 's', sourceRevision: f.session.transcriptRevision!,
  evidence: [], kind: 'explicit', title: 'Enviar ação', description: '', assignee: null, dueDate: null, status: 'open', completedAt: null,
  createdAt: '2026-10-07', updatedAt: '2026-10-07', sourceState: 'available', audioAvailable: false };
 f.setTasks([t]);
 const input = { ...f.input, selection: { ...f.input.selection, notes: true, taskIds: ['task'] } };
 const p = await (await f.request('preview', input)).json();
 const reviewed = { ...input, selection: { ...input.selection, reviewedNotesHash: p.review.notesHash, reviewedTaskRevisions: p.review.taskRevisions }, snapshotKey: p.snapshot.snapshotKey, staleAcknowledgmentKey: p.review.staleContentKey };
 expect((await f.request('validate', reviewed)).status).toBe(200);
 f.setTasks([{ ...t, revision: 'r2', status: 'completed' }]); expect((await f.request('validate', reviewed)).status).toBe(409);
 f.setTasks([]); expect((await f.request('validate', reviewed)).status).toBe(404);
 f.setTasks([t]);
 f.notes.patch('synthetic', { aiNotes: 'Regenerated notes', expectedTranscriptRevision: f.session.transcriptRevision!, expectedTranscriptVersion: f.session.transcriptVersion!, expectedNotes: f.session.aiNotes });
 expect((await f.request('validate', reviewed)).status).toBe(409);
});
