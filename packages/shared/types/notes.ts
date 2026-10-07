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
 id: string;
 sourceRevision: string;
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
 sourceRevision: string;
 templateId?: string;
 templateName?: string;
 templateHash?: string;
 model?: string;
 language?: string;
 generatedAt?: string;
 origin: "automatic" | "manual";
 stale: boolean;
}
