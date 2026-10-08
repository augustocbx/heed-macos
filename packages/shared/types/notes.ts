import type { TranscriptSourceIdentity } from "./transcript-editing";
import type { AiWaitingReason } from "./chat";

export type NotesLanguagePolicy = "meeting" | "en" | "pt" | "fr" | "de";

export interface AutomaticNotesSettings {
 enabled: boolean;
 templateId: string;
 model: string | null;
 language: NotesLanguagePolicy;
}

export type NotesJobStatus = "queued" | "waiting" | "running" | "completed" | "failed" | "cancelled" | "superseded";

export interface NotesJob {
 ai?: import("./ai").AiJobBinding;
 id: string;
 sourceRevision: string;
 /** Device-local accepted version bound when queued/admitted; excluded from portable records. */
 sourceVersion?: number;
 status: NotesJobStatus;
 templateId: string;
 templateName: string;
 templateHash: string;
 templatePrompt: string;
 model: string;
 language: string;
 attempts: number;
 generatedCharacters: number;
 reason?: string;
 waitingReason?: AiWaitingReason;
 retryable: boolean;
 updatedAt: string;
 expectedNotesHash: string;
 replaceExisting: boolean;
}

export interface NotesMetadata {
 provenance?: import("./ai").AiProvenance;
 /** Null is unknown legacy/unguarded provenance, never verified against current text. */
 sourceRevision: string | null;
 /** Preserved historical identity whose missing witness cannot be verified. Requires null/stale. */
 unverifiedSourceRevision?: string;
 sourceIdentity?: TranscriptSourceIdentity;
 templateId?: string;
 templateName?: string;
 templateHash?: string;
 model?: string;
 language?: string;
 generatedAt?: string;
 origin: "automatic" | "manual";
 stale: boolean;
}
