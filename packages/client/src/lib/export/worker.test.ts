import { afterEach, expect, test, vi } from 'vitest';
import { startMeetingExport } from './worker';
import { exportPreview } from './fixtures.test-support';
import { assertExportSize } from './bounds';
class FakeWorker {
 static instances: FakeWorker[] = [];
 onmessage: ((event: MessageEvent) => void) | null = null;
 onerror: ((event: ErrorEvent) => void) | null = null;
 messages: unknown[] = [];
 terminate = vi.fn();
 constructor(public url: URL, public options: WorkerOptions) { FakeWorker.instances.push(this); }
 postMessage = vi.fn((message: unknown) => { this.messages.push(message); });
 emit(value: unknown) { this.onmessage?.({ data: value } as MessageEvent); }
}
afterEach(() => { vi.unstubAllGlobals(); FakeWorker.instances = []; });
function worker() { vi.stubGlobal('Worker', FakeWorker); return FakeWorker; }
test('owns a module worker and resolves only the current source-bound job then terminates it', async () => {
 worker(); const p = exportPreview(); const task = startMeetingExport(p); const w = FakeWorker.instances[0]!;
 expect(w.options.type).toBe('module'); const message = w.messages[0] as { jobId: string; preview: unknown };
 expect(message.preview).toEqual(p);
 w.emit({ jobId: 'other', artifact: { bytes: new Uint8Array([1]), mime: 'application/pdf', extension: 'pdf', snapshotKey: p.snapshot.snapshotKey } });
 let done = false; task.result.then(() => { done = true; }); await Promise.resolve(); expect(done).toBe(false);
 const artifact = { bytes: new Uint8Array([1]), mime: 'application/pdf', extension: 'pdf', snapshotKey: p.snapshot.snapshotKey };
 w.emit({ jobId: message.jobId, artifact }); expect(await task.result).toEqual(artifact); expect(w.terminate).toHaveBeenCalledTimes(1);
});
test('cancel rejects, terminates once and ignores late output; failures can be retried', async () => {
 worker(); const task = startMeetingExport(exportPreview()), w = FakeWorker.instances[0]!;
 const rejection = expect(task.result).rejects.toMatchObject({ name: 'AbortError' }); task.cancel(); task.cancel(); await rejection;
 w.emit({ jobId: (w.messages[0] as { jobId: string }).jobId, artifact: { bytes: new Uint8Array([1]) } }); expect(w.terminate).toHaveBeenCalledTimes(1);
 const retry = startMeetingExport(exportPreview()), next = FakeWorker.instances[1]!;
 next.emit({ jobId: (next.messages[0] as { jobId: string }).jobId, error: 'Missing glyph' }); await expect(retry.result).rejects.toThrow('Missing glyph'); expect(next.terminate).toHaveBeenCalledTimes(1);
});
test('oversized frozen selected content fails before worker creation; submitted data is cloned', async () => {
 worker(); const p = exportPreview(); p.snapshot.transcript = 'é'.repeat(8_000_001);
 expect(() => startMeetingExport(p)).toThrow(/16,000,000/); expect(FakeWorker.instances).toHaveLength(0);
 const original = exportPreview(); const task = startMeetingExport(original); original.snapshot.title = 'Later';
 expect((FakeWorker.instances[0]!.messages[0] as { preview: { snapshot: { title: string } } }).preview.snapshot.title).toBe('Reunião / Meeting');
 const rejection = expect(task.result).rejects.toMatchObject({ name: 'AbortError' }); task.cancel(); await rejection;
});
test('selected size matches server payload limit without counting unselected task availability or review', () => {
 const p = exportPreview(), { generatedAt: _date, snapshotKey: _key, ...snapshot } = p.snapshot;
 const payload = { format: p.format, selection: p.selection, snapshot };
 const bytes = new TextEncoder().encode(JSON.stringify(payload)).length;
 p.snapshot.transcript = 'x'.repeat(16_000_000 - bytes + new TextEncoder().encode(JSON.stringify(snapshot.transcript)).length - 2);
 p.availability.tasks = [{ id: 'unselected', title: 'Unselected'.repeat(100), revision: 'other', stale: false }];
 p.selection.reviewedNotesHash = 'ack'; p.selection.reviewedTaskRevisions = { task: 'r1' };
 expect(() => assertExportSize(p)).not.toThrow(); p.snapshot.transcript += 'x'; expect(() => assertExportSize(p)).toThrow(/16,000,000/);
});
test('rejects an artifact of a different format and a worker runtime error, releasing both workers', async () => {
 worker(); const task = startMeetingExport(exportPreview()), w = FakeWorker.instances[0]!;
 w.emit({ jobId: (w.messages[0] as { jobId: string }).jobId, artifact: { bytes: new Uint8Array([1]), extension: 'pdf', mime: 'text/vtt', snapshotKey: 'snapshot' } });
 await expect(task.result).rejects.toThrow('invalid artifact'); expect(w.terminate).toHaveBeenCalledTimes(1);
 const retry = startMeetingExport(exportPreview()), next = FakeWorker.instances[1]!; next.onerror?.({} as ErrorEvent);
 await expect(retry.result).rejects.toThrow('retry'); expect(next.terminate).toHaveBeenCalledTimes(1);
});
