#!/usr/bin/env bun
import {cpus} from 'node:os';
import {dirname,resolve} from 'node:path';
import {existsSync,readFileSync,realpathSync,writeFileSync} from 'node:fs';
import {CHAT_SYSTEM,chatResponseSchema,type ChatGenerationRequest} from '../packages/server/lib/meeting-chat';
import {generateLocalStructured,listLocalChatModels} from '../packages/server/lib/ollama-notes';
import {createOfflineSynchronizationFixture,verifyOfflineCitations} from '../packages/server/lib/qa/synchronization-offline';
import {removeOwnedQuotaFixture} from '../packages/server/lib/qa/capture-quota-fixture';
import {sha256} from '../packages/server/lib/portable-schema';

const args=process.argv.slice(2),models:string[]=[];let output='',fixtureRoot='',baseUrl='http://127.0.0.1:11434',keep=false;
for(let index=0;index<args.length;index++){
 const arg=args[index];
 if(arg==='--keep-fixture'){keep=true;continue;}
 const value=args[++index];if(!value)throw Error('Every valued option requires a value');
 if(arg==='--model')models.push(value);else if(arg==='--output')output=value;else if(arg==='--fixture-root')fixtureRoot=value;else if(arg==='--ollama-url')baseUrl=value;else throw Error('Unknown offline QA option');
}
if(!output||!fixtureRoot||!models.length)throw Error('Required: --output NEW_FILE --fixture-root NEW_DIRECTORY --model INSTALLED_MODEL');
output=resolve(output);fixtureRoot=resolve(fixtureRoot);
const sourceRoot=realpathSync(resolve(import.meta.dir,'..'));
if(realpathSync(dirname(output))!==dirname(output)||existsSync(output)||existsSync(fixtureRoot)||output===fixtureRoot||output.startsWith(`${fixtureRoot}/`)||[output,fixtureRoot].some(path=>path===sourceRoot||path.startsWith(`${sourceRoot}/`)))throw Error('QA output and fixture must be separate, new physical paths outside the checkout');
const available=await listLocalChatModels(baseUrl);
if(models.some(model=>!available.includes(model)))throw Error('Requested model is not an installed compatible local model');
const git=Bun.spawnSync(['git','rev-parse','HEAD'],{cwd:sourceRoot});if(git.exitCode!==0)throw Error('Source revision unavailable');
const sourceFiles=['scripts/check-synchronization-offline-ai.ts','packages/server/lib/qa/synchronization-offline.ts','packages/server/lib/qa/synchronization-integrity.ts','packages/server/lib/meeting-chat.ts','packages/server/lib/library-chat.ts','packages/server/lib/ollama-notes.ts','packages/server/lib/portable-library.ts'];
const sourceHashes=Object.fromEntries(sourceFiles.map(path=>[path,sha256(readFileSync(resolve(sourceRoot,path)))]));
const report:any={version:1,kind:'public-synchronization-offline-ai',sourceCommit:new TextDecoder().decode(git.stdout).trim(),sourceHashes,syntheticProviderSeeding:true,realProviderReplication:false,realAudioCapture:false,localModelExecution:true,checks:[],status:'running',ownedChatsStopped:false,fixtureCleanup:'pending'};
const generate=(input:ChatGenerationRequest)=>generateLocalStructured({baseUrl,model:input.model,system:CHAT_SYSTEM,outputSchema:chatResponseSchema(input.evidence),requireCompletion:true,contextTokens:8192,maxInputBytes:5500,
 data:{question:input.question,history:input.history.slice(-2).map(turn=>({question:turn.question.slice(0,100),answer:turn.answer?.claims.slice(0,2).map(claim=>claim.text).join('\n').slice(0,200)})),evidence:input.evidence},signal:input.signal,numThread:Math.max(2,Math.floor(cpus().length/2))});
let fixture:Awaited<ReturnType<typeof createOfflineSynchronizationFixture>>|undefined;
try{
 fixture=await createOfflineSynchronizationFixture(fixtureRoot,generate);
 const offlineCalls=fixture.providerCalls();
 for(const model of [...new Set(models)])for(const locale of ['en','pt'] as const){
  const questions=[
   {kind:'meeting-decision',scope:'meeting',question:locale==='en'?'What was approved, when, and who owns the checklist?':'O que foi aprovado, quando, e quem é responsável pela lista?',required:locale==='en'?[/Cobalt/i,/Tuesday/i,/Ana/i]:[/Cobalto/i,/terça/i,/Ana/i]},
   {kind:'label-correction',scope:'labels',question:locale==='en'?'What is the final approved budget after the correction?':'Qual é o orçamento final aprovado após a correção?',required:[/\b43\b/]},
   {kind:'label-missing',scope:'labels',question:locale==='en'?'What was the weather at the launch?':'Como estava o tempo no lançamento?',required:[]},
  ];
  for(const scenario of questions){
   const turn=await(scenario.scope==='meeting'?fixture.askMeeting(locale,scenario.question,model):fixture.askLabels(locale,scenario.question,model));
   const failures:string[]=[];
   if(turn.status!=='completed'||!turn.answer)failures.push('generation.incomplete');
   else{
    failures.push(...verifyOfflineCitations(turn.answer,[fixture.meeting(locale)]));
    const text=turn.answer.claims.map(claim=>claim.text).join(' ');
    if(text.includes('DISTRACTOR_QA_9999'))failures.push('scope.excluded-fact');
    if(scenario.kind==='label-missing'&&turn.answer.claims.length)failures.push('missing.unsupported-claims');
    if(scenario.required.some(pattern=>!pattern.test(text)))failures.push('answer.required-fact');
    if(!turn.answer.coverage.complete)failures.push('coverage.incomplete');
   }
   fixture.assertOffline();
   report.checks.push({model,locale,scenario:scenario.kind,status:failures.length?'observed-gap':'passed',failures:[...new Set(failures)],sourceRevision:turn.sourceRevision,answerHash:turn.answer?sha256(Buffer.from(JSON.stringify(turn.answer))):undefined,citationCount:turn.answer?.claims.reduce((count,claim)=>count+claim.citations.length,0)??0});
  }
  fixture.restart();
 }
 report.providerCallsAfterDisable=fixture.providerCalls()-offlineCalls;report.importedMeetings=fixture.sessions.snapshot().sessions.length;
 report.status=report.checks.every((check:any)=>check.status==='passed')?'passed':'observed-gaps';
}catch{
 report.status='observed-gaps';report.failure='Offline QA execution did not complete';
}finally{
 if(fixture){
  try{await Promise.race([fixture.stop(),Bun.sleep(5000).then(()=>{throw Error('Owned QA chat cleanup timed out');})]);report.ownedChatsStopped=true;}catch{report.status='observed-gaps';}
  try{report.fixtureCleanup=removeOwnedQuotaFixture(fixture.root,fixture.receipt,{keep,servicesVerified:report.ownedChatsStopped});}catch{report.fixtureCleanup='retained-cleanup-unverified';report.status='observed-gaps';}
 }else if(existsSync(fixtureRoot))report.fixtureCleanup='retained-incomplete-creation';
 writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
}
console.log(JSON.stringify({status:report.status,checks:report.checks.length,ownedChatsStopped:report.ownedChatsStopped,fixtureCleanup:report.fixtureCleanup}));
if(report.status!=='passed')process.exitCode=1;
