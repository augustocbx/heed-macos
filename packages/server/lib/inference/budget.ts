import {Database} from 'bun:sqlite';
import {constants,lstatSync,mkdirSync,openSync,closeSync} from 'node:fs';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import type {AiProviderId,AiCapabilities} from '../../../shared/types/ai';
import type {AiPriceSnapshot} from '../../../shared/types/ai-cost';
import type {AiBudgetPlan,AiBudgetReview,AiBudgetPolicy,AiBudgetDecision,AiBudgetReservation,AiAttemptOutcome,AiAttemptAccounting,AiUsageEntry,AiUsageSnapshot} from '../../../shared/types/ai-budget';
import {priceSnapshot} from './catalog';
import {estimateAiPlan} from './cost';
import {accountAiOutcome} from './usage';
import {AI_INPUT_BYTES,AI_SCHEMA_BYTES} from './limits';
const safe=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
const maximum=BigInt(Number.MAX_SAFE_INTEGER),day=86400000;
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function fail(code:string):never{throw new AiBudgetError(code);}
export class AiBudgetError extends Error {constructor(readonly code:string){super(code);this.name='AiBudgetError';}}
function bounded(value:bigint):number|null{return value<=maximum&&value>=0n?Number(value):null;}
function amount(value:string):bigint{if(!/^(0|[1-9][0-9]*)$/.test(value))return fail('budget-unavailable');return BigInt(value);}
function id(value:unknown):value is string{return typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,255}$/.test(value);}
export function validateAiBudgetPolicy(value:AiBudgetPolicy):AiBudgetPolicy {
 if(!value||Object.keys(value).sort().join(',')!=='jobLimitMicroUsd,maxRemoteAttempts,periodDays,periodLimitMicroUsd,periodStart,unknownCost'||!safe(value.jobLimitMicroUsd)||!safe(value.periodLimitMicroUsd)||!safe(value.periodDays)||value.periodDays<1||value.periodDays>366||!safe(value.periodStart)||value.periodStart>8640000000000000||!safe(value.maxRemoteAttempts)||value.maxRemoteAttempts<1||value.maxRemoteAttempts>3||!['block','explicit'].includes(value.unknownCost))fail('invalid-budget-policy');
 return {jobLimitMicroUsd:value.jobLimitMicroUsd,periodLimitMicroUsd:value.periodLimitMicroUsd,periodDays:value.periodDays,periodStart:value.periodStart,maxRemoteAttempts:value.maxRemoteAttempts,unknownCost:value.unknownCost};
}
function capabilities(caps:AiCapabilities):AiCapabilities{return {features:[...caps.features],structuredOutput:caps.structuredOutput,streaming:caps.streaming,contextTokens:caps.contextTokens,maxOutputTokens:caps.maxOutputTokens,usageCategories:[...caps.usageCategories],billableOutputBound:caps.billableOutputBound,...(caps.maxBillableOutputTokens===undefined?{}:{maxBillableOutputTokens:caps.maxBillableOutputTokens})};}
/** Never persist a caller's extra fields, even if its structural TypeScript type permits them. */
function project(plan:AiBudgetPlan):AiBudgetPlan {
 if(!plan||!id(plan.planId)||!id(plan.jobId)||!/^[a-f0-9]{64}$/.test(plan.payloadHash)||!['notes','tasks','chat','library-chat'].includes(plan.feature)||!['openai','anthropic','deepseek','xai','compatible'].includes(plan.selection?.provider)||!id(plan.selection.model)||plan.selection.connectionId!==null&&!id(plan.selection.connectionId)||!Array.isArray(plan.calls)||!plan.calls.length||plan.calls.length>4||plan.calls.some(c=>!id(c.id)||!safe(c.inputBytes)||c.inputBytes>(['chat','library-chat'].includes(plan.feature)?5500:AI_INPUT_BYTES)+AI_SCHEMA_BYTES||!safe(c.contextTokens)||c.contextTokens===0||!safe(c.maxOutputTokens)||c.maxOutputTokens===0))fail('invalid-budget-plan');
 return {planId:plan.planId,jobId:plan.jobId,payloadHash:plan.payloadHash,feature:plan.feature,selection:{provider:plan.selection.provider,model:plan.selection.model,connectionId:plan.selection.connectionId},calls:plan.calls.map(c=>({id:c.id,inputBytes:c.inputBytes,contextTokens:c.contextTokens,maxOutputTokens:c.maxOutputTokens})),...(plan.capabilities?{capabilities:capabilities(plan.capabilities)}:{}),attempts:plan.attempts??1};
}
interface Options {appDir:string;now?:()=>number;price?:(provider:AiProviderId,model:string)=>AiPriceSnapshot|null;}
interface StoredReservation {id:string;plan_id:string;job_key:string;review:string;metadata:string;decision:string;finished:number;}
interface StoredAttempt {id:string;reservation_id:string;call_id:string;round:number;period_start:number;state:AiUsageEntry['state'];liability:string;unknown_liability:number;dispatched_at:number|null;outcome:string|null;accounting:string|null;}
/** Device-local accounting. It does not authenticate HTTP consent or authorize transport by itself. */
export class AiBudget {
 private db!:Database;
 private fileIdentity?:{device:number;inode:number;directoryInode:number};
 private path:string;
 private now:()=>number;
 private price:NonNullable<Options['price']>;
 constructor(options:Options){
  this.now=options.now??Date.now;this.price=options.price??priceSnapshot;
  this.path=join(options.appDir,'ai','usage.sqlite');
  try{
   const app=lstatSync(options.appDir);if(!app.isDirectory()||app.isSymbolicLink()||app.uid!==process.getuid?.())throw Error();
   try{mkdirSync(join(options.appDir,'ai'),{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
   this.privateFiles();
   try{const fd=openSync(this.path,constants.O_CREAT|constants.O_EXCL|constants.O_RDWR|constants.O_NOFOLLOW,0o600);closeSync(fd);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
   this.privateFiles();const file=lstatSync(this.path);this.fileIdentity={device:file.dev,inode:file.ino,directoryInode:lstatSync(join(this.path,'..')).ino};this.db=new Database(this.path,{strict:true});
   this.db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
   this.atomic(()=>{
    const version=this.db.query('PRAGMA user_version').get() as {user_version:number};if(version.user_version!==0&&version.user_version!==1)fail('budget-unavailable');
    this.db.exec(`CREATE TABLE IF NOT EXISTS policy (id INTEGER PRIMARY KEY CHECK(id=1), generation INTEGER NOT NULL, value TEXT NOT NULL);
     CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, rounds INTEGER NOT NULL);
     CREATE TABLE IF NOT EXISTS reservations (id TEXT PRIMARY KEY, plan_id TEXT NOT NULL UNIQUE, job_key TEXT NOT NULL REFERENCES jobs(id), review TEXT NOT NULL, metadata TEXT NOT NULL, decision TEXT NOT NULL, finished INTEGER NOT NULL DEFAULT 0);
     CREATE TABLE IF NOT EXISTS attempts (id TEXT PRIMARY KEY, reservation_id TEXT NOT NULL REFERENCES reservations(id), call_id TEXT NOT NULL, round INTEGER NOT NULL, period_start INTEGER NOT NULL, state TEXT NOT NULL, liability TEXT NOT NULL, unknown_liability INTEGER NOT NULL, dispatched_at INTEGER, outcome TEXT, accounting TEXT, UNIQUE(reservation_id,call_id,round));
     CREATE INDEX IF NOT EXISTS attempts_reservation ON attempts(reservation_id); PRAGMA user_version=1;`);
    this.db.query('INSERT OR IGNORE INTO policy VALUES (1,1,?)').run(JSON.stringify({jobLimitMicroUsd:0,periodLimitMicroUsd:0,periodDays:30,periodStart:this.clock(),maxRemoteAttempts:1,unknownCost:'block'}));
    this.current();
   });
  }catch(error){this.db!?.close();if(error instanceof AiBudgetError)throw error;fail('budget-unavailable');}
 }
 /** Check before every operation; never follow a replaced ledger or SQLite companion symlink. */
 private privateFiles():void {
  const directory=lstatSync(join(this.path,'..'));if(!directory.isDirectory()||directory.isSymbolicLink()||this.fileIdentity&&directory.ino!==this.fileIdentity.directoryInode||directory.uid!==process.getuid?.()||(directory.mode&0o777)!==0o700)fail('budget-unavailable');
  for(const suffix of ['','-wal','-shm','-journal']){try{const stat=lstatSync(this.path+suffix);if(suffix===''&&this.fileIdentity&&(stat.dev!==this.fileIdentity.device||stat.ino!==this.fileIdentity.inode))fail('budget-unavailable');if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.uid!==process.getuid?.()||(stat.mode&0o777)!==0o600)fail('budget-unavailable');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT'||suffix===''&&this.fileIdentity)throw error;}}
 }
 private atomic<T>(fn:()=>T):T {
  try{this.privateFiles();const result=this.db.transaction(fn).immediate();this.privateFiles();return result;}catch(error){if(error instanceof AiBudgetError)throw error;return fail('budget-unavailable');}
 }
 private clock():number{const now=this.now();if(!safe(now)||now>8640000000000000)fail('budget-unavailable');return now;}
 private current():{policy:AiBudgetPolicy;generation:number}{const row=this.db.query('SELECT * FROM policy WHERE id=1').get() as {value:string;generation:number};if(!row||!safe(row.generation)||row.generation===0)fail('budget-unavailable');return {policy:validateAiBudgetPolicy(JSON.parse(row.value)),generation:row.generation};}
 private period(policy:AiBudgetPolicy):number{const now=this.clock();return now<=policy.periodStart?policy.periodStart:policy.periodStart+Math.floor((now-policy.periodStart)/(policy.periodDays*day))*policy.periodDays*day;}
 configure(policy:AiBudgetPolicy):void {const next=validateAiBudgetPolicy(policy);this.atomic(()=>{const current=this.current();if(hash(current.policy)===hash(next))return;if(current.generation===Number.MAX_SAFE_INTEGER)fail('budget-unavailable');this.db.query('UPDATE policy SET generation=?,value=? WHERE id=1').run(current.generation+1,JSON.stringify(next));});}
 private reviewed(plan:AiBudgetPlan):AiBudgetReview {
  const {policy,generation}=this.current(),price=structuredClone(this.price(plan.selection.provider,plan.selection.model!)),priceIdentity=hash(price),estimate=estimateAiPlan(plan,price,this.clock());
  const content={policy,policyGeneration:generation,price,priceIdentity,estimate};
  // The planner wraps this cost review in its outer exact-content fingerprint. Excluding
  // that fingerprint avoids a hash cycle; the decision separately binds it and the plan ID.
  const {planId:_,payloadHash:__,...metadata}=plan;
  return {...content,identity:hash({metadata,...content})};
 }
 review(plan:AiBudgetPlan):AiBudgetReview {const metadata=project(plan);return this.atomic(()=>this.reviewed(metadata));}
 private reservation(id:string):StoredReservation{const row=this.db.query('SELECT * FROM reservations WHERE id=?').get(id) as StoredReservation|null;if(!row)fail('reservation-not-found');return row;}
 private attempts(reservationId?:string):StoredAttempt[]{return reservationId?this.db.query('SELECT * FROM attempts WHERE reservation_id=? ORDER BY round,call_id').all(reservationId) as StoredAttempt[]:this.db.query('SELECT * FROM attempts ORDER BY rowid').all() as StoredAttempt[];}
 private receipt(reservation:StoredReservation):AiBudgetReservation{const metadata=JSON.parse(reservation.metadata) as AiBudgetPlan;return {id:reservation.id,planId:reservation.plan_id,jobId:metadata.jobId,reviewIdentity:(JSON.parse(reservation.review) as AiBudgetReview).identity,attempts:this.attempts(reservation.id).map(a=>({id:a.id,callId:a.call_id,round:a.round}))};}
 private counted(a:StoredAttempt,period:number):boolean{return a.state!=='released'&&(a.period_start>=period||a.state==='held'||a.state==='dispatched'||a.state==='uncertain'||a.unknown_liability===1);}
 reserve(plan:AiBudgetPlan,review:AiBudgetReview,decision:AiBudgetDecision):AiBudgetReservation {
  const metadata=project(plan);
  return this.atomic(()=>{
   const current=this.reviewed(metadata);if(!decision||Object.keys(decision).sort().join(',')!=='allowUnknownCost,expectedPayloadHash,planId,reviewIdentity'||decision.planId!==metadata.planId||decision.expectedPayloadHash!==metadata.payloadHash||typeof decision.allowUnknownCost!=='boolean'||decision.reviewIdentity!==current.identity||hash(review)!==hash(current))fail('budget-review-changed');
   const boundDecision={planId:decision.planId,expectedPayloadHash:decision.expectedPayloadHash,reviewIdentity:decision.reviewIdentity,allowUnknownCost:decision.allowUnknownCost};
   const existing=this.db.query('SELECT * FROM reservations WHERE plan_id=?').get(metadata.planId) as StoredReservation|null;
   if(existing){if(existing.finished)fail('reservation-finished');if(existing.metadata!==JSON.stringify(metadata)||existing.decision!==JSON.stringify(boundDecision))fail('budget-review-changed');return this.receipt(existing);}
   const {policy,estimate}=current;
   if(policy.jobLimitMicroUsd===0||policy.periodLimitMicroUsd===0)fail('budget-disabled');
   if(estimate.admissibility==='blocked')fail('cost-estimate-blocked');
   const unknown=estimate.wholeAttemptBoundMicroUsd===null||estimate.status!=='known';
   if(unknown&&(policy.unknownCost!=='explicit'||!decision.allowUnknownCost))fail('unknown-cost-blocked');
   const key=`${metadata.feature}:${metadata.jobId}`,job=this.db.query('SELECT rounds FROM jobs WHERE id=?').get(key) as {rounds:number}|null;
   const rounds=job?.rounds??0;if(!safe(rounds)||rounds>3)fail('budget-unavailable');if(rounds+estimate.attempts>policy.maxRemoteAttempts)fail('remote-attempt-limit');
   if(this.db.query('SELECT id FROM reservations WHERE job_key=? AND finished=0').get(key))fail('job-reserved');
   const rows=this.attempts(),period=this.period(policy),jobIds=new Set((this.db.query('SELECT id FROM reservations WHERE job_key=?').all(key) as {id:string}[]).map(r=>r.id));
   let jobTotal=0n,periodTotal=0n;let unresolved=false;
   for(const a of rows){if(a.state==='released')continue;if(jobIds.has(a.reservation_id))jobTotal+=amount(a.liability);if(this.counted(a,period)){periodTotal+=amount(a.liability);if(a.unknown_liability)unresolved=true;}}
   const allocation=BigInt(estimate.knownComponentsMicroUsd??0);
   if(jobTotal+allocation>BigInt(policy.jobLimitMicroUsd))fail('job-budget-exceeded');
   if(periodTotal+allocation>BigInt(policy.periodLimitMicroUsd))fail('period-budget-exceeded');
   if(unresolved&&(policy.unknownCost!=='explicit'||!decision.allowUnknownCost))fail('unknown-liability');
   const reservationId=randomUUID();this.db.query('INSERT OR IGNORE INTO jobs VALUES (?,0)').run(key);
   this.db.query('INSERT INTO reservations(id,plan_id,job_key,review,metadata,decision) VALUES (?,?,?,?,?,?)').run(reservationId,metadata.planId,key,JSON.stringify(current),JSON.stringify(metadata),JSON.stringify(boundDecision));
   for(let offset=1;offset<=estimate.attempts;offset++)for(const call of metadata.calls){const cost=estimate.calls.find(c=>c.callId===call.id)?.knownComponentsMicroUsd??0;this.db.query('INSERT INTO attempts(id,reservation_id,call_id,round,period_start,state,liability,unknown_liability) VALUES (?,?,?,?,?,?,?,?)').run(randomUUID(),reservationId,call.id,rounds+offset,period,'held',String(cost),unknown?1:0);}
   return this.receipt(this.reservation(reservationId));
  });
 }
 /** Recheck after every asynchronous admission boundary, including immediately before key lookup. */
 assertCurrent(reservationId:string):void {this.atomic(()=>this.assertReservation(this.reservation(reservationId)));}
 private assertReservation(reservation:StoredReservation):void {
  if(reservation.finished)fail('reservation-finished');
  const metadata=JSON.parse(reservation.metadata) as AiBudgetPlan,review=JSON.parse(reservation.review) as AiBudgetReview;
  if(hash(this.reviewed(metadata))!==hash(review))fail('budget-review-changed');
  // A provider report may have increased another active liability after this reservation.
  const jobIds=new Set((this.db.query('SELECT id FROM reservations WHERE job_key=?').all(reservation.job_key) as {id:string}[]).map(r=>r.id));
  let job=0n,period=0n;const start=this.period(review.policy);
  for(const attempt of this.attempts()){if(attempt.state==='released')continue;if(jobIds.has(attempt.reservation_id))job+=amount(attempt.liability);if(this.counted(attempt,start))period+=amount(attempt.liability);}
  if(job>BigInt(review.policy.jobLimitMicroUsd))fail('job-budget-exceeded');
  if(period>BigInt(review.policy.periodLimitMicroUsd))fail('period-budget-exceeded');
 }
 dispatch(reservationId:string,callId:string,attemptId:string):void {
  this.atomic(()=>{
   const reservation=this.reservation(reservationId);this.assertReservation(reservation);
   const attempt=this.db.query('SELECT * FROM attempts WHERE id=? AND reservation_id=? AND call_id=?').get(attemptId,reservationId,callId) as StoredAttempt|null;
   if(!attempt)fail('attempt-not-reserved');if(attempt.state!=='held')fail('attempt-already-dispatched');
   // A round counts once even when its reviewed job contains four distinct generation calls.
   this.db.query('UPDATE jobs SET rounds=MAX(rounds,?) WHERE id=?').run(attempt.round,reservation.job_key);
   this.db.query("UPDATE attempts SET state='dispatched',dispatched_at=?,period_start=? WHERE id=?").run(this.clock(),this.period(this.current().policy),attemptId);
  });
 }
 settle(attemptId:string,outcome:AiAttemptOutcome):void {
  this.atomic(()=>{
   if(!outcome||!['completed','cancelled','timeout','rate-limited','rejected','uncertain'].includes(outcome.status))fail('invalid-attempt-outcome');
   const attempt=this.db.query('SELECT * FROM attempts WHERE id=?').get(attemptId) as StoredAttempt|null;
   if(!attempt||attempt.state==='held'||attempt.state==='released')fail('attempt-not-dispatched');
   const review=JSON.parse(this.reservation(attempt.reservation_id).review) as AiBudgetReview;
   const accounting=accountAiOutcome(outcome,review.price,attempt.dispatched_at!);
   if(attempt.outcome!==null){if(attempt.outcome===outcome.status&&attempt.accounting===JSON.stringify(accounting))return;fail('settlement-conflict');}
   const reported=accounting.reportedCharge,known=reported!==null&&accounting.uncertainty.length===0;
   let liability=known?BigInt(reported!.amountMicroUsd):amount(attempt.liability);
   for(const candidate of [accounting.tokenEstimate.amountMicroUsd,reported?.amountMicroUsd])if(candidate!==null&&candidate!==undefined&&BigInt(candidate)>liability)liability=BigInt(candidate);
   // A reported discounted charge is not added to the token estimate or the possible rejection fee.
   if(known)liability=BigInt(reported!.amountMicroUsd);
   this.db.query('UPDATE attempts SET state=?,liability=?,unknown_liability=?,outcome=?,accounting=? WHERE id=?').run(known?'settled':'uncertain',String(liability),known?0:1,outcome.status,JSON.stringify(accounting),attemptId);
  });
 }
 cancelUnsubmitted(reservationId:string):void {this.atomic(()=>{this.reservation(reservationId);this.db.query("UPDATE attempts SET state='released',liability='0',unknown_liability=0 WHERE reservation_id=? AND state='held'").run(reservationId);this.db.query('UPDATE reservations SET finished=1 WHERE id=?').run(reservationId);});}
 /** Never refunds another process's live allocations; recovery does not authorize any replay. */
 recover():void {this.atomic(()=>{this.db.query("UPDATE attempts SET state='uncertain' WHERE state='dispatched'").run();});}
 snapshot():AiUsageSnapshot {
  return this.atomic(()=>{
   const {policy,generation}=this.current(),period=this.period(policy),attempts=this.attempts();let total=0n,held=0n,unknown=0;
   for(const a of attempts)if(this.counted(a,period)){total+=amount(a.liability);if(a.state==='held')held+=amount(a.liability);if(a.unknown_liability)unknown++;}
   const entries=attempts.slice(-1000).map(a=>{const metadata=JSON.parse(this.reservation(a.reservation_id).metadata) as AiBudgetPlan;
    const liability=bounded(amount(a.liability));if(liability===null)fail('budget-unavailable');
    return {attemptId:a.id,reservationId:a.reservation_id,jobId:metadata.jobId,feature:metadata.feature,selection:metadata.selection,callId:a.call_id,round:a.round,periodStart:a.period_start,state:a.state,liabilityMicroUsd:liability,unknownLiability:!!a.unknown_liability,dispatchedAt:a.dispatched_at,outcome:a.outcome as AiAttemptOutcome['status']|null,accounting:a.accounting?JSON.parse(a.accounting) as AiAttemptAccounting:null};});
   const liabilityMicroUsd=bounded(total),heldMicroUsd=bounded(held),overflow=liabilityMicroUsd===null||heldMicroUsd===null;
   return {policy,policyGeneration:generation,periodStart:period,liabilityMicroUsd,heldMicroUsd,unknownLiabilityCount:unknown,strictRemainingMicroUsd:unknown||overflow?null:Math.max(0,policy.periodLimitMicroUsd-liabilityMicroUsd!),overflow,entries,entriesTruncated:attempts.length>1000,limitation:'device-local-accounting-not-account-wide-invoice'};
  });
 }
 close():void {this.db.close();}
}
