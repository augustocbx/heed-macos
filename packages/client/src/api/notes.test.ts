import { afterEach, expect, test, vi } from 'vitest';
import { generateNotes } from './notes';
afterEach(() => vi.unstubAllGlobals());
function respond(events: string) {
 vi.stubGlobal('fetch', vi.fn(async () => new Response(events, { headers: { 'Content-Type': 'text/event-stream' } })));
}
test('awaits successful note persistence before resolving generation', async () => {
 respond('data: {"token":"Hello"}\n\ndata: {"done":true}\n\n');
 let resolve!: () => void;
 const persisted = new Promise<void>(done => { resolve = done; });
 let completed = false;
 const generation = generateNotes('Transcript', 'pt', 'general', { onDone: () => persisted }).then(() => { completed = true; });
 await new Promise(done => setTimeout(done, 10));
 expect(completed).toBe(false);
 resolve(); await generation;
 expect(completed).toBe(true);
});
test('rejects truncated generation without saving partial notes', async () => {
 respond('data: {"token":"Partial"}\n\n');
 const onDone = vi.fn();
 await expect(generateNotes('Transcript', 'pt', 'general', { onDone })).rejects.toThrow('incomplete');
 expect(onDone).not.toHaveBeenCalled();
});
test('rejects malformed events and persistence failures', async () => {
 respond('data: invalid\n\ndata: {"done":true}\n\n');
 await expect(generateNotes('Transcript', 'en', 'general', {})).rejects.toThrow();
 respond('data: {"token":"Notes"}\n\ndata: {"done":true}\n\n');
 await expect(generateNotes('Transcript', 'en', 'general', { onDone: async () => { throw new Error('save failed'); } })).rejects.toThrow('save failed');
});
