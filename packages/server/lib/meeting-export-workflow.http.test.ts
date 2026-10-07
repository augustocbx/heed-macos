import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

test('production correction, derived review and frozen export preserve audio and source provenance', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'heed-export-workflow-'));
  const recordings = join(dir, 'recordings');
  mkdirSync(recordings);
  const wav = join(recordings, 'synthetic.wav');
  writeFileSync(wav, Buffer.alloc(32044));
  const digest = () => createHash('sha256').update(readFileSync(wav)).digest('hex');
  const audioBefore = digest();
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ automatic_notes: { enabled: false } }));
  const calls: string[] = [];
  const sidecar = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req) {
      calls.push(`${req.method} ${new URL(req.url).pathname}`);
      return Response.json({ whisper: false, models: [] });
    },
  });
  const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() });
  const port = reservation.port!;
  reservation.stop(true);
  const origin = `http://127.0.0.1:${port}`;
  const child = Bun.spawn([process.execPath, resolve(import.meta.dir, '../server.ts')], {
    env: {
      ...process.env,
      PORT: String(port),
      HEED_API_PORT: String(port),
      HEED_APP_DIR: dir,
      HEED_RECORDINGS_DIR: recordings,
      OLLAMA_HOST: `http://127.0.0.1:${sidecar.port}`,
      HEED_TRANSCRIPTION_URL: `http://127.0.0.1:${sidecar.port}`,
    },
    stdout: 'ignore',
    stderr: 'ignore',
  });
  async function call(path: string, body?: unknown, method = 'POST') {
    const response = await fetch(origin + path, {
      method,
      headers: { 'Content-Type': 'application/json', Origin: origin },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, value: await response.json() };
  }
  const guard = (session: any) => ({
    expectedTranscriptRevision: session.transcriptRevision,
    expectedTranscriptVersion: session.transcriptVersion,
  });
  const selection = {
    transcript: true,
    notes: true,
    taskIds: ['accepted-task'],
    speakers: true,
    timestamps: true,
  };
  const input = (session: any) => ({ ...guard(session), format: 'pdf', selection });
  const reviewed = (preview: any) => ({
    expectedTranscriptRevision: preview.snapshot.sourceRevision,
    expectedTranscriptVersion: preview.snapshot.sourceVersion,
    format: preview.format,
    selection: {
      ...preview.selection,
      reviewedNotesHash: preview.review.notesHash,
      reviewedTaskRevisions: preview.review.taskRevisions,
    },
    snapshotKey: preview.snapshot.snapshotKey,
    staleAcknowledgmentKey: preview.review.staleContentKey,
  });
  try {
    const deadline = Date.now() + 8000;
    let ready = false;
    while (Date.now() < deadline) {
      try {
        ready = (await fetch(origin + '/.well-known/heed-service')).ok;
        if (ready) break;
      } catch {}
      await Bun.sleep(25);
    }
    expect(ready).toBe(true);
    const initial = await call('/api/sessions', {
      id: 'workflow',
      title: 'Synthetic review',
      createdAt: '2026-10-06T12:00:00Z',
      duration: 2,
      language: 'pt',
      transcript: 'Original ação',
      segments: [{ speaker: 'Ana', text: 'Original ação', start: 0, end: 2, channel: 'mic' }],
      speakers: ['Ana'],
      aiNotes: '',
      files: { wav, srt: 'PRIVATE_EXPORT_SENTINEL' },
      transcriptFinalized: true,
      tags: [],
      pinned: false,
      summary: '',
      embeddings: { Ana: [1, 2] },
    });
    expect(initial.status).toBe(200);
    const withNotes = await call(
      '/api/sessions?id=workflow',
      { ...guard(initial.value), aiNotes: 'Reviewed notes with ação', expectedNotes: '' },
      'PATCH',
    );
    expect(withNotes.status).toBe(200);
    writeFileSync(
      join(dir, 'tasks.json'),
      JSON.stringify({
        version: 1,
        reviews: {},
        decisions: {},
        tasks: [
          {
            id: 'accepted-task',
            revision: 'r1',
            sessionId: 'workflow',
            meetingTitle: 'Synthetic review',
            suggestionId: 'fixture',
            sourceRevision: initial.value.transcriptRevision,
            evidence: [],
            kind: 'explicit',
            title: 'Deliver ação',
            description: '',
            assignee: null,
            dueDate: null,
            status: 'open',
            completedAt: null,
            createdAt: '2026-10-06',
            updatedAt: '2026-10-06',
          },
        ],
      }),
    );
    const old = await call('/api/sessions/workflow/export-preview', input(withNotes.value));
    expect(old.status).toBe(200);
    expect((await call('/api/sessions/workflow/export-validate', reviewed(old.value))).status).toBe(200);
    const correction = await call('/api/sessions/workflow/transcript/commands', {
      ...guard(withNotes.value),
      requestId: 'export-correction',
      action: 'edit',
      target: { kind: 'segment', index: 0 },
      text: 'Corrected ação',
    });
    expect(correction.status).toBe(200);
    expect((await call('/api/sessions/workflow/export-validate', reviewed(old.value))).status).toBe(409);
    const restored = await call('/api/sessions/workflow/transcript/commands', {
      ...guard(correction.value),
      requestId: 'export-revert',
      action: 'revert',
      editId: correction.value.transcriptEditing.edits[0].id,
    });
    expect(restored.status).toBe(200);
    expect(restored.value.transcriptRevision).toBe(initial.value.transcriptRevision);
    expect(restored.value.transcriptVersion).toBeGreaterThan(initial.value.transcriptVersion);
    expect((await call('/api/sessions/workflow/export-validate', reviewed(old.value))).status).toBe(409);
    expect(restored.value.notesMetadata.stale).toBe(true);
    const preview = await call('/api/sessions/workflow/export-preview', input(restored.value));
    expect(preview.status).toBe(200);
    expect(preview.value.snapshot.notes.stale).toBe(true);
    const completed = await call('/api/tasks', {
      action: 'update',
      id: 'accepted-task',
      revision: 'r1',
      patch: { status: 'completed' },
    });
    expect(completed.status).toBe(200);
    expect((await call('/api/sessions/workflow/export-validate', reviewed(preview.value))).status).toBe(409);
    const current = await call('/api/sessions/workflow/export-preview', input(restored.value));
    expect(current.status).toBe(200);
    const regenerated = await call(
      '/api/sessions?id=workflow',
      { ...guard(restored.value), aiNotes: 'Revised reviewed notes', expectedNotes: restored.value.aiNotes },
      'PATCH',
    );
    expect(regenerated.status).toBe(200);
    expect((await call('/api/sessions/workflow/export-validate', reviewed(current.value))).status).toBe(409);
    const final = await call('/api/sessions/workflow/export-preview', input(regenerated.value));
    expect(final.status).toBe(200);
    expect(final.value.snapshot.tasks[0].status).toBe('completed');
    expect((await call('/api/sessions/workflow/export-validate', reviewed(final.value))).status).toBe(200);
    const diskBefore = readFileSync(join(dir, 'sessions', 'workflow.json'), 'utf8'),
      taskBefore = readFileSync(join(dir, 'tasks.json'), 'utf8');
    expect((await call('/api/sessions/workflow/export-validate', reviewed(final.value))).status).toBe(200);
    expect(readFileSync(join(dir, 'sessions', 'workflow.json'), 'utf8')).toBe(diskBefore);
    expect(readFileSync(join(dir, 'tasks.json'), 'utf8')).toBe(taskBefore);
    const frozen = JSON.stringify(final.value);
    await call('/api/sessions/workflow/transcript/commands', {
      ...guard(regenerated.value),
      requestId: 'after-export-validation',
      action: 'edit',
      target: { kind: 'segment', index: 0 },
      text: 'Later source',
    });
    expect(JSON.stringify(final.value)).toBe(frozen);
    expect(final.value.snapshot.transcript).toBe('Original ação');
    expect(JSON.stringify(final.value)).not.toContain('PRIVATE_EXPORT_SENTINEL');
    expect(JSON.stringify(final.value)).not.toContain('embeddings');
    expect(digest()).toBe(audioBefore);
    expect(
      calls.filter((call) => !call.startsWith('GET ') || /generate|chat|transcribe|finalize|pull/.test(call)),
    ).toEqual([]);
  } finally {
    child.kill();
    await child.exited;
    sidecar.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
}, 20000);
