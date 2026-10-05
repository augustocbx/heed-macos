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
	transcript: string;
	speakers: string[];
	segments: Segment[];
	embeddings?: Record<string, number[]>;
	aiNotes: string;
	summary: string;
	tags: string[];
	pinned: boolean;
	files?: SessionFiles;
}

export type SessionPatch = Partial<Omit<Session, "id" | "createdAt">>;

export interface SessionListResponse {
	sessions: Session[];
}
