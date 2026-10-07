import type { MeetingExportPreview } from '@heed/shared';
import { assertExportText } from '../../../../shared/lib/export-timing';

export interface ExportBlock { kind: 'heading' | 'paragraph' | 'provenance'; text: string }
function timestamp(seconds: number): string {
 if (!Number.isFinite(seconds) || seconds < 0 || !Number.isSafeInteger(Math.round(seconds * 1000))) throw Error('Transcript timestamps are invalid. Export without timestamps.');
 const total = Math.round(seconds * 1000);
 return `${String(Math.floor(total / 3_600_000)).padStart(2, '0')}:${String(Math.floor(total / 60_000) % 60).padStart(2, '0')}:${String(Math.floor(total / 1000) % 60).padStart(2, '0')}`;
}
export function buildExportBlocks(preview: MeetingExportPreview): ExportBlock[] {
 const { snapshot, selection } = preview;
 const blocks: ExportBlock[] = [
  { kind: 'heading', text: snapshot.title || 'Meeting' },
  { kind: 'paragraph', text: `Created: ${snapshot.createdAt}\nGenerated: ${snapshot.generatedAt}\nLanguage: ${snapshot.language}` },
  { kind: 'provenance', text: `Accepted source: ${snapshot.sourceRevision}\nLocal source version: ${snapshot.sourceVersion}` },
 ];
 if (selection.transcript && (snapshot.transcript.trim() || snapshot.segments.some(segment => segment.text.trim()))) {
  blocks.push({ kind: 'heading', text: 'Transcript' });
  if (snapshot.segments.length) {
   for (const segment of snapshot.segments) {
    if (!segment.text.trim()) continue;
    const prefix = [selection.timestamps ? `[${timestamp(segment.start)}–${timestamp(segment.end)}]` : '', selection.speakers && segment.speaker ? `${segment.speaker}:` : ''].filter(Boolean).join(' ');
    blocks.push({ kind: 'paragraph', text: `${prefix ? prefix + ' ' : ''}${segment.text}` });
   }
  } else blocks.push({ kind: 'paragraph', text: snapshot.transcript });
 }
 if (selection.notes && snapshot.notes?.text.trim()) {
  const notes = snapshot.notes;
  blocks.push({ kind: 'heading', text: 'Reviewed notes' },
   { kind: 'provenance', text: notes.sourceRevision === null ? 'Unknown source — these notes may be outdated.'
    : `${notes.stale ? 'Earlier source' : 'Source'}: ${notes.sourceRevision}${notes.stale ? ' — these notes may be outdated.' : ''}` },
   { kind: 'paragraph', text: notes.text });
 }
 const selected = snapshot.tasks.filter(task => selection.taskIds.includes(task.id));
 if (selected.length) {
  blocks.push({ kind: 'heading', text: 'Reviewed tasks' });
  for (const task of selected) {
   blocks.push({ kind: 'paragraph', text: [`${task.status === 'completed' ? 'Completed' : 'Open'}: ${task.title}`, task.description,
    task.assignee ? `Assignee: ${task.assignee}` : '', task.dueDate ? `Due: ${task.dueDate}` : ''].filter(Boolean).join('\n') },
    { kind: 'provenance', text: `${task.stale ? 'Earlier source' : 'Source'}: ${task.sourceRevision}${task.stale ? ' — this task may be outdated.' : ''}` });
  }
 }
 for (const block of blocks) assertExportText(block.text);
 return blocks;
}
