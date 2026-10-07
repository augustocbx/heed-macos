import type { MeetingExportPreview } from '@heed/shared';
export function exportPreview(): MeetingExportPreview {
 return { format: 'pdf', selection: { transcript: true, notes: true, taskIds: ['task'], speakers: true, timestamps: true },
  snapshot: { schemaVersion: 1, snapshotKey: 'snapshot', generatedAt: '2026-10-07T03:00:00Z', meetingId: 'meeting', title: 'Reunião / Meeting', createdAt: '2026-10-06T12:00:00Z',
   language: 'pt', sourceRevision: 'a'.repeat(64), sourceVersion: 3, duration: 4, transcript: 'Ação\nHello',
   segments: [{ speaker: 'Ana', start: 0, end: 2, text: 'Ação' }, { speaker: 'John', start: 1, end: 4, text: 'Hello' }],
   notes: { text: '<b>Plain notes</b>\nNo remote image', sourceRevision: null, stale: true },
   tasks: [{ id: 'task', revision: 'r1', title: 'Enviar proposta', description: 'To João', assignee: 'Ana', dueDate: null, status: 'open', sourceRevision: 'b'.repeat(64), stale: true }], warnings: ['notes-source-unknown', 'tasks-stale'] },
  review: { notesHash: 'notes', taskRevisions: { task: 'r1' }, staleContentKey: 'stale' }, availability: { transcript: true, notes: true, subtitles: true, tasks: [] } };
}
