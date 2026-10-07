import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Session } from '../../shared/types/session';
import { SessionTags, atomicWrite } from './session-tags';
import { AutomaticNotesService } from './automatic-notes';
import { TranscriptService } from './transcript-service';
import { transcriptEditingResponse } from './transcript-editing-http';
import { desktopRequestAllowed } from './desktop-permissions';
import { transcriptEvidence } from './meeting-chat';
import { portableMeeting, validateMeeting, encode } from './portable-schema';
import { preparePortableTranscript, sessionFromPortable } from './portable-transcript';

const now = '2026-10-06T12:00:00.000Z';
const guard = (session: Session) => ({
  expectedTranscriptRevision: session.transcriptRevision!,
  expectedTranscriptVersion: session.transcriptVersion!,
});

test('two HTTP clients preserve recovery, seek identity and media across correction, restart and candidate import', async () => {
  const root = mkdtempSync(join(tmpdir(), 'heed-transcript-workflow-'));
  const dir = join(root, 'sessions');
  mkdirSync(dir);
  const audio = join(root, 'public-silent.wav');
  writeFileSync(audio, Buffer.alloc(32044));
  const digest = () => createHash('sha256').update(readFileSync(audio)).digest('hex');
  const beforeAudio = digest();
  const store = new SessionTags(dir);
  const options = {
    sessionsDir: dir,
    sessionStore: store,
    getSettings: () => ({ enabled: false, templateId: '', model: null, language: 'meeting' as const }),
    loadTemplate: () => undefined,
    generate: async () => {
      throw Error('Unexpected model call');
    },
    isBusy: () => false,
    now: () => new Date(now),
  };
  let notes = new AutomaticNotesService(options);
  const original = notes.create({
    id: 'workflow',
    title: 'Synthetic EN/PT review',
    createdAt: now,
    duration: 6,
    language: 'pt',
    transcriptFinalized: true,
    speakers: ['Ana', 'Bruno'],
    transcript: '',
    aiNotes: 'Original notes',
    tags: ['QA'],
    pinned: false,
    summary: '',
    files: { wav: audio },
    segments: [
      { speaker: 'Ana', start: 0, end: 3, channel: 'mic', auto: false, text: 'Jon review API.' },
      {
        speaker: 'Bruno',
        start: 3,
        end: 6,
        channel: 'sys',
        overlap: false,
        auto: false,
        text: 'Joao revisão API.',
      },
    ],
  });
  let service = new TranscriptService({ notes, store, now: () => now });
  let server: Bun.Server<undefined>;
  function start() {
    server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(req): Promise<Response> {
        const allowed = desktopRequestAllowed(req, server.port!);
        const result = await transcriptEditingResponse(req, service, allowed);
        if (result) return result;
        if (!allowed) return new Response(null, { status: 403 });
        const url = new URL(req.url);
        if (req.method === 'GET' && url.pathname === '/meeting') return Response.json(notes.get('workflow'));
        if (req.method === 'PATCH' && url.pathname === '/meeting') {
          try {
            return Response.json(notes.patch('workflow', await req.json()));
          } catch (error) {
            return Response.json({ error: (error as Error).message }, { status: 409 });
          }
        }
        return new Response(null, { status: 404 });
      },
    });
  }
  start();
  async function call(path: string, body?: unknown, method = 'POST') {
    const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, value: await response.json() };
  }
  const command = (body: unknown) => call('/api/sessions/workflow/transcript/commands', body);
  try {
    const clientA = (await call('/meeting', undefined, 'GET')).value as Session;
    const clientB = (await call('/meeting', undefined, 'GET')).value as Session;
    const edit = {
      ...guard(clientA),
      requestId: 'proper-name',
      action: 'edit',
      target: { kind: 'segment', index: 1 },
      text: 'João revisão API.\nAção confirmada.',
    };
    const corrected = await command(edit);
    expect(corrected.status).toBe(200);
    expect(corrected.value.transcript).toContain('João');
    const stale = await command({
      ...guard(clientB),
      requestId: 'old-tab',
      action: 'edit',
      target: { kind: 'segment', index: 0 },
      text: 'John',
    });
    expect(stale.status).toBe(409);
    const english = await command({
      ...guard(corrected.value),
      requestId: 'english-proper-name',
      action: 'edit',
      target: { kind: 'segment', index: 0 },
      text: 'John review API.',
    });
    expect(english.status).toBe(200);
    expect(english.value.transcript).toContain('John review');
    expect(corrected.value.notesMetadata.stale).toBe(true);
    const beforePreview = readFileSync(join(dir, 'workflow.json'), 'utf8');
    const input = { query: 'API', replacement: 'Interface', caseSensitive: true, wholeWord: true };
    const preview = await call('/api/sessions/workflow/transcript/preview', {
      input,
      guard: guard(english.value),
    });
    expect(preview.status).toBe(200);
    expect(preview.value.matchCount).toBe(2);
    expect(preview.value.changes).toHaveLength(2);
    expect(readFileSync(join(dir, 'workflow.json'), 'utf8')).toBe(beforePreview);
    const replaced = await command({
      ...guard(english.value),
      requestId: 'replace-terms',
      action: 'replace',
      input,
      expectedPreviewKey: preview.value.key,
    });
    expect(replaced.status).toBe(200);
    const renamed = await call(
      '/meeting',
      {
        ...guard(replaced.value),
        speakers: ['Ana', 'Bruno renamed'],
        segments: replaced.value.segments.map((segment: any) => ({
          ...segment,
          speaker: segment.speaker === 'Bruno' ? 'Bruno renamed' : segment.speaker,
        })),
      },
      'PATCH',
    );
    expect(renamed.status).toBe(200);
    const restored = await command({
      ...guard(renamed.value),
      requestId: 'revert-terms',
      action: 'revert',
      editId: replaced.value.transcriptEditing.edits.at(-1).id,
    });
    expect(restored.status).toBe(200);
    expect(restored.value.segments[1].speaker).toBe('Bruno renamed');
    expect(restored.value.transcript).toContain('João revisão API.');
    expect(
      restored.value.segments.map(({ start, end, channel, auto, overlap }: any) => ({
        start,
        end,
        channel,
        auto,
        overlap,
      })),
    ).toEqual(
      original.segments.map(({ start, end, channel, auto, overlap }) => ({
        start,
        end,
        channel,
        auto,
        overlap,
      })),
    );
    const evidence = transcriptEvidence(restored.value);
    expect(evidence.some((item) => item.quote.includes('João'))).toBe(true);
    expect(evidence.every((item) => item.sourceRevision === restored.value.transcriptRevision)).toBe(true);
    const retryBytes = readFileSync(join(dir, 'workflow.json'), 'utf8');
    expect((await command(edit)).status).toBe(200);
    expect(readFileSync(join(dir, 'workflow.json'), 'utf8')).toBe(retryBytes);
    server.stop(true);
    notes = new AutomaticNotesService(options);
    service = new TranscriptService({ notes, store, now: () => now });
    start();
    expect((await call('/meeting', undefined, 'GET')).value.transcript).toBe(restored.value.transcript);
    const finalResult = {
      success: true,
      finalized: true,
      duration: 6,
      text: 'Candidate revisão.',
      segments: [{ speaker: 'Speaker 1', start: 0, end: 6, channel: 'mic', text: 'Candidate revisão.' }],
      speakers: ['Speaker 1'],
      metadata: { language: 'pt', model: 'base' },
      files: { wav: '/PRIVATE_EXPORT_SENTINEL', srt: '', txt: '' },
      wordCount: 2,
    };
    const staged = await call('/api/sessions/workflow/transcript/candidates', {
      requestId: 'candidate-staging',
      base: guard(restored.value),
      result: finalResult,
    });
    expect(staged.status).toBe(200);
    expect(staged.value.transcript).toBe(restored.value.transcript);
    expect(staged.value.transcriptVersion).toBe(restored.value.transcriptVersion);
    const firstCandidate = staged.value.transcriptEditing.candidates[0];
    const discarded = await call(
      `/api/sessions/workflow/transcript/candidates/${firstCandidate.id}/discard`,
      { requestId: 'discard-candidate' },
    );
    expect(discarded.status).toBe(200);
    expect(discarded.value.transcript).toBe(restored.value.transcript);
    const second = await call('/api/sessions/workflow/transcript/candidates', {
      requestId: 'candidate-staging-two',
      base: guard(discarded.value),
      result: finalResult,
    });
    expect(second.status).toBe(200);
    const accepted = await command({
      ...guard(second.value),
      requestId: 'explicit-acceptance',
      action: 'accept-candidate',
      candidateId: second.value.transcriptEditing.candidates[0].id,
    });
    expect(accepted.status).toBe(200);
    expect(accepted.value.transcript).toBe('Candidate revisão.');
    expect(accepted.value.transcriptEditing.generations).toHaveLength(2);
    expect(accepted.value.transcriptEditing.edits).toHaveLength(4);
    expect(accepted.value.files.wav).toBe(audio);
    const portable = validateMeeting(
      JSON.parse(new TextDecoder().decode(encode(portableMeeting(accepted.value, randomUUID())))),
    );
    expect(portable.schemaVersion).toBe(2);
    expect(JSON.stringify(portable)).not.toContain('PRIVATE_EXPORT_SENTINEL');
    expect(JSON.stringify(portable)).not.toContain('candidateRequestReceipts');
    const receiverDir = join(root, 'receiver');
    mkdirSync(receiverDir);
    const receiver = new SessionTags(receiverDir);
    const received = receiver.commitSource('received', null, () =>
      preparePortableTranscript(null, sessionFromPortable(portable, 'received'), now),
    );
    expect(received.transcript).toBe(accepted.value.transcript);
    expect(received.transcriptVersion).toBe(1);
    expect(received.transcriptEditing?.edits).toHaveLength(4);
    expect(received.transcriptEditing?.candidates).toEqual([]);
    expect(received.notesMetadata?.stale).toBe(true);
    const v1 = sessionFromPortable(
      validateMeeting(portableMeeting(original, randomUUID(), undefined, 1)),
      'legacy',
    );
    expect(v1.notesMetadata).toMatchObject({ sourceRevision: null, stale: true });
    expect(digest()).toBe(beforeAudio);
  } finally {
    server.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
});

