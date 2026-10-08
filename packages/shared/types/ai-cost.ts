import type {AiCapabilities, AiFeature, AiProviderId, AiSelection, AiUsageCategory} from './ai';

/** Integer micro-USD per million tokens. Null means unsupported/unqualified, never free. */
export type AiCategoryPrices = Record<AiUsageCategory, number | null>;
export interface AiContextPriceTier {
 id: string; minInputTokens: number; maxInputTokens: number;
 /** Applies to every token in a request whose total input falls in this range. */
 categories: AiCategoryPrices;
}
export interface AiPricePremium {
 id: string; numerator: number; denominator: number;
 /** Qualification for the exact reviewed transport profile, not a client switch. */
 applicable: boolean; condition: string;
}
export interface AiPriceSnapshot {
 provider: AiProviderId; model: string; currency: 'USD'; verifiedAt: string;
 sourceUrl: string; dataUrl: string; modelUrl: string; usageUrl: string;
 categories: AiCategoryPrices; contextTiers: AiContextPriceTier[]; premiums: AiPricePremium[];
 capabilities: AiCapabilities;
 /** Separate documented input ceiling; does not establish actual prompt fit. */
 maxInputTokens?: number;
 additionalCharges: Array<{id: string; boundMicroUsd: number; applicable: boolean; condition: string}>;
 pricingScope: 'direct-standard-default';
 cacheWritePossible: boolean;
 /** Existing adapters normalize input cache partitions and total output before accounting. */
 usageSemantics: 'normalized-subsets' | 'unqualified';
 limitations: string[];
}
export interface AiAllowanceOffer {
 kind: 'free-quota' | 'promotional-credit'; accountEligibility: 'unknown';
 sourceUrl: string; verifiedAt: string; dataSharingRequired: boolean;
 quota?: {period: 'daily'; reset: '00:00 UTC'; sharedAcrossModels: true; buildTokens: number; launchGrowTokens: number};
 conditions: string[];
}
export interface AiPreset {
 id: string; provider: AiProviderId; model: string; access: 'local' | 'paid';
 features: AiFeature[]; capabilities: AiCapabilities | null; price: AiPriceSnapshot | null;
 verifiedAt: string; sourceUrl: string; dataUrl: string;
 apiCharges: 'zero' | 'paid-rates'; consumerSubscriptionProvidesApiCredit: false;
 offers: AiAllowanceOffer[]; limitations: string[]; dataHandling: string[]; rateLimits: string[];
 optimizations: {hostedCacheEnabled: false; batchEnabled: false; evaluation: string[]};
}
/** Structural projection of the immutable reviewed AiJobPlan; no text is persisted by estimates.
 * Attempts is supplied by the reviewed server budget policy, never an upload authorization.
 */
export interface AiCostPlan {
 feature: AiFeature; selection: AiSelection; capabilities?: AiCapabilities; attempts?: number;
 calls: ReadonlyArray<{id: string; system: string; data: unknown; schema?: Record<string, unknown>; contextTokens: number; maxOutputTokens: number; maxRequestBytes?: number}>;
}
/** Text-free AiAdmissionSummary projection. Separate source/schema limits were checked by its planner. */
export interface AiCostMetadataPlan {
 feature: AiFeature; selection: AiSelection; capabilities?: AiCapabilities; attempts?: number;
 calls: ReadonlyArray<{id: string; inputBytes: number; contextTokens: number; maxOutputTokens: number}>;
}
export type AiPriceStatus = 'current' | 'stale' | 'unknown';
export interface AiCostCategoryAssumption {
 category: AiUsageCategory; tokens: number; rateMicroUsdPerMillion: number; boundMicroUsd: number;
}
export interface AiCallCostEstimate {
 callId: string; controlledInputBytes: number | null;
 fit: 'not-proven' | 'known-exceeds'; inputBasis: 'accepted-declared-context' | 'local-policy' | 'unknown';
 inputTokensBound: number | null; outputTokensBound: number | null;
 categories: AiCostCategoryAssumption[]; knownComponentsMicroUsd: number | null;
 conditionalAcceptedBoundMicroUsd: number | null; uncertainty: string[];
}
export interface AiCostEstimate {
 status: 'known' | 'stale' | 'unknown'; priceStatus: AiPriceStatus; currency: 'USD';
 admissibility: 'eligible-for-policy-review' | 'blocked'; attempts: number;
 /** A finite conditional component sum is not a guaranteed maximum charge. */
 knownComponentsMicroUsd: number | null; conditionalAcceptedBoundMicroUsd: number | null;
 wholeAttemptBoundMicroUsd: number | null;
 calls: AiCallCostEstimate[]; uncertainty: string[];
}
export interface AiUsageCostEstimate {
 status: 'known' | 'stale' | 'unknown'; amountMicroUsd: number | null;
 basis: 'estimated-from-provider-token-counts'; categories: AiCostCategoryAssumption[]; uncertainty: string[];
}
