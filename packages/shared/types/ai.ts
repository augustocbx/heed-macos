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
