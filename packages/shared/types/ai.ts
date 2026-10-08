import type {AiBudgetReview,AiReportedCharge} from './ai-budget';
export type AiProviderId = 'ollama' | 'openai' | 'anthropic' | 'deepseek' | 'xai' | 'compatible';
export type AiFeature = 'notes' | 'tasks' | 'chat' | 'library-chat';
export interface AiSelection { provider: AiProviderId; connectionId: string | null; model: string | null; }
export type AiUsageCategory = 'inputTokens' | 'cachedInputTokens' | 'cacheWriteTokens' | 'outputTokens' | 'reasoningTokens';
export interface AiCapabilities {
 features: AiFeature[];
 structuredOutput: 'schema' | 'validated-json' | 'none';
 streaming: boolean;
 contextTokens: number;
 maxOutputTokens: number;
 usageCategories: AiUsageCategory[];
 /** Some vendors cap visible output without bounding billable reasoning. */
 billableOutputBound: 'max-output' | 'model-limit' | 'unknown';
 maxBillableOutputTokens?: number;
}
/** Input/output totals include cache/reasoning breakdowns; never add them twice. */
export interface AiUsage {
 inputTokens?: number; cachedInputTokens?: number; cacheWriteTokens?: number;
 outputTokens?: number; reasoningTokens?: number; supported: boolean;
}
export interface AiProvenance { provider: AiProviderId; model: string; }
export interface AiResult { text: string; usage: AiUsage; finish: 'completed'; provenance: AiProvenance; reportedCharge?: AiReportedCharge; }
export type AiConnectionValidation = 'unvalidated' | 'validated' | 'failed' | 'credential-unavailable';
/** Device-local configuration summary. No secret references or stored keys. */
export interface AiConnectionSnapshot {
 id: string; provider: Exclude<AiProviderId, 'ollama'>; model: string;
 endpoint: string; validationEndpoint: string;
 connectionGeneration: number; credentialGeneration: number; trustVersion: number;
 validation: AiConnectionValidation; validationCode?: string;
 capabilities: AiCapabilities | null;
 capabilitySource: 'verified-metadata' | 'explicit-declaration' | 'unverified';
 capabilityVerifiedAt: string | null;
}
export interface AiSettingsSnapshot {
 version: number; selections: Record<AiFeature, AiSelection>;
 connections: AiConnectionSnapshot[]; pendingCleanup: boolean; unavailable: boolean;
}
/** Keys are write-only request input and must never enter browser persistence. */
export interface AiConnectionInput {
 provider: Exclude<AiProviderId, 'ollama'>; model: string; key: string;
 endpoint?: string; validationEndpoint?: string; trusted?: true;
 capabilities?: AiCapabilities;
}
/** Safe device-local command binding. Exporters must allowlist provenance instead. */
export interface AiJobBinding {selection:AiSelection;commandRevision?:string;planId?:string;dispatched?:boolean;supersededPlanId?:string;}
export interface AiAuthorizationDecision {allowRemote:true;expectedPayloadHash:string;allowUnknownCost?:true;}
export interface AiPreview {
 id:string;jobId:string;feature:AiFeature;selection:AiSelection;payloadHash:string;expiresAt:number;
 calls:Array<{id:string;system:string;data:unknown;schema?:Record<string,unknown>;contextTokens:number;maxOutputTokens:number;maxRequestBytes?:number}>;
 sources:Array<{sessionId:string;sourceRevision:string;sourceVersion?:number;expectedNotesHash?:string}>;
 excluded:string[];costStatus:'unknown';costReview?:AiBudgetReview;
}
/** Existing durable command identity only. The server resolves all source text and settings. */
export type AiPlanRequest =
 | {feature:'notes';sessionId:string;jobId?:string}
 | {feature:'tasks';sessionId:string}
 | {feature:'chat';sessionId:string;turnId:string}
 | {feature:'library-chat';scope:import('./library-chat').LibraryChatScope;turnId:string};
export interface AiAuthorizationReceipt {planId:string;payloadHash:string;expiresAt:number;}
