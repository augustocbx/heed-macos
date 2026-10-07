import type { Segment, TranscriptionDiagnostics } from "./speaker.ts";
import type { NotesJob, NotesMetadata } from "./notes.ts";
import type { TranscriptEditingState } from "./transcript-editing.ts";

export interface SessionFiles {
	wav?: string;
	srt?: string;
	txt?: string;
}

export interface Session {
 /** Device-local archival availability; never part of portable meeting records. */
 audioArchived?:boolean;
	id: string;
	title: string;
	createdAt: string;
	updatedAt?: string;
	duration: number;
	language: string;
 transcriptionModel?: string;
 vocabularyRun?: import('./vocabulary').VocabularyRun;
 liveVocabularyRuns?: import('./vocabulary').VocabularyRun[];
 liveModel?: string;
	transcript: string;
	speakers: string[];
	segments: Segment[];
	embeddings?: Record<string, number[]>;
	aiNotes: string;
	summary: string;
	tags: string[];
  /** Assignment-only revision; unrelated meeting edits do not invalidate it. */
  tagsRevision?: string;
	pinned: boolean;
	files?: SessionFiles;
 transcriptFinalized?: boolean;
 transcriptionDiagnostics?: TranscriptionDiagnostics;
 transcriptRevision?: string;
 /** Device-local monotonic concurrency token; absent legacy records normalize to zero. */
 transcriptVersion?: number;
 transcriptEditing?: TranscriptEditingState;
 notesMetadata?: NotesMetadata;
 notesJobs?: Record<string, NotesJob>;
}

export type SessionPatch = Partial<Omit<Session, "id" | "createdAt">> & {
 expectedTranscriptRevision?: string;
 expectedTranscriptVersion?: number;
 expectedNotes?: string;
};

export interface SessionListResponse {
	sessions: Session[];
}

export type TagMutation =
  | { action: "add" | "remove"; sessionId: string; tag: string; expectedRevision: string }
  | { action: "rename"; tag: string; name: string; expectedRevision: string }
  | { action: "delete"; tag: string; expectedRevision: string };

export interface TagSnapshot {
  tags: Array<{ name: string; meetingCount: number }>;
  sessions: Session[];
  revision: string;
}
