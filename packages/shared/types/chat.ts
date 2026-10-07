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
export interface ChatClaim { text: string; citations: TranscriptEvidence[]; }
export interface ChatCoverage { reviewedChunks: number; totalChunks: number; complete: boolean; answerLimited: boolean; retrieval?: RetrievalCoverage; }
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
