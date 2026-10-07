import { createHash } from 'node:crypto';
import type { Session } from '../../shared/types/session';
import type { TaskView } from '../../shared/types/tasks';
import type { MeetingExportPreview, MeetingExportPreviewInput, MeetingExportSelection, MeetingExportSnapshot, MeetingExportValidateInput, MeetingExportWarning } from '../../shared/types/meeting-export';
import { sourceRevision } from '../../shared/lib/transcript-source';
import { assertExportText, buildTimedExportCues, ExportContentError } from '../../shared/lib/export-timing';
import { normalizeNotesSource } from './session-tags';
import { normalizeTranscriptSession, renderAcceptedTranscript } from './transcript-editing';

export const MEETING_EXPORT_LIMIT = 16_000_000;
export class MeetingExportError extends Error {
 constructor(message: string, public status: 400 | 404 | 409 | 413, public code: string) { super(message); }
}
function fail(message: string, status: MeetingExportError['status'] = 400, code = 'invalid-selection'): never { throw new MeetingExportError(message, status, code); }
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function keys(value: Record<string, unknown>, allowed: string[]): void {
 if (Object.keys(value).some(key => !allowed.includes(key))) fail('Export request contains unknown fields.');
}
function validString(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 256; }
export function validateMeetingExportInput(value: unknown, validating = false): asserts value is MeetingExportPreviewInput | MeetingExportValidateInput {
 if (!record(value)) fail('An export request object is required.');
 keys(value, ['expectedTranscriptRevision', 'expectedTranscriptVersion', 'format', 'selection', ...(validating ? ['snapshotKey', 'staleAcknowledgmentKey'] : [])]);
 if (!validString(value.expectedTranscriptRevision) || !Number.isSafeInteger(value.expectedTranscriptVersion) || (value.expectedTranscriptVersion as number) < 0) fail('Both transcript guards are required.');
 if (!['pdf', 'srt', 'vtt'].includes(value.format as string) || !record(value.selection)) fail('Choose PDF, SRT or VTT and an export scope.');
 const selection = value.selection;
 keys(selection, ['transcript', 'notes', 'taskIds', 'speakers', 'timestamps', 'reviewedNotesHash', 'reviewedTaskRevisions']);
 for (const field of ['transcript', 'notes', 'speakers', 'timestamps']) if (typeof selection[field] !== 'boolean') fail('Export scope options must be booleans.');
 if (!Array.isArray(selection.taskIds) || !selection.taskIds.every(validString) || new Set(selection.taskIds).size !== selection.taskIds.length) fail('Select distinct task IDs.');
 const taskIds = selection.taskIds;
 if (selection.reviewedNotesHash !== undefined && !validString(selection.reviewedNotesHash)) fail('Invalid notes review acknowledgment.');
 if (selection.reviewedTaskRevisions !== undefined) {
  if (!record(selection.reviewedTaskRevisions) || Object.entries(selection.reviewedTaskRevisions).some(([id, revision]) => !validString(id) || !validString(revision) || !taskIds.includes(id))) fail('Invalid task review acknowledgment.');
 }
 if (!selection.transcript && (selection.speakers || selection.timestamps)) fail('Speaker labels and timestamps require transcript selection.');
 if (value.format !== 'pdf' && (!selection.transcript || selection.notes || selection.taskIds.length > 0 || !selection.timestamps)) fail('Subtitles contain timed transcript only.');
 if (validating && (!validString(value.snapshotKey) || (value.staleAcknowledgmentKey !== undefined && !validString(value.staleAcknowledgmentKey)))) fail('Invalid snapshot acknowledgment.');
}

function cleanSelection(selection: MeetingExportSelection): MeetingExportSelection {
 return { transcript: selection.transcript, notes: selection.notes, taskIds: [...selection.taskIds].sort(), speakers: selection.speakers, timestamps: selection.timestamps };
}
function checkContent(value: unknown): void {
 if (typeof value === 'string') assertExportText(value);
 else if (Array.isArray(value)) for (const child of value) checkContent(child);
 else if (record(value)) for (const child of Object.values(value)) checkContent(child);
}

