import {afterEach,expect,test} from 'bun:test';
import {closeRetrievalFixtures,retrievalFixture} from './retrieval-test-utils';
import {transcriptGuard} from './session-tags';
afterEach(closeRetrievalFixtures);
test('accent folded terms have exact capped-frequency scores and anchors precede deduplicated neighbors',async()=>{
 const f=await retrievalFixture();f.add('meeting-a','Ação ação ação ação delivery\n\nContext without the keywords\n\nDelivery');await f.index.tick();
 const result=await f.retriever.retrieve(f.snapshot(),'ação delivery');expect(result.hits.map((hit:any)=>[hit.evidenceOrdinal,hit.score])).toEqual([[0,204],[2,101],[1,0]]);
 expect(result.coverage).toMatchObject({selectedMeetings:1,selectedEvidence:3,indexedMeetings:1,indexedEvidence:3,searchedMeetings:1,searchedEvidence:3,matchingRowsVisited:3,matchedEvidence:2,retrievedEvidence:3,retrievedMeetings:1,suppliedEvidence:0,citedEvidence:0,indexComplete:true,lookupComplete:true,generationComplete:false});
 expect((await f.retriever.materialize(result)).map((e:any)=>e.quote)).toEqual(['Ação ação ação ação delivery','Delivery','Context without the keywords']);expect(JSON.stringify(result)).not.toContain('Context without');
});
test('a complete zero lexical hit stays empty rather than switching to broad fallback',async()=>{
 const f=await retrievalFixture();f.add('meeting-a','Original content');await f.index.tick();const result=await f.retriever.retrieve(f.snapshot(),'absent');
 expect(result.hits).toEqual([]);expect(result.coverage).toMatchObject({strategy:'lexical',searchedEvidence:1,matchedEvidence:0,retrievedEvidence:0,lookupComplete:true});expect(await f.retriever.materialize(result)).toEqual([]);
});
test('missing index and no-term questions use a useful bounded current-source fallback',async()=>{
 const f=await retrievalFixture({fallbackEvidence:2});f.add('meeting-a','First delivery\n\nSecond delivery\n\nThird delivery');
 const result=await f.retriever.retrieve(f.snapshot(),'delivery');expect(result.coverage).toMatchObject({strategy:'fallback',selectedEvidence:3,indexedEvidence:0,searchedEvidence:2,matchedEvidence:2,lookupComplete:false});expect(result.coverage.partialReasons).toContain('index-missing');expect(result.coverage.partialReasons).toContain('fallback-limit');
 expect((await f.retriever.materialize(result)).map((e:any)=>e.quote)).toEqual(['First delivery','Second delivery']);
 await f.index.tick();const punctuation=await f.retriever.retrieve(f.snapshot(),'?!');expect(punctuation.hits).not.toHaveLength(0);expect(punctuation.coverage.strategy).toBe('fallback');
});
test('accepted source/version changes reject materialization and old captured scopes',async()=>{
 const f=await retrievalFixture();const original=f.add('meeting-a','Original delivery');await f.index.tick();const snapshot=f.snapshot(),result=await f.retriever.retrieve(snapshot,'delivery');
 f.store.commitSource(original.id,transcriptGuard(original),current=>({...current!,transcript:'Changed delivery'}));f.store.commitSource(original.id,transcriptGuard(f.store.read(original.id)!),current=>({...current!,transcript:original.transcript}));
 await expect(f.retriever.materialize(result)).rejects.toThrow();await expect(f.retriever.retrieve(snapshot,'delivery')).rejects.toThrow();const next=await f.retriever.retrieve(f.snapshot(),'delivery');expect(next.hits[0].transcriptVersion).toBe(3);
});
