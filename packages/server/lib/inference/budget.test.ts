import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,rmSync,lstatSync,symlinkSync,readFileSync,renameSync,writeFileSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AiBudget} from './budget';
import {priceSnapshot} from './catalog';
import {parseXaiCharge} from './usage';
import type {AiBudgetPlan,AiBudgetPolicy} from '../../../shared/types/ai-budget';
const roots:string[]=[],ledgers:AiBudget[]=[];
afterEach(()=>{for(const ledger of ledgers.splice(0))ledger.close();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
const date=Date.parse('2026-10-07T12:00:00Z');
const policy:AiBudgetPolicy={jobLimitMicroUsd:10_000_000,periodLimitMicroUsd:100_000_000,periodDays:30,periodStart:date,maxRemoteAttempts:3,unknownCost:'explicit'};
function plan(id='p',job='job',calls=1):AiBudgetPlan{return {planId:id,jobId:job,payloadHash:'a'.repeat(64),feature:calls===1?'notes':'chat',selection:{provider:'openai',connectionId:'connection',model:'gpt-6-luna'},calls:Array.from({length:calls},(_,n)=>({id:`call-${n}`,inputBytes:100,contextTokens:8192,maxOutputTokens:256}))};}
function fixture(){const root=mkdtempSync(join(tmpdir(),'heed-budget-'));roots.push(root);let now=date;const options={appDir:root,now:()=>now};const ledger=new AiBudget(options);ledgers.push(ledger);return {root,ledger,options,time:(next:number)=>now=next};}
function admit(ledger:AiBudget,p=plan()){const review=ledger.review(p);return ledger.reserve(p,review,{planId:p.planId,expectedPayloadHash:p.payloadHash,reviewIdentity:review.identity,allowUnknownCost:true});}
function dispatch(ledger:AiBudget,r:ReturnType<typeof admit>,index=0){const a=r.attempts[index]!;ledger.dispatch(r.id,a.callId,a.id);return a.id;}

test('zero defaults deny remote, including a zero-known-component unknown exception',()=>{
 const {ledger}=fixture();expect(ledger.snapshot().policy).toMatchObject({jobLimitMicroUsd:0,periodLimitMicroUsd:0,maxRemoteAttempts:1});
 expect(()=>admit(ledger)).toThrow('budget-disabled');
 const p={...plan(),selection:{provider:'compatible' as const,connectionId:'custom',model:'custom'}};
 expect(()=>admit(ledger,p)).toThrow('budget-disabled');
});
test('policy rejects unsafe limits, invalid periods and retry counts',()=>{
 const {ledger}=fixture();for(const invalid of [{periodDays:0},{periodDays:367},{maxRemoteAttempts:0},{maxRemoteAttempts:4},{jobLimitMicroUsd:1.5},{periodLimitMicroUsd:Number.MAX_SAFE_INTEGER+1},{periodStart:-1}])expect(()=>ledger.configure({...policy,...invalid})).toThrow('invalid-budget-policy');
 ledger.configure(policy);expect(ledger.snapshot().policy).toEqual(policy);
});
test('whole job reserves every call and every explicitly allocated retry slot atomically',()=>{
 const {ledger}=fixture();ledger.configure(policy);const p={...plan('p','job',4),attempts:2};const review=ledger.review(p),r=admit(ledger,p);
 expect(r.attempts).toHaveLength(8);expect(ledger.snapshot().heldMicroUsd).toBe(review.estimate.knownComponentsMicroUsd);
 expect(()=>admit(ledger,{...p,planId:'parallel',attempts:1})).toThrow('job-reserved');
 const id=dispatch(ledger,r);ledger.settle(id,{status:'timeout'});ledger.cancelUnsubmitted(r.id);
 expect(ledger.snapshot().entries.filter(e=>e.state==='released')).toHaveLength(7);
 expect(ledger.snapshot().liabilityMicroUsd).toBe(review.estimate.calls[0]!.knownComponentsMicroUsd);
});
test('two database connections cannot admit competing reservations over the period threshold',()=>{
 const {ledger,options}=fixture();ledger.configure(policy);const amount=ledger.review(plan()).estimate.knownComponentsMicroUsd!;
 ledger.configure({...policy,periodLimitMicroUsd:amount});const second=new AiBudget(options);ledgers.push(second);
 admit(ledger);expect(()=>admit(second,plan('other','other'))).toThrow('period-budget-exceeded');
 expect(second.snapshot().liabilityMicroUsd).toBe(amount);
});
test('single-use decisions deduplicate reservation but cannot replay after unsubmitted cancellation',()=>{
 const {ledger}=fixture();ledger.configure(policy);const p=plan(),review=ledger.review(p),decision={planId:p.planId,expectedPayloadHash:p.payloadHash,reviewIdentity:review.identity,allowUnknownCost:true};
 const r=ledger.reserve(p,review,decision);expect(ledger.reserve(p,review,{allowUnknownCost:true,reviewIdentity:review.identity,expectedPayloadHash:p.payloadHash,planId:p.planId})).toEqual(r);ledger.cancelUnsubmitted(r.id);
 expect(()=>ledger.reserve(p,review,decision)).toThrow('reservation-finished');
 expect(ledger.snapshot().liabilityMicroUsd).toBe(0);
});
test('known components cannot bypass either limit with unknown-cost consent',()=>{
 const {ledger}=fixture();ledger.configure(policy);const amount=ledger.review(plan()).estimate.knownComponentsMicroUsd!;
 ledger.configure({...policy,jobLimitMicroUsd:amount-1});expect(()=>admit(ledger)).toThrow('job-budget-exceeded');
 ledger.configure({...policy,periodLimitMicroUsd:amount-1});expect(()=>admit(ledger)).toThrow('period-budget-exceeded');
});
test('unknown cost requires configured explicit policy and exact decision',()=>{
 const {ledger}=fixture();ledger.configure({...policy,unknownCost:'block'});expect(()=>admit(ledger)).toThrow('unknown-cost-blocked');
 ledger.configure(policy);const p=plan(),review=ledger.review(p);expect(()=>ledger.reserve(p,review,{planId:p.planId,expectedPayloadHash:p.payloadHash,reviewIdentity:review.identity,allowUnknownCost:false})).toThrow('unknown-cost-blocked');
 expect(()=>ledger.reserve(p,review,{planId:p.planId,expectedPayloadHash:p.payloadHash,reviewIdentity:'changed',allowUnknownCost:true})).toThrow('budget-review-changed');
});
test('lowered policy invalidates held dispatch, but retains existing liability',()=>{
 const {ledger}=fixture();ledger.configure(policy);const r=admit(ledger),held=ledger.snapshot().heldMicroUsd;
 ledger.configure({...policy,jobLimitMicroUsd:1});expect(()=>dispatch(ledger,r)).toThrow('budget-review-changed');expect(ledger.snapshot().heldMicroUsd).toBe(held);
 ledger.cancelUnsubmitted(r.id);expect(ledger.snapshot().liabilityMicroUsd).toBe(0);
});
test('price mutation invalidates reviewed admission and held dispatch',()=>{
 const root=mkdtempSync(join(tmpdir(),'heed-price-'));roots.push(root);let price=priceSnapshot('openai','gpt-6-luna');const ledger=new AiBudget({appDir:root,now:()=>date,price:()=>price});ledgers.push(ledger);ledger.configure(policy);
 const p=plan(),review=ledger.review(p),r=admit(ledger);price={...price!,verifiedAt:'2026-10-06'};
 expect(()=>ledger.reserve(p,review,{planId:p.planId,expectedPayloadHash:p.payloadHash,reviewIdentity:review.identity,allowUnknownCost:true})).toThrow('budget-review-changed');
 expect(()=>dispatch(ledger,r)).toThrow('budget-review-changed');
});
test('all ambiguous dispatched outcomes retain conservative and unknown liabilities; settlement is idempotent',()=>{
 for(const status of ['cancelled','timeout','rate-limited','rejected','uncertain','completed'] as const){
  const {ledger}=fixture();ledger.configure(policy);const r=admit(ledger),amount=ledger.snapshot().liabilityMicroUsd,id=dispatch(ledger,r);
  ledger.settle(id,{status});ledger.settle(id,{status});ledger.cancelUnsubmitted(r.id);
  expect(ledger.snapshot().liabilityMicroUsd).toBe(amount);expect(ledger.snapshot().unknownLiabilityCount).toBe(1);expect(ledger.snapshot().strictRemainingMicroUsd).toBeNull();
 }
});
test('token-count estimate never erases unknown whole-attempt liability',()=>{
 const {ledger}=fixture();ledger.configure(policy);const r=admit(ledger),id=dispatch(ledger,r),amount=ledger.snapshot().liabilityMicroUsd;
 ledger.settle(id,{status:'completed',usage:{supported:true,inputTokens:20,cachedInputTokens:0,cacheWriteTokens:0,outputTokens:10}});
 const entry=ledger.snapshot().entries[0];expect(entry.accounting!.tokenEstimate.amountMicroUsd).toBe(7);expect(entry.accounting!.reportedCharge).toBeNull();expect(entry.unknownLiability).toBe(true);expect(ledger.snapshot().liabilityMicroUsd).toBe(amount);
});
test('restart recovery retains unfinished allocations and does not authorize replay',()=>{
 const {ledger,options}=fixture();ledger.configure(policy);const r=admit(ledger,plan('p','job',2)),id=dispatch(ledger,r),before=ledger.snapshot().liabilityMicroUsd;
 const restarted=new AiBudget(options);ledgers.push(restarted);restarted.recover();expect(restarted.snapshot().liabilityMicroUsd).toBe(before);
 expect(()=>restarted.dispatch(r.id,'call-0',id)).toThrow('attempt-already-dispatched');expect(restarted.snapshot().entries[0].state).toBe('uncertain');
});
test('job retry rounds and charges survive new plan IDs and ledger instances',()=>{
 const {ledger,options}=fixture();ledger.configure({...policy,maxRemoteAttempts:2});const first=admit(ledger);ledger.settle(dispatch(ledger,first),{status:'uncertain'});ledger.cancelUnsubmitted(first.id);const amount=ledger.snapshot().liabilityMicroUsd!;
 const second=new AiBudget(options);ledgers.push(second);const retry=admit(second,plan('retry'));expect(retry.attempts[0].round).toBe(2);second.settle(dispatch(second,retry),{status:'uncertain'});second.cancelUnsubmitted(retry.id);
 expect(second.snapshot().liabilityMicroUsd).toBe(amount*2);expect(()=>admit(second,plan('third'))).toThrow('remote-attempt-limit');
});
test('period transitions and reconfiguration carry unfinished liabilities forward',()=>{
 const {ledger,time}=fixture();ledger.configure({...policy,periodDays:1});const r=admit(ledger);ledger.settle(dispatch(ledger,r),{status:'timeout'});ledger.cancelUnsubmitted(r.id);const amount=ledger.snapshot().liabilityMicroUsd;
 time(date+3*86400000);expect(ledger.snapshot().liabilityMicroUsd).toBe(amount);
 ledger.configure({...policy,periodDays:2,periodStart:date+3*86400000});expect(ledger.snapshot().liabilityMicroUsd).toBe(amount);
});
test('private SQLite and companions contain metadata only, and symlink ledgers fail closed',()=>{
 const {ledger,root}=fixture();ledger.configure(policy);admit(ledger);expect(lstatSync(join(root,'ai')).mode&0o777).toBe(0o700);expect(lstatSync(join(root,'ai','usage.sqlite')).mode&0o777).toBe(0o600);
 for(const suffix of ['-wal','-shm']){const file=join(root,'ai',`usage.sqlite${suffix}`);try{expect(lstatSync(file).mode&0o777).toBe(0o600);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
 const other=mkdtempSync(join(tmpdir(),'heed-symlink-'));roots.push(other);symlinkSync(join(root,'ai'),join(other,'ai'));expect(()=>new AiBudget({appDir:other})).toThrow('budget-unavailable');
 expect(readFileSync(join(root,'ai','usage.sqlite')).includes(Buffer.from('SECRET_KEY'))).toBe(false);
});
test('strict xAI tick parsing preserves submicro precision and rejects coercion and unsafe numeric values',()=>{
 expect(parseXaiCharge(10001)).toMatchObject({ticks:'10001',amountMicroUsd:2,basis:'provider-reported-request-charge'});
 expect(parseXaiCharge(500_000_000)).toMatchObject({amountMicroUsd:50_000});
 for(const invalid of [null,undefined,'10000',-1,0.2,NaN,Infinity,Number.MAX_SAFE_INTEGER+1,{},true])expect(parseXaiCharge(invalid)).toBeNull();
 expect(parseXaiCharge(0)?.amountMicroUsd).toBe(0);
});

test('a decision cannot be transplanted to a new random plan despite stable two-run review identity',()=>{
 const {ledger}=fixture();ledger.configure(policy);const first=plan(),second={...first,planId:'second'},review=ledger.review(first);
 expect(ledger.review(second).identity).toBe(review.identity);
 const decision={planId:first.planId,expectedPayloadHash:first.payloadHash,reviewIdentity:review.identity,allowUnknownCost:true};const r=ledger.reserve(first,review,decision);ledger.cancelUnsubmitted(r.id);
 expect(()=>ledger.reserve(second,ledger.review(second),decision)).toThrow('budget-review-changed');
});
test('new process recovery cannot refund or invalidate a live owner held reservation',async()=>{
 const {ledger,root}=fixture();ledger.configure(policy);const r=admit(ledger),before=ledger.snapshot().liabilityMicroUsd;
 const module=new URL('./budget.ts',import.meta.url).pathname;
 const child=Bun.spawn([process.execPath,'-e',`import {AiBudget} from ${JSON.stringify(module)};const ledger=new AiBudget({appDir:process.argv[1],now:()=>${date}});ledger.recover();process.stdout.write(JSON.stringify(ledger.snapshot().liabilityMicroUsd));ledger.close();`,root],{stdout:'pipe',stderr:'pipe'});
 const output=await new Response(child.stdout).text(),errors=await new Response(child.stderr).text();expect(await child.exited).toBe(0);expect(errors).toBe('');expect(JSON.parse(output)).toBe(before);
 expect(()=>dispatch(ledger,r)).not.toThrow();
});
test('simultaneous independent processes share one aggregate allocation',async()=>{
 const {ledger,root}=fixture();ledger.configure(policy);const allowance=ledger.review(plan()).estimate.knownComponentsMicroUsd!;ledger.configure({...policy,periodLimitMicroUsd:allowance});
 const module=new URL('./budget.ts',import.meta.url).pathname;
 const children=Array.from({length:4},(_,i)=>Bun.spawn([process.execPath,'-e',`import {AiBudget} from ${JSON.stringify(module)};await Bun.stdin.text();const ledger=new AiBudget({appDir:process.argv[1],now:()=>${date}});const plan=${JSON.stringify(plan(`p${i}`,`job${i}`))};try{const review=ledger.review(plan);ledger.reserve(plan,review,{planId:plan.planId,expectedPayloadHash:plan.payloadHash,reviewIdentity:review.identity,allowUnknownCost:true});process.stdout.write('admitted');}catch(error){process.stdout.write(error.code);}finally{ledger.close();}`,root],{stdin:'pipe',stdout:'pipe',stderr:'pipe'}));
 for(const child of children){child.stdin.write('start');child.stdin.end();}
 const outputs=await Promise.all(children.map(async child=>{const output=await new Response(child.stdout).text(),errors=await new Response(child.stderr).text();expect(await child.exited).toBe(0);expect(errors).toBe('');return output;}));
 expect(outputs.filter(s=>s==='admitted')).toHaveLength(1);expect(outputs.filter(s=>s==='period-budget-exceeded')).toHaveLength(3);expect(ledger.snapshot().liabilityMicroUsd).toBe(allowance);
});
test('one multi-call job round consumes one slot and respects each maximum across restarts',()=>{
 for(const maxRemoteAttempts of [1,2,3]){
  const {ledger,options}=fixture();ledger.configure({...policy,maxRemoteAttempts});
  for(let round=1;round<=maxRemoteAttempts;round++){
   const active=new AiBudget(options);ledgers.push(active);const r=admit(active,plan(`round-${round}`,'shared',4));expect(new Set(r.attempts.map(a=>a.round))).toEqual(new Set([round]));
   for(const a of r.attempts){active.dispatch(r.id,a.callId,a.id);active.settle(a.id,{status:'uncertain'});}active.cancelUnsubmitted(r.id);
  }
  expect(()=>admit(ledger,{...plan('extra','shared',4),selection:{provider:'deepseek',connectionId:'replacement',model:'deepseek-flash'}})).toThrow('remote-attempt-limit');
 }
});
test('the per-job threshold includes cumulative prior charges after waiting and new selections',()=>{
 const {ledger}=fixture();ledger.configure(policy);const amount=ledger.review(plan()).estimate.knownComponentsMicroUsd!;
 ledger.configure({...policy,jobLimitMicroUsd:amount});const r=admit(ledger);ledger.settle(dispatch(ledger,r),{status:'timeout'});ledger.cancelUnsubmitted(r.id);
 expect(()=>admit(ledger,{...plan('retry'),selection:{provider:'deepseek',connectionId:'replacement',model:'deepseek-flash'}})).toThrow('job-budget-exceeded');
 expect(()=>admit(ledger,plan('new','genuinely-new'))).not.toThrow();
});
test('valid provider ticks settle request charge separately without adding rejection fee or token cost',()=>{
 const {ledger,time}=fixture();ledger.configure({...policy,periodDays:1});const p={...plan(),selection:{provider:'xai' as const,connectionId:'xai',model:'grok-4.3'}},r=admit(ledger,p),id=dispatch(ledger,r);
 ledger.settle(id,{status:'completed',usage:{supported:true,inputTokens:20,cachedInputTokens:0,outputTokens:10},reportedCharge:parseXaiCharge(10001)!});ledger.cancelUnsubmitted(r.id);
 const snapshot=ledger.snapshot(),entry=snapshot.entries[0]!;expect(entry.liabilityMicroUsd).toBe(2);expect(entry.accounting!.reportedCharge!.ticks).toBe('10001');expect(entry.accounting!.tokenEstimate.status).toBe('unknown');expect(snapshot.unknownLiabilityCount).toBe(0);expect(snapshot.liabilityMicroUsd).toBe(2);
 time(date+86400000);expect(ledger.snapshot().liabilityMicroUsd).toBe(0);
});
test('missing, malformed or contradictory usage does not become settled merely because ticks are present',()=>{
 for(const usage of [undefined,{supported:true,inputTokens:1,outputTokens:1,cachedInputTokens:2},{supported:true,inputTokens:1,outputTokens:1,reasoningTokens:2},{supported:false}]){
  const {ledger}=fixture();ledger.configure(policy);const r=admit(ledger,{...plan(),selection:{provider:'xai',connectionId:'xai',model:'grok-4.3'}}),before=ledger.snapshot().liabilityMicroUsd;
  ledger.settle(dispatch(ledger,r),{status:'completed',usage,reportedCharge:parseXaiCharge(0)!});expect(ledger.snapshot().liabilityMicroUsd).toBe(before);expect(ledger.snapshot().unknownLiabilityCount).toBe(1);
 }
});
test('duplicate settlement cannot replace an uncertain attempt with unrelated no-charge evidence',()=>{
 const {ledger}=fixture();ledger.configure(policy);const r=admit(ledger),id=dispatch(ledger,r);ledger.settle(id,{status:'timeout'});
 expect(()=>ledger.settle(id,{status:'completed',reportedCharge:parseXaiCharge(0)!})).toThrow('settlement-conflict');expect(ledger.snapshot().unknownLiabilityCount).toBe(1);
});
test('aggregate overflow remains explicit and blocks admission without losing liabilities',()=>{
 const {ledger}=fixture();ledger.configure({...policy,jobLimitMicroUsd:Number.MAX_SAFE_INTEGER,periodLimitMicroUsd:Number.MAX_SAFE_INTEGER});
 const make=(n:number)=>({...plan(`p${n}`,`job${n}`),selection:{provider:'anthropic' as const,connectionId:'haiku',model:'claude-haiku-4-5-20251001'}});
 const first=admit(ledger,make(1)),second=admit(ledger,make(2));const ids=[dispatch(ledger,first),dispatch(ledger,second)];
 for(const id of ids)ledger.settle(id,{status:'completed',usage:{supported:true,inputTokens:Number.MAX_SAFE_INTEGER,cachedInputTokens:0,cacheWriteTokens:0,outputTokens:0}});
 const snapshot=ledger.snapshot();expect(snapshot.liabilityMicroUsd).toBeNull();expect(snapshot.overflow).toBe(true);expect(snapshot.strictRemainingMicroUsd).toBeNull();expect(snapshot.entries.every(e=>e.liabilityMicroUsd===Number.MAX_SAFE_INTEGER)).toBe(true);
 expect(()=>admit(ledger,make(3))).toThrow('period-budget-exceeded');
});
test('increased actual liability blocks previously held but unsubmitted dispatch',()=>{
 const {ledger}=fixture();ledger.configure(policy);const first=admit(ledger,{...plan('p','job'),selection:{provider:'anthropic',connectionId:'haiku',model:'claude-haiku-4-5-20251001'}}),second=admit(ledger,plan('other','other'));
 ledger.settle(dispatch(ledger,first),{status:'completed',usage:{supported:true,inputTokens:200_000_000,cachedInputTokens:0,cacheWriteTokens:0,outputTokens:0}});
 expect(()=>dispatch(ledger,second)).toThrow('period-budget-exceeded');
});
test('metadata projections exclude arbitrary text and secret fields in persisted records',()=>{
 const {ledger,root}=fixture();ledger.configure(policy);const p={...plan(),text:'PRIVATE_TRANSCRIPT',key:'SECRET_KEY',credentialRef:'OPAQUE_SECRET_REFERENCE'};admit(ledger,p);
 for(const suffix of ['','-wal']){const bytes=readFileSync(join(root,'ai',`usage.sqlite${suffix}`));for(const privateValue of ['PRIVATE_TRANSCRIPT','SECRET_KEY','OPAQUE_SECRET_REFERENCE'])expect(bytes.includes(Buffer.from(privateValue))).toBe(false);}
 const review=ledger.review(plan('new','new'));review.policy.jobLimitMicroUsd=0;expect(ledger.snapshot().policy.jobLimitMicroUsd).toBe(policy.jobLimitMicroUsd);
});
test('symlink SQLite companions, replaced database and widened permissions fail closed',()=>{
 const {ledger,root}=fixture();ledger.configure(policy);const database=join(root,'ai','usage.sqlite');renameSync(database,database+'.saved');writeFileSync(database,'replacement',{mode:0o600});expect(()=>ledger.snapshot()).toThrow('budget-unavailable');
 const other=fixture();other.ledger.close();ledgers.splice(ledgers.indexOf(other.ledger),1);const file=join(other.root,'ai','usage.sqlite');rmSync(file+'-wal',{force:true});symlinkSync(file,file+'-wal');expect(()=>new AiBudget(other.options)).toThrow('budget-unavailable');
 const widened=fixture();chmodSync(join(widened.root,'ai','usage.sqlite'),0o644);expect(()=>widened.ledger.snapshot()).toThrow('budget-unavailable');
});

test('settled requests remain charged to actual dispatch period after a held reservation crosses the boundary',()=>{
 const {ledger,time}=fixture();ledger.configure({...policy,periodDays:1});const r=admit(ledger,{...plan(),selection:{provider:'xai',connectionId:'xai',model:'grok-4.3'}});
 time(date+86400000);ledger.settle(dispatch(ledger,r),{status:'completed',usage:{supported:true,inputTokens:2,outputTokens:1},reportedCharge:parseXaiCharge(10_000)!});ledger.cancelUnsubmitted(r.id);
 expect(ledger.snapshot().liabilityMicroUsd).toBe(1);expect(ledger.snapshot().entries[0]!.periodStart).toBe(date+86400000);
});
test('missing custom pricing cannot bypass known oversize or invalid metadata controls',()=>{
 const {ledger}=fixture();ledger.configure(policy);const p={...plan(),selection:{provider:'compatible' as const,connectionId:'custom',model:'custom'},calls:[{id:'call',inputBytes:Number.MAX_SAFE_INTEGER,contextTokens:8192,maxOutputTokens:100}]};
 expect(()=>admit(ledger,p)).toThrow('invalid-budget-plan');
});

test('cost review avoids a hash cycle while decisions still bind the exact outer content hash',()=>{
 const {ledger}=fixture();ledger.configure(policy);const first=plan(),changed={...first,payloadHash:'b'.repeat(64)};
 const review=ledger.review(first);expect(ledger.review(changed).identity).toBe(review.identity);
 const decision={planId:first.planId,expectedPayloadHash:first.payloadHash,reviewIdentity:review.identity,allowUnknownCost:true};
 expect(()=>ledger.reserve(changed,review,decision)).toThrow('budget-review-changed');expect(ledger.snapshot().entries).toHaveLength(0);
 expect(()=>ledger.reserve(first,review,decision)).not.toThrow();
});
test('known model-limit contradictions and cost overflow cannot use an explicit unknown exception',()=>{
 const {ledger}=fixture();ledger.configure(policy);const p=plan();p.calls[0]!.maxOutputTokens=Number.MAX_SAFE_INTEGER;
 expect(()=>admit(ledger,p)).toThrow('cost-estimate-blocked');
 const root=mkdtempSync(join(tmpdir(),'heed-overflow-'));roots.push(root);const price=priceSnapshot('openai','gpt-6-luna')!;price.contextTiers=[];price.categories.inputTokens=Number.MAX_SAFE_INTEGER;
 const overflow=new AiBudget({appDir:root,now:()=>date,price:()=>price});ledgers.push(overflow);overflow.configure(policy);expect(()=>admit(overflow)).toThrow('cost-estimate-blocked');
});
