import type { Segment } from "./speaker.ts";

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
  /** Assignment-only revision; unrelated meeting edits do not invalidate it. */
  tagsRevision?: string;
	pinned: boolean;
	files?: SessionFiles;
}

export type SessionPatch = Partial<Omit<Session, "id" | "createdAt">>;

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
