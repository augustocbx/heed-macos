import { expect, test } from 'bun:test';
import { getAiAdapter, AI_ENDPOINTS } from './adapters';
import { AiInferenceError, type AiAdapterRequest } from './contracts';
import { requestJson } from './transport';
import { listLocalNotesModels } from '../ollama-notes';
import type { AiProviderId, AiCapabilities } from '../../../shared/types/ai';

const schema = { type: 'object', additionalProperties: false, required: ['answer'], properties: { answer: { type: 'string' } } };
const capabilities: AiCapabilities = { features: ['notes', 'tasks', 'chat', 'library-chat'], structuredOutput: 'schema', streaming: false, contextTokens: 8192, maxOutputTokens: 1800, usageCategories: ['inputTokens', 'cachedInputTokens', 'cacheWriteTokens', 'outputTokens', 'reasoningTokens'], billableOutputBound: 'max-output' };
function fixture(body: unknown, status = 200) {
 const requests: { url: string; init: RequestInit }[] = [];
 return { requests, fetch: (async (url: string | URL | Request, init?: RequestInit) => { requests.push({ url: String(url), init: init! }); return Response.json(body, { status }); }) as unknown as typeof fetch };
}
function input(provider: AiProviderId, fetcher: typeof fetch, overrides: Partial<AiAdapterRequest> = {}): AiAdapterRequest {
 return { selection: Object.freeze({ provider, connectionId: 'synthetic', model: 'fixture-model' }), endpoint: provider === 'compatible' ? 'https://trusted.example/v1/chat/completions' : AI_ENDPOINTS[provider], key: 'synthetic-secret', call: { id: 'fixture-call', system: 'Use supplied evidence only. Return JSON with an answer string.', data: { evidence: 'Synthetic approved action.' }, schema, contextTokens: 8192, maxOutputTokens: 1800 }, signal: new AbortController().signal, capabilities: { ...capabilities, structuredOutput: provider === 'deepseek' ? 'validated-json' : 'schema', billableOutputBound: provider === 'xai' ? 'unknown' : 'max-output' }, fetch: fetcher, ...overrides };
}
function responseBody(provider: AiProviderId, text = '{"answer":"Approved"}') {
 if (provider === 'anthropic') return { id: 'msg_fixture', type: 'message', role: 'assistant', model: 'fixture-model', content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, cache_read_input_tokens: 4, cache_creation_input_tokens: 3, output_tokens: 8, output_tokens_details: { thinking_tokens: 2 } } };
 if (provider === 'deepseek' || provider === 'compatible') return { id: 'chat_fixture', object: 'chat.completion', model: 'fixture-model', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: text } }], usage: { prompt_tokens: 17, prompt_cache_hit_tokens: 4, prompt_cache_miss_tokens: 13, completion_tokens: 8, total_tokens: 25, prompt_tokens_details: { cached_tokens: 4 }, completion_tokens_details: { reasoning_tokens: 2 } } };
 return { id: 'resp_fixture', object: 'response', model: 'fixture-model', status: 'completed', incomplete_details: null, error: null, output: [{ id: 'msg_fixture', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }], usage: { input_tokens: 17, input_tokens_details: { cached_tokens: 4, ...(provider === 'openai' ? { cache_write_tokens: 3 } : {}) }, output_tokens: 8, output_tokens_details: { reasoning_tokens: 2 }, total_tokens: 25 } };
}
const remoteProviders = ['openai', 'anthropic', 'deepseek', 'xai', 'compatible'] as const;
test('uniqueItems rejects recursively equal objects regardless of property order', async () => {
 const call = { id: 'unique-objects', system: 'Return JSON only.', data: {}, schema: { type: 'array', uniqueItems: true, items: { type: 'object' } }, contextTokens: 8192, maxOutputTokens: 1800 };
 const duplicate = fixture(responseBody('compatible', '[{"a":1,"nested":{"x":2,"y":[3,4]}},{"nested":{"y":[3,4],"x":2},"a":1}]'));
 await expect(getAiAdapter('compatible').generate(input('compatible', duplicate.fetch, { call, capabilities: { ...capabilities, structuredOutput: 'validated-json' } }))).rejects.toThrow('invalid-output');
 const distinct = fixture(responseBody('compatible', '[{"a":1,"nested":{"x":2,"y":[3,4]}},{"nested":{"y":[4,3],"x":2},"a":1}]'));
 expect((await getAiAdapter('compatible').generate(input('compatible', distinct.fetch, { call, capabilities: { ...capabilities, structuredOutput: 'validated-json' } }))).finish).toBe('completed');
});
for (const keyword of ['enum', 'const'] as const) {
 test(`${keyword} accepts recursively reordered object properties while preserving array order`, async () => {
  const expected = { outer: { a: 1, b: 2 }, ordered: [1, 2] };
  const call = { id: keyword, system: 'Return JSON only.', data: {}, schema: { type: 'object', [keyword]: keyword === 'enum' ? [expected] : expected }, contextTokens: 8192, maxOutputTokens: 1800 };
  const equivalent = fixture(responseBody('compatible', '{"ordered":[1,2],"outer":{"b":2,"a":1}}'));
  expect((await getAiAdapter('compatible').generate(input('compatible', equivalent.fetch, { call, capabilities: { ...capabilities, structuredOutput: 'validated-json' } }))).finish).toBe('completed');
  const reorderedArray = fixture(responseBody('compatible', '{"ordered":[2,1],"outer":{"b":2,"a":1}}'));
  await expect(getAiAdapter('compatible').generate(input('compatible', reorderedArray.fetch, { call, capabilities: { ...capabilities, structuredOutput: 'validated-json' } }))).rejects.toThrow('invalid-output');
 });
}
test('JSON value equality rejects excessive nested constant values without completing output', async () => {
 let nested: unknown = 1; for (let depth = 0; depth < 80; depth++) nested = { child: nested };
 const call = { id: 'deep-const', system: 'Return JSON only.', data: {}, schema: { type: 'object', const: nested }, contextTokens: 8192, maxOutputTokens: 1800 };
 const fake = fixture(responseBody('compatible', JSON.stringify(nested)));
 await expect(getAiAdapter('compatible').generate(input('compatible', fake.fetch, { call, capabilities: { ...capabilities, structuredOutput: 'validated-json' } }))).rejects.toThrow('invalid-output');
});
for (const provider of remoteProviders) {
 test(`${provider} maps its native request, complete output and inclusive usage without changing evidence`, async () => {
  const fake = fixture(responseBody(provider)); const result = await getAiAdapter(provider).generate(input(provider, fake.fetch));
  expect(result).toMatchObject({ text: '{"answer":"Approved"}', finish: 'completed', provenance: { provider, model: 'fixture-model' }, usage: { supported: true, inputTokens: 17, cachedInputTokens: 4, outputTokens: 8, reasoningTokens: 2 } });
  expect(result.usage.cacheWriteTokens).toBe(provider === 'anthropic' || provider === 'openai' ? 3 : undefined);
  expect(JSON.stringify(result)).not.toContain('synthetic-secret'); expect(fake.requests).toHaveLength(1);
  const request = fake.requests[0]!; expect(request.init.redirect).toBe('error'); expect(request.init.credentials).toBe('omit');
  const body = JSON.parse(String(request.init.body)); expect(body.model).toBe('fixture-model'); expect(body.stream).toBe(false);
  if (provider === 'openai' || provider === 'xai') { expect(body.store).toBe(false); expect(body.instructions).toBe('Use supplied evidence only. Return JSON with an answer string.'); expect(JSON.parse(body.input)).toEqual({ evidence: 'Synthetic approved action.' }); expect(body.max_output_tokens).toBe(1800); expect(body.text.format.schema).toEqual(schema); }
  else if (provider === 'anthropic') { expect(new Headers(request.init.headers).get('x-api-key')).toBe('synthetic-secret'); expect(body.system).toBe('Use supplied evidence only. Return JSON with an answer string.'); expect(JSON.parse(body.messages[0].content)).toEqual({ evidence: 'Synthetic approved action.' }); expect(body.output_config.format.schema).toEqual(schema); expect(body.max_tokens).toBe(1800); }
  else { expect(body.messages[0].content).toBe('Use supplied evidence only. Return JSON with an answer string.'); expect(JSON.parse(body.messages[1].content)).toEqual({ evidence: 'Synthetic approved action.' }); expect(body.max_tokens).toBe(1800); expect(body.response_format.type).toBe(provider === 'deepseek' ? 'json_object' : 'json_schema'); }
 });
 test(`${provider} discards vendor error bodies and performs exactly one attempt`, async () => {
  for (const [status, code] of [[401, 'authentication-failed'], [403, 'authentication-failed'], [429, 'rate-limited'], [503, 'provider-unavailable'], [400, 'request-rejected']] as const) {
   const fake = fixture({ error: { message: 'synthetic-secret PRIVATE_VENDOR_BODY' } }, status);
   let failure: unknown; try { await getAiAdapter(provider).generate(input(provider, fake.fetch)); } catch (error) { failure = error; }
   expect(failure).toBeInstanceOf(AiInferenceError); expect((failure as Error).message).toBe(code); expect(String(failure)).not.toContain('PRIVATE_VENDOR_BODY'); expect(fake.requests).toHaveLength(1);
  }
 });
 test(`${provider} rejects truncated, empty, malformed and schema-invalid outputs`, async () => {
  for (const text of ['', '{"answer":', '{"answer":42}', '{"answer":"yes","extra":true}']) {
   const fake = fixture(responseBody(provider, text)); await expect(getAiAdapter(provider).generate(input(provider, fake.fetch))).rejects.toThrow('invalid-output');
  }
  const body = responseBody(provider) as any;
  if (provider === 'anthropic') body.stop_reason = 'max_tokens'; else if (provider === 'deepseek' || provider === 'compatible') body.choices[0].finish_reason = 'length'; else body.status = 'incomplete';
  const fake = fixture(body); await expect(getAiAdapter(provider).generate(input(provider, fake.fetch))).rejects.toThrow('incomplete-output');
 });
 test(`${provider} preserves missing usage as unsupported instead of inventing zero`, async () => {
  const body = responseBody(provider) as any; delete body.usage;
  const fake = fixture(body); expect((await getAiAdapter(provider).generate(input(provider, fake.fetch))).usage).toEqual({ supported: false });
 });
}
test('remote transport rejects unsafe and substituted endpoints before sending any key or content', async () => {
 for (const endpoint of ['http://trusted.example/v1/chat/completions', 'https://user:secret@trusted.example/api', 'https://trusted.example/api?key=secret', 'https://trusted.example/api#fragment']) {
  const fake = fixture({}); await expect(getAiAdapter('compatible').generate(input('compatible', fake.fetch, { endpoint }))).rejects.toThrow('invalid-endpoint'); expect(fake.requests).toHaveLength(0);
 }
 const fake = fixture({}); await expect(getAiAdapter('openai').generate(input('openai', fake.fetch, { endpoint: 'https://trusted.example/api' }))).rejects.toThrow('invalid-endpoint'); expect(fake.requests).toHaveLength(0);
 const redirect = fixture({}, 307); await expect(getAiAdapter('openai').generate(input('openai', redirect.fetch))).rejects.toThrow('invalid-endpoint'); expect(redirect.requests).toHaveLength(1);
});
test('deliberately trusted numeric and self-hosted HTTPS endpoints retain the custom wire contract', async () => {
 for (const endpoint of ['https://8.8.8.8/api', 'https://192.168.0.10/api', 'https://host.local/api', 'https://localhost/api']) {
  const fake = fixture(responseBody('compatible')); const result = await getAiAdapter('compatible').generate(input('compatible', fake.fetch, { endpoint })); expect(result.text).toBe('{"answer":"Approved"}'); expect(fake.requests[0]!.url).toBe(endpoint);
 }
});
test('unverified capabilities and unsupported schema or streaming combinations fail before dispatch', async () => {
 for (const changes of [{ capabilities: undefined }, { onToken: () => {} }, { capabilities: { ...capabilities, streaming: true } }, { capabilities: { ...capabilities, structuredOutput: 'none' as const } }, { capabilities: { ...capabilities, contextTokens: 4096 } }, { capabilities: { ...capabilities, maxOutputTokens: 100 } }]) {
  const fake = fixture(responseBody('compatible')); await expect(getAiAdapter('compatible').generate(input('compatible', fake.fetch, changes))).rejects.toThrow('unsupported-capability'); expect(fake.requests).toHaveLength(0);
 }
 const fake = fixture(responseBody('deepseek')); await expect(getAiAdapter('deepseek').generate(input('deepseek', fake.fetch, { capabilities }))).rejects.toThrow('unsupported-capability'); expect(fake.requests).toHaveLength(0);
});
test('declared absent usage categories stay unknown even if a custom response includes them', async () => {
 const fake = fixture(responseBody('compatible')); const result = await getAiAdapter('compatible').generate(input('compatible', fake.fetch, { capabilities: { ...capabilities, usageCategories: [] } })); expect(result.usage).toEqual({ supported: false });
});
test('xAI visible-output cap does not claim a bound on billable reasoning output', async () => {
 const fake = fixture(responseBody('xai')); const request = input('xai', fake.fetch); expect(request.capabilities!.billableOutputBound).toBe('unknown');
 const body = responseBody('xai') as any; body.usage.output_tokens = 1900; body.usage.output_tokens_details.reasoning_tokens = 1892; body.usage.total_tokens = 1917;
 const larger = fixture(body); const result = await getAiAdapter('xai').generate(input('xai', larger.fetch)); expect(result.usage.outputTokens).toBe(1900); expect(result.usage.reasoningTokens).toBe(1892);
});
test('xAI additive reasoning normalizes inclusive output using the reported total relationship', async () => {
 const body = responseBody('xai') as any; body.usage = { input_tokens: 32, input_tokens_details: { cached_tokens: 8 }, output_tokens: 9, output_tokens_details: { reasoning_tokens: 110 }, total_tokens: 151 };
 const fake = fixture(body); const result = await getAiAdapter('xai').generate(input('xai', fake.fetch)); expect(result.usage).toEqual({ supported: true, inputTokens: 32, cachedInputTokens: 8, outputTokens: 119, reasoningTokens: 110 });
 delete body.usage.total_tokens; const missing = fixture(body); const unknown = await getAiAdapter('xai').generate(input('xai', missing.fetch)); expect(unknown.usage.supported).toBe(false); expect(unknown.usage.outputTokens).toBeUndefined();
});
test('schema keywords outside the supported validator subset fail before dispatch', async () => {
 const fake = fixture(responseBody('openai')); await expect(getAiAdapter('openai').generate(input('openai', fake.fetch, { call: { id: 'unsupported', system: 'Return JSON', data: {}, schema: { type: 'string', pattern: '^yes$' }, contextTokens: 8192, maxOutputTokens: 1800 } }))).rejects.toThrow('unsupported-capability'); expect(fake.requests).toHaveLength(0);
});
test('blocked response body reads are cancelled by the request deadline', async () => {
 let cancelled = false;
 const fetcher = (async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }))) as unknown as typeof fetch;
 await expect(getAiAdapter('openai').generate(input('openai', fetcher, { timeoutMs: 5 }))).rejects.toThrow('provider-timeout'); expect(cancelled).toBe(true);
});
test('local text adapter applies the selected output cap and returns plain notes with unsupported usage', async () => {
 let sent: any;
 const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
  if (String(url).endsWith('/api/tags')) return Response.json({ models: [{ name: 'fixture-model' }] });
  if (String(url).endsWith('/api/show')) return Response.json({ details: { family: 'llama' }, capabilities: ['completion'], model_info: { 'llama.context_length': 8192 } });
  sent = JSON.parse(String(init!.body)); return new Response('{"response":"Plain grounded notes","done":true,"done_reason":"stop"}');
 }) as unknown as typeof fetch;
 const request = input('ollama', fetcher, { endpoint: 'http://127.0.0.1:11434', key: undefined, call: { id: 'local-notes', system: 'Grounding retained.', data: { final_transcript: 'Synthetic action' }, contextTokens: 8192, maxOutputTokens: 321 } });
 const result = await getAiAdapter('ollama').generate(request); expect(result.text).toBe('Plain grounded notes'); expect(result.usage).toEqual({ supported: false }); expect(sent.options.num_predict).toBe(321); expect(sent.format).toBeUndefined(); expect(sent.system).toBe('Grounding retained.'); expect(JSON.parse(sent.prompt)).toEqual({ final_transcript: 'Synthetic action' });
});
test('local adapter rejects length-truncated plain text and caps response wire bytes', async () => {
 for (const stream of ['{"response":"Partial notes","done":true,"done_reason":"length"}', '{"response":"' + 'é'.repeat(1_000_001) + '","done":true}']) {
  const fetcher = (async (url: string | URL | Request) => String(url).endsWith('/api/tags') ? Response.json({ models: [{ name: 'fixture-model' }] }) : String(url).endsWith('/api/show') ? Response.json({ details: { family: 'llama' }, capabilities: ['completion'], model_info: { 'llama.context_length': 8192 } }) : new Response(stream)) as unknown as typeof fetch;
  await expect(getAiAdapter('ollama').generate(input('ollama', fetcher, { endpoint: 'http://127.0.0.1:11434', key: undefined, call: { id: 'local-text', system: 'Grounding', data: {}, contextTokens: 8192, maxOutputTokens: 321 } }))).rejects.toThrow();
 }
});
test('native Anthropic unsupported schema constraints fail before dispatch while validated JSON remains available', async () => {
 const bounded = { type: 'object', additionalProperties: false, required: ['answers'], properties: { answers: { type: 'array', maxItems: 1, items: { type: 'string' } } } };
 const call = { id: 'bounded', system: 'Return JSON with answers array.', data: {}, schema: bounded, contextTokens: 8192, maxOutputTokens: 1800 };
 const native = fixture(responseBody('anthropic', '{"answers":["yes"]}')); await expect(getAiAdapter('anthropic').generate(input('anthropic', native.fetch, { call }))).rejects.toThrow('unsupported-capability'); expect(native.requests).toHaveLength(0);
 const validated = fixture(responseBody('anthropic', '{"answers":["yes"]}')); expect((await getAiAdapter('anthropic').generate(input('anthropic', validated.fetch, { call, capabilities: { ...capabilities, structuredOutput: 'validated-json' } }))).text).toBe('{"answers":["yes"]}');
 const invalid = fixture(responseBody('anthropic', '{"answers":["yes","no"]}')); await expect(getAiAdapter('anthropic').generate(input('anthropic', invalid.fetch, { call, capabilities: { ...capabilities, structuredOutput: 'validated-json' } }))).rejects.toThrow('invalid-output');
});
test('partial and inconsistent usage is unavailable rather than a fabricated complete bill', async () => {
 const body = responseBody('anthropic') as any; delete body.usage.cache_creation_input_tokens;
 const fake = fixture(body); const missing = (await getAiAdapter('anthropic').generate(input('anthropic', fake.fetch))).usage; expect(missing.supported).toBe(false); expect(missing.inputTokens).toBeUndefined(); expect(missing.cacheWriteTokens).toBeUndefined();
 const inconsistent = responseBody('openai') as any; inconsistent.usage.input_tokens_details.cached_tokens = 99;
 const invalid = fixture(inconsistent); expect((await getAiAdapter('openai').generate(input('openai', invalid.fetch))).usage.supported).toBe(false);
});
test('frozen vendor destinations cannot be redirected by changing exported configuration', async () => {
 const original = AI_ENDPOINTS.openai; try { (AI_ENDPOINTS as Record<AiProviderId, string>).openai = 'https://untrusted.example/api'; } catch {}
 const fake = fixture(responseBody('openai')); await expect(getAiAdapter('openai').generate(input('openai', fake.fetch, { endpoint: 'https://untrusted.example/api' }))).rejects.toThrow('invalid-endpoint'); expect(fake.requests).toHaveLength(0); expect(AI_ENDPOINTS.openai).toBe(original);
});
test('local metadata validation and generation cannot exceed their declared deadlines', async () => {
 const fake = fixture({ models: [] }); await expect(listLocalNotesModels('http://127.0.0.1:11434', { fetch: fake.fetch, timeoutMs: 15_001 })).rejects.toThrow('ollama-unavailable'); expect(fake.requests).toHaveLength(0);
 await expect(getAiAdapter('ollama').generate(input('ollama', fake.fetch, { endpoint: 'http://127.0.0.1:11434', key: undefined, timeoutMs: 300_001 }))).rejects.toThrow('ollama-unavailable'); expect(fake.requests).toHaveLength(0);
});
test('local metadata JSON is bounded before a generation request is eligible', async () => {
 const fetcher = (async () => new Response(JSON.stringify({ models: [], padding: 'é'.repeat(1_000_001) }))) as unknown as typeof fetch;
 await expect(listLocalNotesModels('http://127.0.0.1:11434', { fetch: fetcher })).rejects.toThrow('ollama-unavailable');
});
test('adapters freeze the reviewed schema, capability and selection snapshot through completion', async () => {
 let release: (response: Response) => void = () => {};
 const fetcher = (() => new Promise<Response>(resolve => { release = resolve; })) as unknown as typeof fetch;
 const request = input('openai', fetcher, { call: { id: 'frozen', system: 'Return JSON with an answer string.', data: {}, schema: structuredClone(schema), contextTokens: 8192, maxOutputTokens: 1800 }, capabilities: structuredClone(capabilities), selection: { provider: 'openai', connectionId: 'synthetic', model: 'fixture-model' } });
 const run = getAiAdapter('openai').generate(request);
 (request.call.schema!.properties as any).answer.type = 'number'; request.capabilities!.usageCategories.length = 0; (request.selection as any).model = 'changed-model';
 release(Response.json(responseBody('openai')));
 const result = await run; expect(result.text).toBe('{"answer":"Approved"}'); expect(result.provenance.model).toBe('fixture-model'); expect(result.usage.supported).toBe(true);
});
test('transport bounds total response bytes including UTF-8 and aborts oversized readers', async () => {
 let cancelled = false; const bytes = new TextEncoder().encode('é'.repeat(1_000_001));
 const fetcher = (async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes); }, cancel() { cancelled = true; } }))) as unknown as typeof fetch;
 await expect(getAiAdapter('openai').generate(input('openai', fetcher))).rejects.toThrow('response-too-large'); expect(cancelled).toBe(true);
});
test('deadline and cancellation bound blocked fetch and body reads without retries', async () => {
 let attempts = 0; const blocked = (() => { attempts++; return new Promise<Response>(() => {}); }) as unknown as typeof fetch;
 await expect(getAiAdapter('openai').generate(input('openai', blocked, { timeoutMs: 5 }))).rejects.toThrow('provider-timeout'); expect(attempts).toBe(1);
 const controller = new AbortController(); const run = getAiAdapter('openai').generate(input('openai', blocked, { signal: controller.signal })); controller.abort(new Error('synthetic-secret')); await expect(run).rejects.toThrow('cancelled');
 await expect(getAiAdapter('openai').generate(input('openai', blocked, { timeoutMs: 300_001 }))).rejects.toThrow('invalid-request');
 await expect(requestJson({ endpoint: 'https://trusted.example/models', headers: {}, signal: new AbortController().signal, fetch: blocked, validation: true, timeoutMs: 15_001 })).rejects.toThrow('invalid-request');
});
test('local adapter retains loopback, installed-model metadata and completion protections', async () => {
 const fake = fixture({}); await expect(getAiAdapter('ollama').generate(input('ollama', fake.fetch, { endpoint: 'https://remote.example', key: undefined }))).rejects.toThrow('local-only'); expect(fake.requests).toHaveLength(0);
 const requests: string[] = [];
 const fetcher = (async (url: string | URL | Request) => { requests.push(String(url)); return String(url).endsWith('/api/tags') ? Response.json({ models: [{ name: 'fixture-model' }] }) : Response.json({ details: { remote_host: 'https://cloud.example' } }); }) as unknown as typeof fetch;
 await expect(getAiAdapter('ollama').generate(input('ollama', fetcher, { endpoint: 'http://127.0.0.1:11434', key: undefined }))).rejects.toThrow('local-only'); expect(requests.some(url => url.endsWith('/api/generate'))).toBe(false);
});

