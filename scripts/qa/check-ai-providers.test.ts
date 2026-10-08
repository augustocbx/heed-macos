import {afterEach, expect, test} from 'bun:test';
import {cleanupFixtures, fixture} from '../../packages/server/lib/inference/connection-fixtures';
import {getAiAdapter, AI_ENDPOINTS} from '../../packages/server/lib/inference/adapters';
import {AiInferenceError, type AiAdapterRequest} from '../../packages/server/lib/inference/contracts';
import {modelCapabilities} from '../../packages/server/lib/inference/model-metadata';
import {readCheckerOptions, runSyntheticCheck, checkerOutcome, syntheticCall} from './check-ai-providers';

afterEach(cleanupFixtures);
const local = {provider:'ollama',model:'fixture-model',connectionId:null,language:'en'} as const;
const output = '{"claims":[{"sourceId":"synthetic-en","quote":"Mira will check the sample report on Friday."}]}';
function localFetch(text=output, doneReason='stop') {
 const bodies:unknown[]=[];
 const fetcher=(async(url:Parameters<typeof fetch>[0],init?:RequestInit)=>{
  if(String(url).endsWith('/api/tags'))return Response.json({models:[{name:'fixture-model'}]});
  if(String(url).endsWith('/api/show'))return Response.json({details:{family:'llama'},capabilities:['completion'],model_info:{'llama.context_length':8192}});
  bodies.push(JSON.parse(String(init?.body)));
  return new Response(JSON.stringify({response:text,done:true,done_reason:doneReason}));
 }) as typeof fetch;
 return {fetcher,bodies};
}
test('checker rejects private input, key, endpoint, admission overrides and duplicate arguments',()=>{
 const base=['--provider','openai','--model','gpt-6-luna','--connection','00000000-0000-4000-8000-000000000001','--language','en'];
 for(const extra of [['--input','private.txt'],['--key','PRIVATE_KEY'],['--endpoint','https://example.test'],['--bypass-budget'],['--provider','xai']])expect(()=>readCheckerOptions([...base,...extra])).toThrow('invalid-arguments');
 expect(()=>readCheckerOptions(base.slice(0,-2))).toThrow('invalid-arguments');
 expect(readCheckerOptions(base)).toMatchObject({provider:'openai',model:'gpt-6-luna',language:'en',allowSyntheticRemote:false});
});
test('preview and missing exact consent send zero synthetic or private content',async()=>{
 const f=fixture(),http=localFetch();
 const preview=await runSyntheticCheck(local,f.manager,{fetch:http.fetcher});
 expect(preview).toMatchObject({exitCode:1,code:'scope-review-required',transport:'not-started',factualQuality:'not-reviewed'});
 expect(preview.preview?.calls[0]?.data).toEqual({language:'en',sources:[{id:'synthetic-en',text:'Mira will check the sample report on Friday. The budget remains undecided.'}]});
 expect(http.bodies).toHaveLength(0);
 const stale=await runSyntheticCheck({...local,acceptedPayloadHash:'0'.repeat(64)},f.manager,{fetch:http.fetcher});
 expect(stale.code).toBe('payload-changed');expect(http.bodies).toHaveLength(0);
});
test('runtime executes only reviewed bounded authored EN/PT fixtures and never persists selections',async()=>{
 for(const language of ['en','pt'] as const){
  const f=fixture(),before=f.manager.snapshot(),text=language==='en'?output:'{"claims":[{"sourceId":"synthetic-pt","quote":"Mira verificará o relatório de exemplo na sexta-feira."}]}',http=localFetch(text);
  const options={...local,language};const preview=await runSyntheticCheck(options,f.manager,{fetch:http.fetcher});
  const report=await runSyntheticCheck({...options,acceptedPayloadHash:preview.preview!.payloadHash},f.manager,{fetch:http.fetcher});
  expect(report).toMatchObject({exitCode:0,transport:'completed',sourceGrounding:'passed',factualQuality:'not-reviewed'});
  expect(http.bodies).toHaveLength(1);const sent=http.bodies[0] as any;
  expect(JSON.parse(sent.prompt)).toEqual(language==='en'?{language:'en',sources:[{id:'synthetic-en',text:'Mira will check the sample report on Friday. The budget remains undecided.'}]}:{language:'pt',sources:[{id:'synthetic-pt',text:'Mira verificará o relatório de exemplo na sexta-feira. O orçamento permanece indefinido.'}]});
  expect(sent.options.num_ctx).toBe(8192);expect(sent.options.num_predict).toBe(256);
  expect(f.manager.snapshot()).toEqual(before);expect(JSON.stringify(report)).not.toContain('credentialReference');
 }
});
test('remote opt-in and consent cannot bypass actual production default-deny policies or retrieve keys',async()=>{
 const f=fixture();const connection=await f.manager.register({provider:'openai',model:'gpt-6-luna',key:'synthetic-secret'});await f.manager.validate(connection.id);
 const options={provider:'openai',model:'gpt-6-luna',connectionId:connection.id,language:'en'} as const;
 f.manager.saveSelection('notes',{provider:options.provider,model:options.model,connectionId:options.connectionId});let reads=0;f.vault.get=async()=>{reads++;throw Error('PRIVATE_KEY');};
 const http=localFetch(),preview=await runSyntheticCheck(options,f.manager,{fetch:http.fetcher});
 expect(preview.code).toBe('synthetic-remote-opt-in-required');
 const consent=await runSyntheticCheck({...options,allowSyntheticRemote:true},f.manager,{fetch:http.fetcher});expect(consent.code).toBe('scope-review-required');
 const denied=await runSyntheticCheck({...options,allowSyntheticRemote:true,acceptedPayloadHash:consent.preview!.payloadHash,allowUnknownCost:true},f.manager,{fetch:http.fetcher});
 expect(denied).toMatchObject({exitCode:1,code:'budget-disabled',transport:'not-started'});expect(reads).toBe(0);expect(http.bodies).toHaveLength(0);expect(JSON.stringify(denied)).not.toContain('synthetic-secret');
});
test('missing registered key or supported capability fails without uploading',async()=>{
 for(const model of ['gpt-6-luna','unverified-model']){
  const f=fixture(),http=localFetch();const c=await f.manager.register({provider:'openai',model,key:'synthetic-secret'});await f.manager.validate(c.id);f.manager.saveSelection('notes',{provider:'openai',model,connectionId:c.id});
  if(model==='gpt-6-luna'){f.values.clear();expect((await f.manager.validate(c.id)).validation).toBe('credential-unavailable');}
  const report=await runSyntheticCheck({provider:'openai',model,connectionId:c.id,language:'en',allowSyntheticRemote:true},f.manager,{fetch:http.fetcher});
  expect(report.exitCode).toBe(1);expect(http.bodies).toHaveLength(0);
  expect(report.code).toBe(model==='unverified-model'?'unsupported-capability':'connection-unvalidated');
 }
});
test('settings mismatch cannot silently select a different provider',async()=>{
 const f=fixture(),http=localFetch();
 const report=await runSyntheticCheck({provider:'openai',model:'gpt-6-luna',connectionId:'00000000-0000-4000-8000-000000000001',language:'en',allowSyntheticRemote:true},f.manager,{fetch:http.fetcher});
 expect(report.code).toBe('settings-changed');expect(http.bodies).toHaveLength(0);
});
test('malformed hash and caller-injected private data fail before any transport',async()=>{
 const f=fixture(),http=localFetch();
 for(const options of [{...local,acceptedPayloadHash:'PRIVATE_HASH'},{...local,data:'PRIVATE_TRANSCRIPT'}]){
  const report=await runSyntheticCheck(options,f.manager,{fetch:http.fetcher});expect(report.code).toBe('invalid-arguments');expect(report.preview).toBeUndefined();
 }
 expect(http.bodies).toHaveLength(0);
});
test('a changed settings checkpoint invalidates the reviewed hash before uploading',async()=>{
 const f=fixture(),http=localFetch();const preview=await runSyntheticCheck(local,f.manager,{fetch:http.fetcher});
 f.manager.saveSelection('chat',{provider:'ollama',connectionId:null,model:'different-local-model'});
 const report=await runSyntheticCheck({...local,acceptedPayloadHash:preview.preview!.payloadHash},f.manager,{fetch:http.fetcher});
 expect(report.code).toBe('payload-changed');expect(http.bodies).toHaveLength(0);
});
test('two-run review rejects replaced credentials and trusted endpoint generations before key retrieval',async()=>{
 for(const changed of ['key','endpoint'] as const){
  const f=fixture(),http=localFetch(),capabilities=modelCapabilities('deepseek','deepseek-flash')!;
  const input=changed==='key'?{provider:'openai' as const,model:'gpt-6-luna',key:'synthetic-secret'}:{provider:'compatible' as const,model:'fixture-model',key:'synthetic-secret',endpoint:'https://trusted.example/api',validationEndpoint:'https://trusted.example/models',trusted:true as const,capabilities};
  const c=await f.manager.register(input);await f.manager.validate(c.id);f.manager.saveSelection('notes',{provider:input.provider,model:input.model,connectionId:c.id});
  const options={provider:input.provider,model:input.model,connectionId:c.id,language:'en' as const,allowSyntheticRemote:true};
  const preview=await runSyntheticCheck(options,f.manager,{fetch:http.fetcher});
  await f.manager.replace(c.id,changed==='key'?{...input,key:'replacement-synthetic-secret'}:{...input,endpoint:'https://changed.example/api',validationEndpoint:'https://changed.example/models'});await f.manager.validate(c.id);
  let reads=0;f.vault.get=async()=>{reads++;throw Error('PRIVATE_KEY');};
  const report=await runSyntheticCheck({...options,acceptedPayloadHash:preview.preview!.payloadHash},f.manager,{fetch:http.fetcher});
  expect(report.code).toBe('payload-changed');expect(report.preview!.payloadHash).not.toBe(preview.preview!.payloadHash);expect(reads).toBe(0);expect(http.bodies).toHaveLength(0);
 }
});
test('completed transport with invented citation is a failed source contract, never factual review',async()=>{
 const f=fixture(),http=localFetch('{"claims":[{"sourceId":"synthetic-en","quote":"The budget was approved."}]}');
 const preview=await runSyntheticCheck(local,f.manager,{fetch:http.fetcher});const report=await runSyntheticCheck({...local,acceptedPayloadHash:preview.preview!.payloadHash},f.manager,{fetch:http.fetcher});
 expect(report).toMatchObject({exitCode:1,transport:'completed',sourceGrounding:'failed',factualQuality:'not-reviewed',code:'source-grounding-failed'});
 expect(JSON.stringify(report)).not.toContain('The budget was approved.');
});
test('cancellation and truncated local output are distinct from completed transport',async()=>{
 const f=fixture(),http=localFetch(output,'length');const preview=await runSyntheticCheck(local,f.manager,{fetch:http.fetcher});
 const truncated=await runSyntheticCheck({...local,acceptedPayloadHash:preview.preview!.payloadHash},f.manager,{fetch:http.fetcher});expect(truncated).toMatchObject({exitCode:1,transport:'truncated',sourceGrounding:'not-checked'});
 const controller=new AbortController();controller.abort(new Error('PRIVATE_REASON'));
 const canceled=await runSyntheticCheck({...local,acceptedPayloadHash:preview.preview!.payloadHash},f.manager,{fetch:http.fetcher,signal:controller.signal});expect(canceled).toMatchObject({exitCode:1,transport:'cancelled'});expect(JSON.stringify(canceled)).not.toContain('PRIVATE_REASON');
});
for(const provider of ['openai','anthropic','deepseek','xai','compatible'] as const)test(`${provider} offline native completion and rate-limit yield distinct checker reports`,async()=>{
 const model=provider==='openai'?'gpt-6-luna':provider==='anthropic'?'claude-haiku-4-5-20251001':provider==='deepseek'?'deepseek-flash':provider==='xai'?'grok-4.3':'fixture-model';
 const selection={provider,model,connectionId:'synthetic'};const call=syntheticCall('en');const capabilities=modelCapabilities(provider,model)??{...modelCapabilities('deepseek','deepseek-flash')!};
 const body=provider==='anthropic'?{type:'message',role:'assistant',content:[{type:'text',text:output}],stop_reason:'end_turn'}:provider==='deepseek'||provider==='compatible'?{choices:[{finish_reason:'stop',message:{role:'assistant',content:output}}]}:{status:'completed',output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:output}]}]};
 const request:AiAdapterRequest={selection,endpoint:provider==='compatible'?'https://trusted.example/api':AI_ENDPOINTS[provider],key:'synthetic-secret',call,capabilities,signal:new AbortController().signal,fetch:(async()=>Response.json(body)) as unknown as typeof fetch};
 const result=await getAiAdapter(provider).generate(request);expect(checkerOutcome('en',result)).toMatchObject({exitCode:0,transport:'completed',sourceGrounding:'passed',factualQuality:'not-reviewed'});
 let failure:unknown;try{await getAiAdapter(provider).generate({...request,fetch:(async()=>Response.json({error:'PRIVATE_BODY'},{status:429})) as unknown as typeof fetch});}catch(error){failure=error;}
 expect(failure).toBeInstanceOf(AiInferenceError);const report=checkerOutcome('en',failure);expect(report).toMatchObject({exitCode:1,transport:'rate-limited'});expect(JSON.stringify(report)).not.toContain('PRIVATE_BODY');
});

