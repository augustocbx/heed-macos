import {afterEach,expect,test} from 'bun:test';
import {cleanupFixtures,fixture} from './connection-fixtures';
import {AiBudget} from './budget';
import {AiPlanner,AiPlanError} from './planning';
import {AiAuthorizations} from './authorization';
import {AiRuntime} from './runtime';
import {priceSnapshot} from './catalog';
import {aiResponse} from './http';
import type {AiBudgetPolicy} from '../../../shared/types/ai-budget';
const ledgers:AiBudget[]=[];
afterEach(()=>{for(const budget of ledgers.splice(0))budget.close();cleanupFixtures();});
async function setup(){
 const f=fixture(),c=await f.manager.register({provider:'openai',model:'gpt-6-luna',key:'synthetic-secret'});await f.manager.validate(c.id);
 for(const feature of ['notes','tasks','chat','library-chat'] as const)f.manager.saveSelection(feature,{provider:'openai',model:c.model,connectionId:c.id});
 let price=priceSnapshot('openai',c.model)!,text='source A',reads=0,uploads=0;
 const budget=new AiBudget({appDir:f.root,price:()=>price});ledgers.push(budget);
 const policy:AiBudgetPolicy={jobLimitMicroUsd:100000000,periodLimitMicroUsd:1000000000,periodDays:30,periodStart:Date.now()-1000,maxRemoteAttempts:3,unknownCost:'explicit'};budget.configure(policy);
 const planner=new AiPlanner(f.manager,Date.now,budget),authorizations=new AiAuthorizations(planner);
 for(const feature of ['notes','tasks','chat','library-chat'] as const)planner.register(feature,async()=>({jobId:`${feature}:stable-job`,feature,selection:{provider:'openai',model:c.model,connectionId:c.id},calls:[{id:'call',system:'Only source',data:{text},contextTokens:8192,maxOutputTokens:256}],sources:[],validate:()=>{},attach:()=>{},dispatched:()=>{}}));
 const get=f.vault.get.bind(f.vault);f.vault.get=async reference=>{reads++;return get(reference);};
 const options={planner,authorizations,connections:f.manager,budget,hooks:{acquire:async()=>({release:()=>{}})},generate:async()=>{uploads++;return {text:'result',finish:'completed' as const,usage:{supported:false},provenance:{provider:'openai' as const,model:c.model}};}};
 const runtime=new AiRuntime(options);
 const prepare=async(feature:'notes'|'tasks'|'chat'|'library-chat'='notes')=>{const plan=await planner.prepare({feature});authorizations.authorize(plan.id,{allowRemote:true,expectedPayloadHash:plan.payloadHash,allowUnknownCost:true});return plan;};
 return {...f,budget,policy,planner,authorizations,options,runtime,prepare,reads:()=>reads,uploads:()=>uploads,changeText:()=>text='source B',changePrice:()=>price={...price,verifiedAt:'2026-10-06'}};
}
test('final consent fingerprint contains detached cost review and changes for content, policy and price',async()=>{
 const f=await setup(),first=await f.prepare(),same=await f.prepare();expect(first.payloadHash).toBe(same.payloadHash);
 expect(first.costReview?.identity).toMatch(/^[a-f0-9]{64}$/);
 f.changeText();const content=await f.prepare();expect(content.payloadHash).not.toBe(first.payloadHash);expect(content.costReview!.identity).toBe(first.costReview!.identity);
 f.budget.configure({...f.policy,jobLimitMicroUsd:f.policy.jobLimitMicroUsd-1});const policy=await f.prepare();expect(policy.payloadHash).not.toBe(content.payloadHash);
 f.changePrice();const price=await f.prepare();expect(price.payloadHash).not.toBe(policy.payloadHash);
});
test('real runtime reserves, dispatches, settles and closes every reviewed call',async()=>{
 const f=await setup(),plan=await f.prepare();await f.runtime.execute(plan,new AbortController().signal);
 const snapshot=f.budget.snapshot();expect(f.uploads()).toBe(1);expect(snapshot.entries).toHaveLength(1);expect(snapshot.entries[0]).toMatchObject({jobId:plan.jobId,state:'uncertain',round:1});expect(snapshot.heldMicroUsd).toBe(0);expect(snapshot.unknownLiabilityCount).toBe(1);
});
for(const change of ['policy','price'] as const)test(`held resource admission rejects changed ${change} before protected lookup`,async()=>{
 const f=await setup(),plan=await f.prepare();let entered=false,release!:()=>void;const held=new Promise<void>(r=>release=r);
 f.options.hooks.acquire=async()=>{entered=true;await held;return {release:()=>{}};};const run=f.runtime.execute(plan,new AbortController().signal).catch(e=>e);
 for(let i=0;i<100&&!entered;i++)await Bun.sleep(1);
 if(change==='policy')f.budget.configure({...f.policy,jobLimitMicroUsd:1});else f.changePrice();release();const error=await run;
 expect(error?.code).toBe('budget-review-changed');expect(f.reads()).toBe(0);expect(f.uploads()).toBe(0);expect(f.budget.snapshot().heldMicroUsd).toBe(0);
});
test('guarded budget API reads real usage, validates strict policy and preserves future-anchor repair',async()=>{
 const f=await setup();const request=(path:string,method='GET',value?:unknown,origin?:string)=>new Request(`http://localhost:48100/api/ai/${path}`,{method,headers:origin?{Origin:origin}:{},...(value!==undefined?{body:JSON.stringify(value)}:{})});
 const respond=(req:Request)=>aiResponse(req,f.manager,true,f.budget);
 const usage=await respond(request('usage'));expect(usage?.status).toBe(200);expect(usage?.headers.get('cache-control')).toBe('no-store');
 expect((await respond(request('budget','POST',{...f.policy,maxRemoteAttempts:2})))?.status).toBe(200);expect(f.budget.snapshot().policy.maxRemoteAttempts).toBe(2);
 expect((await respond(request('budget','POST',{...f.policy,key:'private'})))?.status).toBe(400);expect((await respond(request('usage','GET',undefined,'https://hostile.test')))?.status).toBe(403);
});

