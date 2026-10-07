import { describe, expect, test } from 'bun:test';
import type { Session } from '../../shared/types/session';
import type { TaskView } from '../../shared/types/tasks';
import { sourceRevision } from '../../shared/lib/transcript-source';
import { createMeetingExportPreview, validateMeetingExportPreview } from './meeting-export';
import { buildTimedExportCues } from '../../shared/lib/export-timing';

const now = '2026-10-07T03:00:00Z';
function meeting(): Session {
 return { id: 'meeting', title: 'English / Português', createdAt: now, duration: 4, language: 'pt',
  transcript: 'Corrected name\nAção', speakers: ['Ana', 'John'],
  segments: [{ speaker: 'Ana', start: 0, end: 2, text: 'Corrected name', channel: 'mic' },
   { speaker: 'John', start: 1, end: 4, text: 'Ação', overlap: true }],
  aiNotes: 'Reviewed notes <b>literal</b>', summary: 'PRIVATE', tags: [], pinned: false,
  transcriptFinalized: true, transcriptVersion: 3, files: { wav: '/PRIVATE/audio.wav' },
  embeddings: { PRIVATE: [9] }, notesMetadata: { sourceRevision: null, stale: true, origin: 'manual' } };
}
function task(s = meeting(), id = 'task'): TaskView {
 return { id, revision: 'r1', sessionId: s.id, meetingTitle: s.title, suggestionId: 'suggestion',
  sourceRevision: sourceRevision(s), evidence: [{ segmentIndex: 0, speaker: 'PRIVATE', quote: 'PRIVATE', sourceRevision: 'PRIVATE', start: 0, end: 1 }],
  kind: 'explicit', title: 'Send proposal', description: 'To João', assignee: 'Ana', dueDate: null,
  status: 'open', completedAt: null, createdAt: now, updatedAt: now, sourceState: 'available', audioAvailable: true };
}
function input(s = meeting(), options: Record<string, unknown> = {}) {
 return { expectedTranscriptRevision: sourceRevision(s), expectedTranscriptVersion: s.transcriptVersion ?? 0,
  format: 'pdf' as const, selection: { transcript: true, notes: false, taskIds: [], speakers: true, timestamps: true }, ...options };
}
const preview = (s = meeting(), tasks: TaskView[] = [], value = input(s)) => createMeetingExportPreview(s, tasks, value, now);

