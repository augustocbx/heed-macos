import type { Segment } from "./speaker.ts";
import type { NotesJob, NotesMetadata } from "./notes.ts";

export interface SessionFiles {
	wav?: string;
	srt?: string;
	txt?: string;
}

export interface Session {
	id: string;
	title: string;
	createdAt: string;
	updatedAt?: string;
	duration: number;
	language: string;
 transcriptionModel?: string;
 liveModel?: string;
	transcript: string;
	speakers: string[];
	segments: Segment[];
	embeddings?: Record<string, number[]>;
	aiNotes: string;
	summary: string;
	tags: string[];
	pinned: boolean;
	files?: SessionFiles;
 transcriptFinalized?: boolean;
 transcriptRevision?: string;
 notesMetadata?: NotesMetadata;
 notesJobs?: Record<string, NotesJob>;
}

export type SessionPatch = Partial<Omit<Session, "id" | "createdAt">> & {
 expectedTranscriptRevision?: string;
 expectedNotes?: string;
};

export interface SessionListResponse {
	sessions: Session[];
}
