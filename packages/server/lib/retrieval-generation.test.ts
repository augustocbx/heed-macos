import {afterEach,expect,test} from 'bun:test';
import {closeRetrievalFixtures,retrievalFixture} from './retrieval-test-utils';
import {answerMeetingQuestion,CHAT_SYSTEM} from './meeting-chat';
const answer=answerMeetingQuestion as (...args:any[])=>Promise<any>;
afterEach(closeRetrievalFixtures);
async function retrieved(text:string,question='delivery'){
 const f=await retrievalFixture();f.add('meeting-a',text);await f.index.tick();const result=await f.retriever.retrieve(f.snapshot(),question);return {f,result,evidence:await f.retriever.materialize(result)};
}
test('zero lexical hits complete with zero model calls and distinct exact retrieval coverage',async()=>{
 const {result,evidence}=await retrieved('Unrelated text','absent');let calls=0;const value=await answer({evidence,coverage:result.coverage,question:'absent',history:[],model:'local',generate:async()=>{calls++;return '';}});expect(calls).toBe(0);expect(value.claims).toEqual([]);expect(value.coverage).toMatchObject({complete:false,reviewedChunks:0,totalChunks:0,retrieval:{selectedEvidence:1,searchedEvidence:1,matchedEvidence:0,retrievedEvidence:0,suppliedEvidence:0,citedEvidence:0,generationComplete:true}});
});
test('only currently supplied exact IDs validate and unique supplied/cited stages stay separate',async()=>{
 const {result,evidence}=await retrieved('delivery confirmed\n\nneighbor context');const inputs:any[]=[];
 const value=await answer({evidence,coverage:result.coverage,question:'delivery',history:[],model:'local',generate:async(input:any)=>{inputs.push(input);return JSON.stringify({claims:[{text:'Confirmed',evidenceIds:[input.evidence[0].id,input.evidence[0].id]}],notFound:false});}});
 expect(value.coverage).toMatchObject({complete:false,retrieval:{selectedEvidence:2,retrievedEvidence:2,suppliedEvidence:2,suppliedMeetings:1,citedEvidence:1,citedMeetings:1,generationComplete:true}});expect(value.claims[0].citations[0]).toEqual(evidence[0]);expect(inputs[0].data.evidence).toEqual(inputs[0].evidence);
 await expect(answer({evidence,coverage:result.coverage,question:'delivery',history:[],model:'local',generate:async()=>JSON.stringify({claims:[{text:'Forged',evidenceIds:['excluded:forged']}],notFound:false})})).rejects.toThrow('invalid-evidence');
});
test('complete escaped multibyte JSON is bounded to5500 UTF8 bytes and four calls without cutting quotes',async()=>{
 const {result,evidence}=await retrieved(Array.from({length:40},(_,i)=>`delivery ${i} `+'漢"\\'.repeat(390)).join('\n\n'));const inputs:any[]=[];
 const value=await answer({evidence,coverage:result.coverage,question:'delivery "\\ 漢?',history:[{question:'H'.repeat(2000),answer:{claims:[{text:'漢'.repeat(2000),citations:[]}],coverage:{}}}],model:'local',generate:async(input:any)=>{inputs.push(input);return JSON.stringify({claims:[{text:'Supported',evidenceIds:[input.evidence[0].id]}],notFound:false});}});
 expect(inputs.length).toBeLessThanOrEqual(4);expect(inputs.length).toBeGreaterThan(0);for(const input of inputs){expect(Buffer.byteLength(CHAT_SYSTEM+JSON.stringify(input.data))).toBeLessThanOrEqual(5500);expect(input.data.question).toBe('delivery "\\ 漢?');for(const item of input.evidence)expect(evidence.find(e=>e.id===item.id)).toEqual(item);}
 expect(value.coverage.retrieval.generationComplete).toBe(false);expect(value.coverage.retrieval.partialReasons).toContain('generation-limit');expect(value.coverage.totalChunks).toBeGreaterThan(value.coverage.reviewedChunks);expect(value.coverage.retrieval.suppliedEvidence).toBeLessThan(evidence.length);
});
test('oversized complete question errors before generation and oversized exact evidence is honestly omitted',async()=>{
 const {result,evidence}=await retrieved('delivery');let calls=0;const generate=async()=>{calls++;return '{"claims":[],"notFound":true}';};await expect(answer({evidence,coverage:result.coverage,question:'漢'.repeat(2000),history:[],model:'local',generate})).rejects.toThrow('question-context-too-large');expect(calls).toBe(0);
 const item={...evidence[0],quote:'漢'.repeat(1200)},value=await answer({evidence:[item],coverage:{...result.coverage,retrievedEvidence:1},question:'漢'.repeat(1000),history:[],model:'local',generate});expect(calls).toBe(0);expect(value.coverage.retrieval).toMatchObject({suppliedEvidence:0,citedEvidence:0,generationComplete:false});expect(value.coverage.retrieval.partialReasons).toContain('context-budget');
});
test('abort after a held generator result prevents committing a canceled answer',async()=>{
 const {result,evidence}=await retrieved('delivery');const controller=new AbortController();await expect(answer({evidence,coverage:result.coverage,question:'delivery',history:[],model:'local',signal:controller.signal,generate:async()=>{controller.abort();return JSON.stringify({claims:[{text:'Obsolete',evidenceIds:[evidence[0].id]}],notFound:false});}})).rejects.toThrow('cancelled');
});