describe('frozen selective meeting export', () => {
 test('uses corrected accepted text, monotonic version and only allowlisted fields', () => {
  const s = meeting(); const before = structuredClone(s); const p = preview(s);
  expect(p.snapshot).toMatchObject({ sourceVersion: 3, transcript: s.transcript, sourceRevision: sourceRevision(s), generatedAt: now });
  expect(p.snapshot.segments[0]?.text).toBe('Corrected name');
  expect(JSON.stringify(p)).not.toContain('PRIVATE'); expect(p.snapshot.notes).toBeUndefined(); expect(p.snapshot.tasks).toEqual([]);
  expect(s).toEqual(before);
 });
 test('enforces both guards even when a revert restores the hash', () => {
  const s = meeting(); expect(() => preview(s, [], { ...input(s), expectedTranscriptVersion: 1 })).toThrow();
  expect(() => preview(s, [], { ...input(s), expectedTranscriptRevision: 'old' })).toThrow();
 });
 test('rejects provisional, empty and untimed subtitles; supports notes-only and tasks-only PDF', () => {
  expect(() => preview({ ...meeting(), transcriptFinalized: false })).toThrow();
  const s = { ...meeting(), transcript: '', segments: [] };
  expect(() => preview(s)).toThrow();
  const selection = { transcript: false, notes: true, taskIds: [], speakers: false, timestamps: false };
  expect(preview(s, [], input(s, { selection })).snapshot.notes?.sourceRevision).toBeNull();
  expect(preview(s, [task(s)], input(s, { selection: { ...selection, notes: false, taskIds: ['task'] } })).snapshot.tasks).toHaveLength(1);
  expect(() => preview(s, [], input(s, { format: 'srt' }))).toThrow();
  expect(() => preview(meeting(), [], input(meeting(), { format: 'vtt', selection }))).toThrow();
 });
 test('notes review binds text and truthful unknown provenance without clearing staleness', () => {
  const s = meeting(); const value = input(s, { selection: { ...input(s).selection, notes: true } });
  const p = preview(s, [], value); expect(p.snapshot.warnings).toContain('notes-source-unknown');
  expect(p.snapshot.notes).toEqual({ text: s.aiNotes, sourceRevision: null, stale: true });
  expect(() => validateMeetingExportPreview(s, [], { ...value, snapshotKey: p.snapshot.snapshotKey })).toThrow();
  const accepted = { ...value, selection: { ...value.selection, reviewedNotesHash: p.review.notesHash }, snapshotKey: p.snapshot.snapshotKey, staleAcknowledgmentKey: p.review.staleContentKey };
  expect(validateMeetingExportPreview(s, [], accepted)).toEqual({ valid: true, snapshotKey: p.snapshot.snapshotKey });
  expect(() => validateMeetingExportPreview({ ...s, aiNotes: 'Regenerated' }, [], accepted)).toThrow();
  expect(s.notesMetadata?.stale).toBe(true);
 });
 test('task selection rejects duplicates, unknown, foreign and deleted records; binds current revisions/status', () => {
  const s = meeting(); const t = task(s); const selection = { ...input(s).selection, taskIds: ['task'] };
  const p = preview(s, [t], input(s, { selection }));
  expect(p.snapshot.tasks[0]).toEqual({ id: t.id, revision: 'r1', title: t.title, description: t.description, assignee: 'Ana', dueDate: null, status: 'open', sourceRevision: t.sourceRevision, stale: false });
  for (const tasks of [[], [{ ...t, sessionId: 'foreign' }], [{ ...t, sourceState: 'meeting-deleted' as const }]]) expect(() => preview(s, tasks, input(s, { selection }))).toThrow();
  expect(() => preview(s, [t], input(s, { selection: { ...selection, taskIds: ['task', 'task'] } }))).toThrow();
  const accepted = { ...input(s, { selection: { ...selection, reviewedTaskRevisions: { task: 'r1' } } }), snapshotKey: p.snapshot.snapshotKey };
  expect(validateMeetingExportPreview(s, [t], accepted).valid).toBe(true);
  expect(() => validateMeetingExportPreview(s, [{ ...t, revision: 'r2', status: 'completed' }], accepted)).toThrow();
 });
 test('stale tasks require acknowledgment, ordering ignores caller order and strips evidence', () => {
  const s = meeting(); const a = task(s, 'a'); const b = { ...task(s, 'b'), sourceState: 'transcript-changed' as const };
  const selection = { ...input(s).selection, taskIds: ['b', 'a'] };
  const p = preview(s, [b, a], input(s, { selection }));
  expect(p.snapshot.tasks.map(t => t.id)).toEqual(['a', 'b']); expect(p.snapshot.warnings).toContain('tasks-stale');
  expect(JSON.stringify(p)).not.toContain('PRIVATE');
  expect(preview(s, [a, b], input(s, { selection: { ...selection, taskIds: ['a', 'b'] } })).snapshot.snapshotKey).toBe(p.snapshot.snapshotKey);
 });
 test('key binds selected data and source/title but excludes clock and unselected fields', () => {
  const s = meeting(); const p = preview(s);
  expect(createMeetingExportPreview({ ...s, aiNotes: 'new', summary: 'new' }, [task(s)], input(s), 'later').snapshot.snapshotKey).toBe(p.snapshot.snapshotKey);
  const valid = { ...input(s), snapshotKey: p.snapshot.snapshotKey };
  expect(validateMeetingExportPreview(s, [], valid).valid).toBe(true);
  expect(() => validateMeetingExportPreview({ ...s, title: 'New title' }, [], valid)).toThrow();
  expect(preview({ ...s, duration: Number.NaN }).snapshot.duration).toBeNull();
 });
 test('rejects unknown selection/guard fields, invalid booleans, text scalars and oversized selected UTF-8', () => {
  const s = meeting();
  expect(() => preview(s, [], { ...input(s), selection: { ...input(s).selection, transcript: 'yes' } } as never)).toThrow();
  expect(() => preview(s, [], { ...input(s), unknown: true } as never)).toThrow();
  expect(() => preview(s, [], { ...input(s), selection: { ...input(s).selection, secret: true } } as never)).toThrow();
  expect(() => preview({ ...s, title: '\ud800' })).toThrow();
  expect(() => preview({ ...s, segments: [], transcript: 'é'.repeat(8_000_001) })).toThrow();
 });
 test('accepts exactly the deterministic payload byte limit and refuses one byte more', () => {
  const s = { ...meeting(), segments: [], transcript: 'x' };
  const p = preview(s); const { generatedAt: _date, snapshotKey: _key, ...snapshot } = p.snapshot;
  const bytes = Buffer.byteLength(JSON.stringify({ format: p.format, selection: p.selection, snapshot }));
  const exact = { ...s, transcript: 'x'.repeat(16_000_000 - bytes + 1) };
  expect(preview(exact).snapshot.transcript.length).toBe(exact.transcript.length);
  try { preview({ ...exact, transcript: exact.transcript + 'x' }); throw new Error('Unexpected acceptance'); }
  catch (error) { expect(error).toMatchObject({ status: 413, code: 'export-too-large' }); }
 });
 test('known earlier notes stay visibly stale even if old metadata claimed otherwise', () => {
  const s = { ...meeting(), notesMetadata: { sourceRevision: 'earlier', stale: false, origin: 'manual' as const } };
  const p = preview(s, [], input(s, { selection: { ...input(s).selection, notes: true } }));
  expect(p.snapshot.notes?.stale).toBe(true); expect(p.snapshot.warnings).toContain('notes-stale');
 });
});

