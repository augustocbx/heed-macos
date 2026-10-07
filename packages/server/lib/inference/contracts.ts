import {validateCallBytes} from './limits';
import type { AiCapabilities, AiProviderId, AiResult, AiSelection, AiUsage } from '../../../shared/types/ai';
export interface AiCall {
 id: string; system: string; data: unknown; schema?: Record<string, unknown>;
 contextTokens: number; maxOutputTokens: number;
 /** Bound the complete serialized vendor request, not tokens. */
 maxRequestBytes?: number;
}
/** Private server-only transport input. Never serialize this request to a client. */
export interface AiAdapterRequest {
 selection: Readonly<AiSelection>;
 /** Exact generation URL; local Ollama uses its protected loopback base URL. */
 endpoint: string;
 key?: string;
 call: Readonly<AiCall>;
 signal: AbortSignal;
 capabilities?: Readonly<AiCapabilities>;
 onToken?: (token: string) => void;
 fetch?: typeof fetch;
 timeoutMs?: number;
}
export interface AiAdapter { generate(input: AiAdapterRequest): Promise<AiResult>; }
export type AiErrorCode = 'invalid-request' | 'invalid-endpoint' | 'unsupported-capability' | 'authentication-failed' | 'rate-limited' | 'provider-unavailable' | 'provider-timeout' | 'request-rejected' | 'cancelled' | 'response-too-large' | 'request-too-large' | 'invalid-output' | 'incomplete-output';
export class AiInferenceError extends Error {
 constructor(readonly code: AiErrorCode) { super(code); this.name = 'AiInferenceError'; }
}
export function fail(code: AiErrorCode): never { throw new AiInferenceError(code); }

export function record(value: unknown): Record<string, any> {
 if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('invalid-output');
 return value as Record<string, any>;
}
export function tokenCount(value: unknown): number | undefined { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined; }
/** Explicit categories only: absent counts stay unknown, including a missing total. */
export function usage(input: AiAdapterRequest, counts: Omit<AiUsage, 'supported'>): AiUsage {
 const permitted = input.capabilities?.usageCategories ?? [];
 const result: AiUsage = { supported: false };
 for (const category of permitted) { const value = tokenCount(counts[category]); if (value !== undefined) result[category] = value; }
 if (result.inputTokens !== undefined && (result.cachedInputTokens ?? 0) + (result.cacheWriteTokens ?? 0) > result.inputTokens) { delete result.inputTokens; delete result.cachedInputTokens; delete result.cacheWriteTokens; }
 if (result.outputTokens !== undefined && (result.reasoningTokens ?? 0) > result.outputTokens) { delete result.outputTokens; delete result.reasoningTokens; }
 result.supported = result.inputTokens !== undefined && result.outputTokens !== undefined;
 return result;
}
export function prepareRemote(input: AiAdapterRequest, provider: AiProviderId, supportedFormat: 'schema' | 'validated-json'): string {
 const caps = input.capabilities; const call = input.call;
 validateCallBytes(call);
 if (input.selection.provider !== provider || !input.selection.model?.trim() || !input.key?.trim() || /[\r\n]/.test(input.key) || !call.id || !call.system?.trim()) return fail('invalid-request');
 if (!caps || caps.streaming || input.onToken || !Number.isSafeInteger(caps.contextTokens) || !Number.isSafeInteger(caps.maxOutputTokens) || !Number.isSafeInteger(call.contextTokens) || !Number.isSafeInteger(call.maxOutputTokens) || call.contextTokens <= 0 || call.maxOutputTokens <= 0 || call.contextTokens > caps.contextTokens || call.maxOutputTokens > caps.maxOutputTokens) return fail('unsupported-capability');
 if (call.schema && (caps.structuredOutput === 'none' || (supportedFormat === 'validated-json' && caps.structuredOutput === 'schema'))) return fail('unsupported-capability');
 let data: string; try { data = JSON.stringify(call.data); } catch { return fail('invalid-request'); }
 if (typeof data !== 'string') return fail('invalid-request');
 if (call.schema) {
  checkSchema(call.schema);
  if (caps.structuredOutput === 'validated-json' && !/json/i.test(call.system)) return fail('unsupported-capability');
 }
 return data;
}

