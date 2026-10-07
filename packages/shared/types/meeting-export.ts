import type { TranscriptGuard } from './transcript-editing';

export type MeetingExportFormat = 'pdf' | 'srt' | 'vtt';
export interface MeetingExportSelection {
 transcript: boolean;
 notes: boolean;
 taskIds: string[];
 speakers: boolean;
 timestamps: boolean;
 reviewedNotesHash?: string;
 reviewedTaskRevisions?: Record<string, string>;
}
export type MeetingExportWarning = 'notes-stale' | 'notes-source-unknown' | 'tasks-stale' | 'subtitle-overlap' | 'subtitle-long-cue';
export interface MeetingExportSnapshot {
 schemaVersion: 1;
 snapshotKey: string;
 generatedAt: string;
 meetingId: string;
 title: string;
 createdAt: string;
 language: string;
 sourceRevision: string;
 sourceVersion: number;
 duration: number | null;
 transcript: string;
 segments: Array<{ speaker?: string; start: number; end: number; text: string; channel?: 'mic' | 'sys'; overlap?: boolean }>;
 notes?: { text: string; sourceRevision: string | null; stale: boolean };
 tasks: Array<{ id: string; revision: string; title: string; description: string; assignee: string | null; dueDate: string | null; status: 'open' | 'completed'; sourceRevision: string; stale: boolean }>;
 warnings: MeetingExportWarning[];
}
export interface MeetingExportReview {
 notesHash?: string;
 taskRevisions: Record<string, string>;
 staleContentKey?: string;
}
export interface MeetingExportPreview {
 format: MeetingExportFormat;
 selection: MeetingExportSelection;
 snapshot: MeetingExportSnapshot;
 review: MeetingExportReview;
 availability: { transcript: boolean; notes: boolean; subtitles: boolean; tasks: Array<{ id: string; revision: string; title: string; stale: boolean }> };
}
export type MeetingExportPreviewInput = TranscriptGuard & { format: MeetingExportFormat; selection: MeetingExportSelection };
export type MeetingExportValidateInput = MeetingExportPreviewInput & { snapshotKey: string; staleAcknowledgmentKey?: string };
export interface SubtitleCue { startMs: number; endMs: number; text: string; sourceIndex: number }
