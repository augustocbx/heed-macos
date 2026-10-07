import type { Segment, TranscriptionDiagnostics } from "./speaker.ts";
import type { TranscribeResult } from "./api.ts";

export interface TranscriptGuard {
 expectedTranscriptRevision: string;
 expectedTranscriptVersion: number;
}
export interface CandidateInput { requestId: string; base: TranscriptGuard; result: TranscribeResult; }
export type TranscriptTarget = { kind: "segment"; index: number } | { kind: "document" };
export interface ReplaceInput {
 query: string;
 replacement: string;
 caseSensitive: boolean;
 wholeWord: boolean;
}
export interface TextChange { target: TranscriptTarget; before: string; after: string; }
export interface ReplacementPreview { key: string; guard: TranscriptGuard; changes: TextChange[]; matchCount: number; }

/** Immutable accepted recognition baseline. Voice embeddings stay device-local. */
export interface RecognitionGeneration {
 id: string;
 createdAt: string;
 origin: "recognition" | "legacy-preserved";
 transcript: string;
 segments: Segment[];
 speakers: string[];
 language: string;
 transcriptionModel?: string;
 duration: number;
 transcriptionDiagnostics?: TranscriptionDiagnostics;
}
export interface TranscriptEdit {
 id: string;
 /** Present together on local actions; omitted when importing portable history. */
 requestId?: string;
 requestSignature?: string;
 generationId: string;
 kind: "edit" | "replace" | "revert";
 changes: TextChange[];
 createdAt: string;
 beforeRevision: string;
 afterRevision: string;
}
/** Device-local staged result; never included in a portable record. */
export interface TranscriptCandidate extends Omit<RecognitionGeneration, "origin"> {
 requestId: string;
 requestSignature: string;
 baseGuard: TranscriptGuard;
 embeddings?: Record<string, number[]>;
}
export interface TranscriptCandidateReceipt {
 requestId: string;
 requestSignature: string;
 candidateId: string;
 status: "accepted" | "discarded" | "failed";
}
export interface TranscriptEditingState {
 schemaVersion: 1;
 activeGenerationId: string;
 generations: RecognitionGeneration[];
 edits: TranscriptEdit[];
 candidates: TranscriptCandidate[];
 candidateRequestReceipts: TranscriptCandidateReceipt[];
}
type CommandIdentity = TranscriptGuard & { requestId: string };
export type TextOnlyCommand = CommandIdentity & (
 { action: "edit"; target: TranscriptTarget; text: string } |
 { action: "replace"; input: ReplaceInput; expectedPreviewKey: string } |
 { action: "revert"; editId: string }
);
export type TranscriptCommand = TextOnlyCommand | (CommandIdentity & { action: "accept-candidate"; candidateId: string });
