export type RetrievalStrategy = "lexical" | "fallback";
export type RetrievalPartialReason = "index-missing" | "index-stale" | "index-capacity" | "fallback-limit" | "query-budget" | "context-budget" | "generation-limit";
export interface RetrievalSourceStamp { sessionId: string; sourceRevision: string; transcriptVersion: number; }
export interface RetrievalSnapshot { key: string; sources: RetrievalSourceStamp[]; }
/** Counts describe separate stages; lexical completeness never implies semantic completeness. */
export interface RetrievalCoverage {
 version: 1; strategy: RetrievalStrategy;
 selectedMeetings: number; selectedEvidence: number;
 indexedMeetings: number; indexedEvidence: number;
 searchedMeetings: number; searchedEvidence: number | null;
 matchingRowsVisited: number; matchedEvidence: number;
 retrievedEvidence: number; retrievedMeetings: number;
 suppliedEvidence: number; suppliedMeetings: number;
 citedEvidence: number; citedMeetings: number;
 indexComplete: boolean; lookupComplete: boolean; generationComplete: boolean;
 partialReasons: RetrievalPartialReason[];
}
export interface RetrievalHit extends RetrievalSourceStamp { evidenceId: string; evidenceOrdinal: number; score: number; }
export interface RetrievalResult { snapshot: RetrievalSnapshot; generationId: string | null; hits: RetrievalHit[]; coverage: RetrievalCoverage; }