test('checker two-run review uses shared real policy and retained fixture counters without a resource bypass',async()=>{
 const f=fixture(),c=await f.manager.register({provider:'openai',model:'gpt-6-luna',key:'synthetic-secret'});await f.manager.validate(c.id);f.manager.saveSelection('notes',{provider:c.provider,model:c.model,connectionId:c.id});
 const {AiBudget}=await import('../../packages/server/lib/inference/budget'),{aiBudgetMetadata}=await import('../../packages/server/lib/inference/planning');const budget=new AiBudget({appDir:f.root});
 try{
  budget.configure({...budget.snapshot().policy,jobLimitMicroUsd:100000000,periodLimitMicroUsd:1000000000,unknownCost:'explicit'});
  const options={provider:c.provider,model:c.model,connectionId:c.id,language:'en' as const,allowSyntheticRemote:true},http=localFetch();let reads=0;f.vault.get=async()=>{reads++;throw Error('unreachable-secret');};
  const first=await runSyntheticCheck(options,f.manager,{fetch:http.fetcher}),second=await runSyntheticCheck(options,f.manager,{fetch:http.fetcher});expect(first.preview!.payloadHash).toBe(second.preview!.payloadHash);expect(first.preview?.costReview?.identity).toBeDefined();expect(budget.snapshot().entries).toHaveLength(0);
  for(let i=0;i<2;i++){const denied=await runSyntheticCheck({...options,acceptedPayloadHash:first.preview!.payloadHash,allowUnknownCost:true},f.manager,{fetch:http.fetcher});expect(denied.code).toBe('resources-unavailable');}
  expect(budget.snapshot().entries).toHaveLength(2);expect(budget.snapshot().entries.every(e=>e.state==='released')).toBe(true);
  const metadata=aiBudgetMetadata({id:'previous-fixture-run',jobId:'qa-synthetic-en',feature:'notes',selection:{provider:c.provider,model:c.model,connectionId:c.id},payloadHash:first.preview!.payloadHash,calls:first.preview!.calls,capabilities:c.capabilities??undefined});
  const review=budget.review(metadata),receipt=budget.reserve(metadata,review,{planId:metadata.planId,expectedPayloadHash:metadata.payloadHash,reviewIdentity:review.identity,allowUnknownCost:true}),attempt=receipt.attempts[0]!;
  budget.dispatch(receipt.id,attempt.callId,attempt.id);budget.settle(attempt.id,{status:'timeout'});budget.cancelUnsubmitted(receipt.id);
  const limited=await runSyntheticCheck({...options,acceptedPayloadHash:first.preview!.payloadHash,allowUnknownCost:true},f.manager,{fetch:http.fetcher});expect(limited.code).toBe('remote-attempt-limit');expect(budget.snapshot().unknownLiabilityCount).toBe(1);expect(reads).toBe(0);expect(http.bodies).toHaveLength(0);
  budget.configure({...budget.snapshot().policy,maxRemoteAttempts:2});const stale=await runSyntheticCheck({...options,acceptedPayloadHash:first.preview!.payloadHash,allowUnknownCost:true},f.manager,{fetch:http.fetcher});expect(stale.code).toBe('payload-changed');expect(stale.preview!.payloadHash).not.toBe(first.preview!.payloadHash);
 }finally{budget.close();}
});