test('transport bounds exact serialized UTF-8 wire bytes before fetch without truncation',async()=>{
 const fake=fixture({ok:true}),signal=new AbortController().signal;
 for(const body of [{data:'á😀'.repeat(50000)},{schema:{description:'\\"'.repeat(150000)}}])await expect(requestJson({endpoint:AI_ENDPOINTS.openai,headers:{},signal,body,fetch:fake.fetch})).rejects.toThrow('request-too-large');
 expect(fake.requests).toHaveLength(0);
 const body={data:'Revisão 😀 \n "safe"'};await requestJson({endpoint:AI_ENDPOINTS.openai,headers:{},signal,body,fetch:fake.fetch});expect(fake.requests[0]!.init.body).toBe(JSON.stringify(body));
});
for(const provider of remoteProviders)test(`${provider} enforces bounded source/schema and the reviewed final wire cap`,async()=>{
 for(const mode of ['source','schema','wire'] as const){const fake=fixture(responseBody(provider)),request=input(provider,fake.fetch);if(mode==='source')request.call={...request.call,data:{text:'é'.repeat(40000)}};if(mode==='schema')request.call={...request.call,schema:{...schema,description:'😀'.repeat(5000)}};if(mode==='wire')request.call={...request.call,maxRequestBytes:128} as typeof request.call;await expect(getAiAdapter(provider).generate(request)).rejects.toThrow('request-too-large');expect(fake.requests).toHaveLength(0);}
});