export function createMeetingExportPreview(raw: Session, tasks: TaskView[], input: MeetingExportPreviewInput, generatedAt: string): MeetingExportPreview {
 validateMeetingExportInput(input);
 const session = normalizeNotesSource(normalizeTranscriptSession(raw));
 const revision = sourceRevision(session), version = session.transcriptVersion!;
 if (revision !== input.expectedTranscriptRevision || version !== input.expectedTranscriptVersion) fail('Transcript changed. Refresh the export preview.', 409, 'source-conflict');
 if (session.transcriptFinalized !== true) fail('Save a finalized meeting before exporting.', 400, 'not-finalized');
 const selection = cleanSelection(input.selection);
 const accepted = tasks.filter(task => task.sessionId === session.id && task.sourceState !== 'meeting-deleted' && ['open', 'completed'].includes(task.status));
 const chosen = selection.taskIds.map(id => accepted.find(task => task.id === id) ?? fail('A selected task is no longer available in this meeting.', 404, 'task-not-found'))
  .sort((a, b) => a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
 const warnings = new Set<MeetingExportWarning>();
 const segments: MeetingExportSnapshot['segments'] = selection.transcript ? session.segments.map(segment => ({
  ...(selection.speakers ? { speaker: segment.speaker } : {}), start: segment.start, end: segment.end, text: segment.text,
  ...(segment.channel ? { channel: segment.channel } : {}), ...(segment.overlap !== undefined ? { overlap: segment.overlap } : {})
 })) : [];
 const transcript = selection.transcript ? (session.segments.length ? renderAcceptedTranscript(session.segments) : session.transcript) : '';
 const duration = Number.isFinite(session.duration) && session.duration > 0 ? session.duration : null;
 const notes = selection.notes ? { text: session.aiNotes, sourceRevision: session.notesMetadata?.sourceRevision ?? null,
  stale: session.notesMetadata?.stale !== false || session.notesMetadata?.sourceRevision !== revision } : undefined;
 if (selection.notes && !notes?.text.trim()) fail('This meeting has no notes to export.', 400, 'no-notes');
 if (notes?.sourceRevision === null) warnings.add('notes-source-unknown');
 else if (notes?.stale) warnings.add('notes-stale');
 const selectedTasks = chosen.map(task => ({ id: task.id, revision: task.revision, title: task.title, description: task.description,
  assignee: task.assignee, dueDate: task.dueDate, status: task.status, sourceRevision: task.sourceRevision,
  stale: task.sourceState !== 'available' || task.sourceRevision !== revision }));
 if (selectedTasks.some(task => task.stale)) warnings.add('tasks-stale');
 let subtitles = false;
 try {
  const timed = buildTimedExportCues(session.segments, duration, selection.speakers); subtitles = true;
  if (input.format !== 'pdf') for (const warning of timed.warnings) warnings.add(warning);
 } catch (error) {
  if (input.format !== 'pdf') {
   if (error instanceof ExportContentError) fail(error.message, 400, error.code);
   throw error;
  }
 }
 if (!transcript.trim() && !notes?.text.trim() && !selectedTasks.length) fail('Choose nonempty content to export.', 400, 'empty-export');
 const body = { schemaVersion: 1 as const, meetingId: session.id, title: session.title, createdAt: session.createdAt, language: session.language,
  sourceRevision: revision, sourceVersion: version, duration, transcript, segments, ...(notes ? { notes } : {}), tasks: selectedTasks, warnings: [...warnings] };
 try { checkContent(body); } catch (error) { if (error instanceof ExportContentError) fail(error.message, 400, error.code); throw error; }
 const keyPayload = { format: input.format, selection, snapshot: body };
 const encoded = JSON.stringify(keyPayload);
 if (Buffer.byteLength(encoded, 'utf8') > MEETING_EXPORT_LIMIT) fail('Selected export content exceeds 16,000,000 UTF-8 bytes.', 413, 'export-too-large');
 const snapshotKey = createHash('sha256').update(encoded).digest('hex');
 const review = { ...(notes ? { notesHash: hash(notes) } : {}), taskRevisions: Object.fromEntries(selectedTasks.map(task => [task.id, task.revision])),
  ...((notes?.stale || selectedTasks.some(task => task.stale)) ? { staleContentKey: hash({ notes: notes?.stale ? notes : null, tasks: selectedTasks.filter(task => task.stale) }) } : {}) };
 return { format: input.format, selection, snapshot: { ...body, snapshotKey, generatedAt }, review,
  availability: { transcript: (session.segments.length ? renderAcceptedTranscript(session.segments) : session.transcript).trim().length > 0,
   notes: session.aiNotes.trim().length > 0, subtitles, tasks: accepted.map(task => ({ id: task.id, revision: task.revision, title: task.title, stale: task.sourceState !== 'available' || task.sourceRevision !== revision })) } };
}

export function validateMeetingExportPreview(session: Session, tasks: TaskView[], input: MeetingExportValidateInput): { valid: true; snapshotKey: string } {
 validateMeetingExportInput(input, true);
 const { snapshotKey, staleAcknowledgmentKey, ...previewInput } = input;
 const preview = createMeetingExportPreview(session, tasks, previewInput, '');
 if (preview.snapshot.snapshotKey !== snapshotKey) fail('Selected content changed. Preview and review it again.', 409, 'snapshot-conflict');
 if (preview.review.notesHash !== input.selection.reviewedNotesHash) fail('Review the selected notes before exporting.', 409, 'notes-review-required');
 for (const [id, revision] of Object.entries(preview.review.taskRevisions)) if (input.selection.reviewedTaskRevisions?.[id] !== revision) fail('Review the current selected tasks before exporting.', 409, 'tasks-review-required');
 if (preview.review.staleContentKey !== staleAcknowledgmentKey) fail('Acknowledge the selected earlier or unknown source content.', 409, 'stale-review-required');
 return { valid: true, snapshotKey };
}
