import type {AiFeature, AiSelection, AiUsage} from './ai';
import type {AiCostEstimate, AiCostMetadataPlan, AiPriceSnapshot, AiUsageCostEstimate} from './ai-cost';

export interface AiBudgetPolicy {
 jobLimitMicroUsd: number; periodLimitMicroUsd: number;
 periodDays: number; periodStart: number; maxRemoteAttempts: number; unknownCost: 'block' | 'explicit';
}
/** Projection only: never pass prompts, transcripts, secrets, or credential references. */
export interface AiBudgetPlan extends AiCostMetadataPlan {
 planId: string; jobId: string; payloadHash: string;
}
export interface AiBudgetReview {
 policy: AiBudgetPolicy; policyGeneration: number; price: AiPriceSnapshot | null;
 priceIdentity: string; estimate: AiCostEstimate; identity: string;
}
export interface AiBudgetDecision {planId: string; expectedPayloadHash: string; reviewIdentity: string; allowUnknownCost: boolean;}
export interface AiBudgetReservation {
 id: string; planId: string; jobId: string; reviewIdentity: string;
 attempts: Array<{id: string; callId: string; round: number}>;
}
export interface AiReportedCharge {
 basis: 'provider-reported-request-charge'; provider: 'xai'; currency: 'USD';
 source: 'cost_in_usd_ticks'; ticks: string; amountMicroUsd: number;
}
export interface AiAttemptOutcome {
 status: 'completed' | 'cancelled' | 'timeout' | 'rate-limited' | 'rejected' | 'uncertain';
 usage?: AiUsage; reportedCharge?: AiReportedCharge;
}
export interface AiAttemptAccounting {
 usage: AiUsage | null; tokenEstimate: AiUsageCostEstimate;
 reportedCharge: AiReportedCharge | null; uncertainty: string[];
}
export interface AiUsageEntry {
 attemptId: string; reservationId: string; jobId: string; feature: AiFeature;
 selection: AiSelection; callId: string; round: number; periodStart: number;
 state: 'held' | 'dispatched' | 'settled' | 'uncertain' | 'released';
 liabilityMicroUsd: number; unknownLiability: boolean; dispatchedAt: number | null;
 outcome: AiAttemptOutcome['status'] | null; accounting: AiAttemptAccounting | null;
}
export interface AiUsageSnapshot {
 policy: AiBudgetPolicy; policyGeneration: number; periodStart: number;
 /** Includes unfinished allocations from older periods. Null means numeric overflow. */
 liabilityMicroUsd: number | null; heldMicroUsd: number | null; unknownLiabilityCount: number;
 strictRemainingMicroUsd: number | null; overflow: boolean;
 entries: AiUsageEntry[]; entriesTruncated: boolean;
 limitation: 'device-local-accounting-not-account-wide-invoice';
}