test('failed HTTP commit leaves accepted bytes and held notes alive; successful edit rejects late generation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'heed-transcript-held-'));
  let fail = false,
    release!: (value: string) => void,
    started!: () => void,
    signal!: AbortSignal;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const store = new SessionTags(dir, {
    writeAtomic(path, data) {
      if (fail) throw Error('Synthetic atomic save failure');
      atomicWrite(path, data);
    },
  });
  const notes = new AutomaticNotesService({
    sessionsDir: dir,
    sessionStore: store,
    getSettings: () => ({ enabled: true, templateId: 'fixture', model: 'local', language: 'meeting' }),
    loadTemplate: () => ({ id: 'fixture', name: 'Fixture', description: '', prompt: 'Use only evidence' }),
    generate: (input) => {
      signal = input.signal;
      started();
      return new Promise((resolve) => {
        release = resolve;
      });
    },
    isBusy: () => false,
  });
  const original = notes.create({
    id: 'held',
    title: 'Public fixture',
    duration: 1,
    language: 'en',
    transcript: 'Original',
    segments: [],
    speakers: [],
    transcriptFinalized: true,
    aiNotes: '',
  });
  const service = new TranscriptService({ notes, store });
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      return (
        (await transcriptEditingResponse(req, service, desktopRequestAllowed(req, server.port!))) ??
        new Response(null, { status: 404 })
      );
    },
  });
  const running = notes.tick();
  await entered;
  const command = {
    ...guard(original),
    requestId: 'retry-after-failure',
    action: 'edit',
    target: { kind: 'document' },
    text: 'Corrected',
  };
  async function send() {
    return fetch(`http://127.0.0.1:${server.port}/api/sessions/held/transcript/commands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(command),
    });
  }
  try {
    const bytes = readFileSync(join(dir, 'held.json'), 'utf8');
    fail = true;
    const failed = await send();
    expect(failed.status).toBe(409);
    expect((await failed.json()).error).toContain('Preserve your draft');
    expect(readFileSync(join(dir, 'held.json'), 'utf8')).toBe(bytes);
    expect(signal.aborted).toBe(false);
    fail = false;
    const accepted = await send();
    expect(accepted.status).toBe(200);
    expect((await accepted.json()).transcript).toBe('Corrected');
    expect(signal.aborted).toBe(true);
    release('Stale generated notes');
    await running;
    expect(notes.get('held')?.aiNotes).toBe('');
    expect(notes.get('held')?.transcript).toBe('Corrected');
    expect(Object.values(notes.get('held')!.notesJobs!).some((job) => job.status === 'superseded')).toBe(
      true,
    );
  } finally {
    fail = false;
    release?.('Stale generated notes');
    await running;
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
});