const schemaKeys = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'anyOf', 'minItems', 'maxItems', 'uniqueItems', 'minLength', 'maxLength', 'minimum', 'maximum', 'title', 'description']);
/** Deliberately bounded JSON Schema subset; unsupported keywords never silently pass. */
function checkSchema(schema: unknown, depth = 0): void {
 if (depth > 24 || !schema || typeof schema !== 'object' || Array.isArray(schema)) return fail('unsupported-capability');
 const value = schema as Record<string, any>;
 if (Object.keys(value).some(key => !schemaKeys.has(key))) return fail('unsupported-capability');
 if (value.type !== undefined && (!['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(value.type) && !(Array.isArray(value.type) && value.type.length && value.type.every((item: unknown) => typeof item === 'string' && ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(item))))) return fail('unsupported-capability');
 if (value.properties !== undefined) { if (!value.properties || typeof value.properties !== 'object' || Array.isArray(value.properties)) return fail('unsupported-capability'); for (const child of Object.values(value.properties)) checkSchema(child, depth + 1); }
 if (value.required !== undefined && (!Array.isArray(value.required) || value.required.some((item: unknown) => typeof item !== 'string'))) return fail('unsupported-capability');
 if (value.additionalProperties !== undefined && typeof value.additionalProperties !== 'boolean') return fail('unsupported-capability');
 if (value.items !== undefined) checkSchema(value.items, depth + 1);
 if (value.anyOf !== undefined) { if (!Array.isArray(value.anyOf) || !value.anyOf.length) return fail('unsupported-capability'); for (const child of value.anyOf) checkSchema(child, depth + 1); }
 if (value.enum !== undefined && (!Array.isArray(value.enum) || !value.enum.length)) return fail('unsupported-capability');
 for (const key of ['minItems', 'maxItems', 'minLength', 'maxLength']) if (value[key] !== undefined && (!Number.isSafeInteger(value[key]) || value[key] < 0)) return fail('unsupported-capability');
 for (const key of ['minimum', 'maximum']) if (value[key] !== undefined && (typeof value[key] !== 'number' || !Number.isFinite(value[key]))) return fail('unsupported-capability');
 if (value.uniqueItems !== undefined && typeof value.uniqueItems !== 'boolean') return fail('unsupported-capability');
}
/** JSON object property order is insignificant; array order remains significant. */
function canonicalJson(value: unknown, depth = 0): string {
 if (depth > 64) return fail('invalid-output');
 if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return JSON.stringify(value);
 if (Array.isArray(value)) return '[' + value.map(item => canonicalJson(item, depth + 1)).join(',') + ']';
 if (value && typeof value === 'object') {
  const object = value as Record<string, unknown>;
  return '{' + Object.keys(object).sort().map(key => JSON.stringify(key) + ':' + canonicalJson(object[key], depth + 1)).join(',') + '}';
 }
 return fail('invalid-output');
}
function matches(value: unknown, schema: Record<string, any>): boolean {
 const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
 if (types.length && !types.some((type: string) => type === 'null' ? value === null : type === 'array' ? Array.isArray(value) : type === 'object' ? !!value && typeof value === 'object' && !Array.isArray(value) : type === 'integer' ? Number.isSafeInteger(value) : type === 'number' ? typeof value === 'number' && Number.isFinite(value) : typeof value === type)) return false;
 const comparable = schema.enum || 'const' in schema ? canonicalJson(value) : undefined;
 if (schema.enum && !schema.enum.some((entry: unknown) => canonicalJson(entry) === comparable)) return false;
 if ('const' in schema && canonicalJson(schema.const) !== comparable) return false;
 if (schema.anyOf && !schema.anyOf.some((entry: Record<string, any>) => matches(value, entry))) return false;
 if (Array.isArray(value)) {
  if (value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity)) return false;
  if (schema.uniqueItems && new Set(value.map(item => canonicalJson(item))).size !== value.length) return false;
  if (schema.items && !value.every(item => matches(item, schema.items))) return false;
 } else if (value && typeof value === 'object') {
  const object = value as Record<string, unknown>;
  if (schema.required?.some((key: string) => !Object.hasOwn(object, key))) return false;
  if (schema.additionalProperties === false && Object.keys(object).some(key => !Object.hasOwn(schema.properties ?? {}, key))) return false;
  for (const [key, child] of Object.entries(schema.properties ?? {})) if (Object.hasOwn(object, key) && !matches(object[key], child as Record<string, any>)) return false;
 } else if (typeof value === 'string' && ([...value].length < (schema.minLength ?? 0) || [...value].length > (schema.maxLength ?? Infinity))) return false;
 else if (typeof value === 'number' && (value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity))) return false;
 return true;
}
export function complete(input: AiAdapterRequest, text: unknown, counts: AiUsage): AiResult {
 if (typeof text !== 'string' || !text.trim()) return fail('invalid-output');
 if (input.call.schema) {
  checkSchema(input.call.schema); let parsed: unknown; try { parsed = JSON.parse(text); } catch { return fail('invalid-output'); }
  if (!matches(parsed, input.call.schema)) return fail('invalid-output');
 }
 return { text, usage: counts, finish: 'completed', provenance: { provider: input.selection.provider, model: input.selection.model! } };
}
export function responseText(body: Record<string, any>): string {
 if (body.status !== 'completed' || body.incomplete_details || body.error) return fail('incomplete-output');
 if (!Array.isArray(body.output)) return fail('invalid-output');
 const parts: string[] = [];
 for (const item of body.output) {
  const output = record(item); if (output.type === 'reasoning') continue;
  if (output.type !== 'message' || output.role !== 'assistant' || output.status !== 'completed' || !Array.isArray(output.content)) return fail('incomplete-output');
  for (const block of output.content) { const content = record(block); if (content.type !== 'output_text' || typeof content.text !== 'string') return fail('invalid-output'); parts.push(content.text); }
 }
 return parts.join('');
}
export function chatText(body: Record<string, any>): unknown {
 if (!Array.isArray(body.choices) || body.choices.length !== 1) return fail('invalid-output');
 const choice = record(body.choices[0]); if (choice.finish_reason !== 'stop') return fail('incomplete-output');
 const message = record(choice.message); if (message.role !== 'assistant' || message.refusal || message.tool_calls?.length) return fail('invalid-output');
 return message.content;
}