describe('shared timed export cues', () => {
 test('rounds exact milliseconds, stable sorts and keeps overlapping cues', () => {
  const value = buildTimedExportCues([{ start: 1.2346, end: 3, text: 'Ação', speaker: 'Ana' }, { start: 0, end: 2, text: 'Hello' }], 4, true);
  expect(value.cues.map(c => c.sourceIndex)).toEqual([1, 0]); expect(value.cues[1]?.startMs).toBe(1235);
  expect(value.cues[1]?.text).toBe('Ana: Ação'); expect(value.warnings).toContain('subtitle-overlap');
 });
 test('rejects invalid nonempty timing rather than omitting text', () => {
  for (const [start, end] of [[-1, 2], [0, Infinity], [2, 1], [0.0001, 0.0004], [0, 5], [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1]]) {
   expect(() => buildTimedExportCues([{ start: start!, end: end!, text: 'text' }], 4, false)).toThrow();
  }
  expect(() => buildTimedExportCues([], null, false)).toThrow();
  expect(buildTimedExportCues([{ start: -1, end: -2, text: '' }, { start: 90000, end: 90002, text: 'Late' }], null, false).cues).toHaveLength(1);
 });
 test('wraps graphemes, retains literal multiline content and warns about density', () => {
  const value = buildTimedExportCues([{ start: 0, end: 1, text: 'a\u0301'.repeat(90) + '\n\n<b> --> &amp;' }], null, false);
  expect(value.cues[0]?.text).not.toContain('\n\n'); expect(value.cues[0]?.text.replaceAll('\n', '')).toBe('a\u0301'.repeat(90) + '<b> --> &amp;');
  expect(value.warnings).toContain('subtitle-long-cue');
  const segmenter = new Intl.Segmenter('und', { granularity: 'grapheme' });
  for (const line of value.cues[0]!.text.split('\n')) expect([...segmenter.segment(line)].length).toBeLessThanOrEqual(42);
 });
});
