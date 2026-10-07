import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createOfflineSynchronizationFixture,verifyOfflineCitations,verifyPublicBudgetCorrection} from './synchronization-offline';
import {publicSynchronizationFixture} from './synchronization-integrity';
import {transcriptEvidence} from '../meeting-chat';

const roots:string[]=[];
const fixtures:Awaited<ReturnType<typeof createOfflineSynchronizationFixture>>[]=[];
async function ownedFixture(generate:Parameters<typeof createOfflineSynchronizationFixture>[1]){const value=await createOfflineSynchronizationFixture(location(),generate);fixtures.push(value);return value;}
afterEach(async()=>{for(const value of fixtures.splice(0))await value.stop();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function location(){const parent=realpathSync(mkdtempSync(join(tmpdir(),'heed-offline-unit-')));roots.push(parent);return join(parent,'fixture');}
test('durable production imports survive provider disable and store restart without provider requests',async()=>{
 const fixture=await ownedFixture(async input=>JSON.stringify({claims:[{text:'Supported',evidenceIds:[input.evidence[0]!.id]}],notFound:false}));
 const before=fixture.providerCalls();
 expect(fixture.library.snapshot().configured).toBe(false);expect(fixture.sessions.snapshot().sessions).toHaveLength(3);
 for(const locale of ['en','pt'] as const){
  const session=fixture.meeting(locale);const turn=await fixture.askMeeting(locale,locale==='en'?'What was approved budget?':'Qual orçamento aprovado?','fixture-model');
  expect(turn.status).toBe('completed');expect(turn.answer!.claims.length).toBeGreaterThan(0);expect(verifyOfflineCitations(turn.answer!,[session])).toEqual([]);
 }
 fixture.restart();expect(fixture.sessions.snapshot().sessions).toHaveLength(3);expect(fixture.library.snapshot().configured).toBe(false);
 expect(fixture.providerCalls()).toBe(before);
});
test('production label scope excludes imported distractor and returns explicit missing evidence',async()=>{
 const observed:string[]=[];
 const fixture=await ownedFixture(async input=>{observed.push(JSON.stringify(input.evidence));return JSON.stringify({claims:[],notFound:true});});
 const before=fixture.providerCalls();
 for(const locale of ['en','pt'] as const){const turn=await fixture.askLabels(locale,locale==='en'?'What was the approved budget?':'Qual orçamento foi aprovado?','fixture-model');expect(turn.status).toBe('completed');expect(turn.answer!.claims).toEqual([]);}
 expect(observed).toHaveLength(2);for(const input of observed)expect(input).toContain('43');expect(observed.join(' ')).not.toContain('DISTRACTOR_QA_9999');expect(fixture.providerCalls()).toBe(before);
});
test('citation verifier rejects replaced quotes, wrong revisions and excluded session references',async()=>{
 const fixture=await ownedFixture(async input=>JSON.stringify({claims:[{text:'Supported',evidenceIds:[input.evidence[0]!.id]}],notFound:false}));
 const session=fixture.meeting('en'),turn=await fixture.askMeeting('en','Approved?','fixture-model');
 const answer=structuredClone(turn.answer!);answer.claims[0]!.citations[0]!.quote='Changed quote';
 expect(verifyOfflineCitations(answer,[session])).toContain('citation.quote');
 answer.claims[0]!.citations[0]!.sourceRevision='0'.repeat(64);
 expect(verifyOfflineCitations(answer,[session])).toContain('citation.revision');
 expect(verifyOfflineCitations(turn.answer!,[fixture.meeting('pt')])).toContain('citation.excluded');
});

test.each(['en','pt'] as const)('corrected %s fact requires an affirmative supported result rather than the token 43',locale=>{
 const fixture=publicSynchronizationFixture(locale),citation=transcriptEvidence(fixture.session).find(item=>item.quote.includes('43'))!;
 const answer=(text:string)=>({claims:[{text,citations:[citation]}],coverage:{complete:true,reviewedChunks:1,totalChunks:1,answerLimited:false}});
 const wrong=locale==='en'?['The final approved budget is 42 credits; the 43 credits proposal was rejected.','The approved budget is not 43 credits.','The final approved budget is 42 credits.']:['O orçamento final aprovado é de 42 créditos; a proposta de 43 créditos foi rejeitada.','O orçamento aprovado não é de 43 créditos.','O orçamento final aprovado é de 42 créditos.'];
 for(const text of wrong){expect(verifyOfflineCitations(answer(text),[fixture.session])).toEqual([]);expect(verifyPublicBudgetCorrection(answer(text),locale)).toContain('answer.correction-needs-review');}
 expect(verifyPublicBudgetCorrection(answer(citation.quote),locale)).toEqual([]);
 expect(verifyPublicBudgetCorrection(answer(locale==='en'?'The approved budget is 43 credits.':'O orçamento aprovado é de 43 créditos.'),locale)).toEqual([]);
});

test('actual offline retrieval rejects source drift while generation is held and survives restart',async()=>{
 let entered!:()=>void,release!:()=>void;
 const waiting=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);
 const f=await ownedFixture(async input=>{entered();await gate;return JSON.stringify({claims:[{text:'Supported',evidenceIds:[input.evidence[0]!.id]}],notFound:false});});
 const before=f.providerCalls(),running=f.askMeeting('en','What was approved budget?','fixture-model',5000);
 try{
  await waiting;expect(()=>f.restart()).toThrow('active QA chat');
  const source=f.meeting('en');f.sessions.remove(source.id);release();
  await expect(running).rejects.toThrow();
  await f.stop();f.restart();expect(f.sessions.read(source.id)).toBeNull();expect(f.providerCalls()).toBe(before);f.assertOffline();
 }finally{release();await running.catch(()=>{});}
});