test('held protected lookup rejects a policy edit before dispatch and closes its allocation',async()=>{
 const f=await setup(),plan=await f.prepare();let entered=false,release!:()=>void;const hold=new Promise<void>(r=>release=r),get=f.vault.get.bind(f.vault);
 f.vault.get=async reference=>{entered=true;await hold;return get(reference);};const run=f.runtime.execute(plan,new AbortController().signal).catch(e=>e);
 for(let i=0;i<100&&!entered;i++)await Bun.sleep(1);expect(entered).toBe(true);f.budget.configure({...f.policy,periodLimitMicroUsd:1});release();
 expect((await run).code).toBe('budget-review-changed');expect(f.uploads()).toBe(0);expect(f.budget.snapshot().entries[0]?.state).toBe('released');
});
test('detached preview and returned grant mutations cannot change the accepted spending decision',async()=>{
 const f=await setup(),plan=await f.prepare(),preview=f.authorizations.preview(plan),grant=f.authorizations.authorize(plan.id,{allowRemote:true,expectedPayloadHash:plan.payloadHash,allowUnknownCost:true});
 preview.costReview!.policy.jobLimitMicroUsd=0;grant.allowUnknownCost=false;expect(plan.costReview!.policy.jobLimitMicroUsd).toBe(f.policy.jobLimitMicroUsd);
 expect(()=>f.authorizations.authorize(plan.id,{allowRemote:true,expectedPayloadHash:plan.payloadHash})).toThrow('authorization-conflict');await f.runtime.execute(plan,new AbortController().signal);expect(f.uploads()).toBe(1);
});
test('missing review cannot use a real budget and stale consent cannot authorize a new policy hash',async()=>{
 const f=await setup(),plan=await f.prepare();f.budget.configure({...f.policy,jobLimitMicroUsd:1});const next=await f.planner.prepare({feature:'notes'});
 expect(()=>f.authorizations.authorize(next.id,{allowRemote:true,expectedPayloadHash:plan.payloadHash,allowUnknownCost:true})).toThrow('payload-changed');
 const plain=new AiPlanner(f.manager),auth=new AiAuthorizations(plain);plain.register('notes',async()=>({feature:'notes',jobId:'plain',selection:plan.selection,calls:plan.calls,sources:[],validate:()=>{},attach:()=>{},dispatched:()=>{}}));const unreviewed=await plain.prepare({feature:'notes'});auth.authorize(unreviewed.id,{allowRemote:true,expectedPayloadHash:unreviewed.payloadHash,allowUnknownCost:true});
 await expect(new AiRuntime({...f.options,planner:plain,authorizations:auth}).execute(unreviewed,new AbortController().signal)).rejects.toThrow('budget-review-changed');expect(f.reads()).toBe(0);expect(f.uploads()).toBe(0);
});
for(const code of ['rate-limited','provider-timeout','request-rejected','cancelled'] as const)test(`${code} settles one dispatched attempt without retries`,async()=>{
 const f=await setup(),plan=await f.prepare(),{AiInferenceError}=await import('./contracts');let calls=0;
 const runtime=new AiRuntime({...f.options,generate:async()=>{calls++;throw new AiInferenceError(code);}});
 await expect(runtime.execute(plan,new AbortController().signal)).rejects.toThrow(code);const s=f.budget.snapshot();expect(calls).toBe(1);expect(s.entries[0]?.state).toBe('uncertain');expect(s.heldMicroUsd).toBe(0);expect(s.unknownLiabilityCount).toBe(1);
});
test('publication failure after a completed request leaves accounting retained and no active reservation',async()=>{
 const f=await setup(),plan=await f.prepare();try{await f.runtime.execute(plan,new AbortController().signal);throw new AiPlanError('invalid-evidence');}catch{}
 const before=f.budget.snapshot();expect(before.entries[0]?.outcome).toBe('completed');expect(before.unknownLiabilityCount).toBe(1);
 const retry=await f.prepare();await f.runtime.execute(retry,new AbortController().signal);expect(f.budget.snapshot().entries.map(e=>e.round)).toEqual([1,2]);expect(f.budget.snapshot().liabilityMicroUsd).toBeGreaterThan(before.liabilityMicroUsd!);
});
test('four calls reserve the whole round before key lookup and consume a single remote round',async()=>{
 const f=await setup(),one=await f.prepare();f.budget.configure({...f.policy,maxRemoteAttempts:1});
 f.planner.register('chat',async()=>({feature:'chat',jobId:'chat:whole-round',selection:one.selection,calls:Array.from({length:4},(_,i)=>({...one.calls[0]!,id:`call-${i}`})),sources:[],validate:()=>{},attach:()=>{},dispatched:()=>{}}));
 const get=f.vault.get.bind(f.vault);f.vault.get=async reference=>{expect(f.budget.snapshot().entries.filter(e=>e.state==='held')).toHaveLength(4);return get(reference);};
 await f.runtime.execute(await f.prepare('chat'),new AbortController().signal);expect(f.uploads()).toBe(4);expect(f.budget.snapshot().entries.map(e=>e.round)).toEqual([1,1,1,1]);
 await expect(f.runtime.execute(await f.prepare('chat'),new AbortController().signal)).rejects.toThrow('remote-attempt-limit');expect(f.uploads()).toBe(4);
});
test('future-anchor HTTP error is sanitized and nonfuture configuration repairs retained records',async()=>{
 const f=await setup();await f.runtime.execute(await f.prepare(),new AbortController().signal);const {Database}=await import('bun:sqlite'),{join}=await import('node:path');const db=new Database(join(f.root,'ai','usage.sqlite'));
 db.query('UPDATE policy SET value=? WHERE id=1').run(JSON.stringify({...f.policy,periodStart:Date.now()+86400000}));db.close();
 const response=await aiResponse(new Request('http://localhost:48100/api/ai/usage'),f.manager,true,f.budget);expect(response?.status).toBe(503);expect(await response!.json()).toMatchObject({code:'budget-period-not-started'});
 const repair=await aiResponse(new Request('http://localhost:48100/api/ai/budget',{method:'POST',body:JSON.stringify(f.policy)}),f.manager,true,f.budget);expect(repair?.status).toBe(200);expect((await repair!.json()).unknownLiabilityCount).toBe(1);
 for(const [method,path,body] of [['POST','usage','{}'],['GET','budget',undefined],['POST','budget','x'.repeat(65537)],['POST','budget','[]']] as const){const r=await aiResponse(new Request(`http://localhost:48100/api/ai/${path}`,{method,...(body?{body}:{})}),f.manager,true,f.budget);expect(r?.status).toBe(body&&body!=='{}'?400:405);}
});
test('production factory opens the same private ledger and keeps local usable if the ledger is corrupt',async()=>{
 const f=await setup(),old=await f.prepare(),{createAiInference}=await import('./production'),{writeFileSync,readFileSync}=await import('node:fs'),{join}=await import('node:path');
 const other=createAiInference(f.manager);expect(other.budget?.snapshot().policy).toEqual(f.policy);other.budget?.close();f.budget.close();ledgers.splice(ledgers.indexOf(f.budget),1);
 writeFileSync(join(f.root,'ai','usage.sqlite'),'PRIVATE_CORRUPTION');const failed=createAiInference(f.manager);expect(failed.budget).toBeUndefined();failed.planner.register('notes',async()=>({jobId:old.jobId,feature:'notes',selection:old.selection,calls:old.calls,sources:[],validate:()=>{},attach:()=>{},dispatched:()=>{}}));await expect(failed.planner.prepare({feature:'notes'})).rejects.toThrow('budget-unavailable');expect(readFileSync(join(f.root,'ai','usage.sqlite'),'utf8')).toBe('PRIVATE_CORRUPTION');expect(await failed.runtime.local('notes','local-fixture',new AbortController().signal,async()=>42)).toBe(42);
 expect((await aiResponse(new Request('http://localhost:48100/api/ai/usage'),f.manager,true,failed.budget))?.status).toBe(503);
});

