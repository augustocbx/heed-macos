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
export interface AiResult { text: string; usage: AiUsage; finish: 'completed'; provenance: AiProvenance; }
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
