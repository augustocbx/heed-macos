import type { RetrievalCoverage } from "./retrieval";
export type AiWaitingReason = "recording" | "transcription" | "notes" | "tasks" | "chat" | "retrieval" | "queued";

/** References are qualified by source revision, never by a live speaker-turn ID. */
export interface TranscriptEvidence {
 id: string;
 sessionId: string;
 sourceRevision: string;
 segmentIndex: number | null;
 paragraphIndex: number | null;
 speaker: string;
 quote: string;
 start: number | null;
 end: number | null;
}
/** Recorded meeting facts are a distinct source, never a transcript quote or audio offset. */
export interface MeetingMetadataEvidence {
 kind: "meeting-metadata";
 id: string;
 sessionId: string;
 sourceRevision: string;
 recordedAt: string;
 durationSeconds?: number;
}
export type ChatEvidence = TranscriptEvidence | MeetingMetadataEvidence;
export interface MeetingMetadataCoverage { selectedMeetings: number; suppliedMeetings: number; complete: boolean; }
export interface ChatClaim { text: string; citations: ChatEvidence[]; }
export interface ChatCoverage { reviewedChunks: number; totalChunks: number; complete: boolean; answerLimited: boolean; retrieval?: RetrievalCoverage; metadata?: MeetingMetadataCoverage; }
export interface ChatAnswer { claims: ChatClaim[]; coverage: ChatCoverage; }
export interface ChatTurn {
 id: string; requestId: string; question: string; model: string; initialModel?: string; sourceRevision: string;
 status: "waiting" | "running" | "completed" | "failed" | "cancelled";
 createdAt: string; updatedAt: string; attempts: number; reason?: string;
 answer?: ChatAnswer; stale?: boolean; waitingReason?: AiWaitingReason;
}
export interface ChatThread { sessionId: string; revision: string; turns: ChatTurn[]; }
export type ChatCommand =
 | { action: "send"; requestId: string; question: string; model: string; expectedSourceRevision: string; expectedThreadRevision?: string }
 | { action: "cancel"; turnId: string }
 | { action: "retry"; turnId: string; model?: string }
 | { action: "clear"; expectedThreadRevision: string };