test('atomic domain cancellation matches the exact old plan and root and preserves dispatched liability',async()=>{
 const f=await setup(),plan=await f.prepare(),{aiBudgetMetadata}=await import('./planning'),metadata=aiBudgetMetadata(plan),old=f.budget.reserve(metadata,plan.costReview!,{planId:plan.id,expectedPayloadHash:plan.payloadHash,reviewIdentity:plan.costReview!.identity,allowUnknownCost:true});
 expect(()=>f.budget.cancelSupersededPlan(plan.id,'notes','other-root')).toThrow('budget-review-changed');expect(f.budget.snapshot().entries[0]?.state).toBe('held');
 f.budget.recover();expect(f.budget.snapshot().entries[0]?.state).toBe('held');await f.prepare();expect(f.budget.snapshot().entries[0]?.state).toBe('held');
 f.budget.dispatch(old.id,old.attempts[0]!.callId,old.attempts[0]!.id);f.budget.cancelSupersededPlan(plan.id,plan.feature,plan.jobId);expect(f.budget.snapshot().entries[0]?.state).toBe('dispatched');
 expect(()=>f.budget.dispatch(old.id,old.attempts[0]!.callId,old.attempts[0]!.id)).toThrow('reservation-finished');
 const restarted=new AiBudget({appDir:f.root});ledgers.push(restarted);restarted.recover();expect(restarted.snapshot().entries[0]?.state).toBe('uncertain');expect(restarted.snapshot().unknownLiabilityCount).toBe(1);
 await f.runtime.execute(await f.prepare(),new AbortController().signal);expect(f.budget.snapshot().entries.map(e=>e.round)).toEqual([1,2]);
});
test('xAI real adapter charge reaches ledger settlement independently of conditional token estimates',async()=>{
 const f=fixture(),c=await f.manager.register({provider:'xai',model:'grok-4.3',key:'synthetic-secret'});await f.manager.validate(c.id);f.manager.saveSelection('notes',{provider:c.provider,model:c.model,connectionId:c.id});
 const budget=new AiBudget({appDir:f.root});ledgers.push(budget);budget.configure({...budget.snapshot().policy,jobLimitMicroUsd:100000000,periodLimitMicroUsd:1000000000,unknownCost:'explicit'});
 const planner=new AiPlanner(f.manager,Date.now,budget),authorizations=new AiAuthorizations(planner);planner.register('notes',async()=>({jobId:'xai:fixture',feature:'notes',selection:{provider:c.provider,model:c.model,connectionId:c.id},calls:[{id:'one',system:'Use source',data:{text:'source'},contextTokens:8192,maxOutputTokens:256}],sources:[],validate:()=>{},attach:()=>{},dispatched:()=>{}}));
 const {getAiAdapter}=await import('./adapters'),runtime=new AiRuntime({planner,authorizations,connections:f.manager,budget,hooks:{acquire:async()=>({release:()=>{}})},generate:input=>getAiAdapter('xai').generate({...input,fetch:(async()=>Response.json({status:'completed',output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'result'}]}],usage:{input_tokens:10,output_tokens:2,total_tokens:12,cost_in_usd_ticks:12345}})) as unknown as typeof fetch})});
 const plan=await planner.prepare({feature:'notes'});authorizations.authorize(plan.id,{allowRemote:true,expectedPayloadHash:plan.payloadHash,allowUnknownCost:true});await runtime.execute(plan,new AbortController().signal);
 const snapshot=budget.snapshot();expect(snapshot.liabilityMicroUsd).toBe(2);expect(snapshot.unknownLiabilityCount).toBe(0);expect(snapshot.entries[0]?.accounting?.reportedCharge?.ticks).toBe('12345');expect(snapshot.entries[0]?.accounting?.tokenEstimate).not.toBeNull();
});
