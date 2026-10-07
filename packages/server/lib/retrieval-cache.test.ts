import {afterEach,expect,test} from 'bun:test';
import {writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {closeRetrievalFixtures,retrievalFixture} from './retrieval-test-utils';
import {transcriptGuard} from './session-tags';
afterEach(closeRetrievalFixtures);
function searchCalls(f:Awaited<ReturnType<typeof retrievalFixture>>){const search=f.index.search.bind(f.index);let count=0;f.index.search=(...args)=>{count++;return search(...args);};return ()=>count;}
test('canonical terms reuse quote-free bounded cached data and each returned object is independent',async()=>{
 const f=await retrievalFixture();f.add('meeting-a','Ação delivery secret-content',['Work']);await f.index.tick();const calls=searchCalls(f),snapshot=f.snapshot();
 const first=await f.retriever.retrieve(snapshot,'AÇÃO delivery'),second=await f.retriever.retrieve(f.snapshot(),'delivery ação');expect(calls()).toBe(1);expect(second.hits).toEqual(first.hits);
 const raw=JSON.stringify((f.retriever as any).cache);const values=[...(f.retriever as any).cache.values()];expect(JSON.stringify(values)).not.toContain('secret-content');expect(values[0].result.hits[0]).not.toHaveProperty('title');expect(values[0].result).not.toHaveProperty('snapshot');expect(raw).not.toContain('quote');
 first.hits.length=0;first.coverage.matchedEvidence=999;const third=await f.retriever.retrieve(snapshot,'ação delivery');expect(third.hits).toHaveLength(1);expect(third.coverage.matchedEvidence).toBe(1);
});
test('TTL and LRU eviction enforce actual entry bounds',async()=>{
 const f=await retrievalFixture({cacheEntries:2,cacheTTLMilliseconds:10});f.add('meeting-a','alpha beta gamma');await f.index.tick();const count=searchCalls(f),snapshot=f.snapshot();
 await f.retriever.retrieve(snapshot,'alpha');await f.retriever.retrieve(snapshot,'beta');await f.retriever.retrieve(snapshot,'alpha');await f.retriever.retrieve(snapshot,'gamma');await f.retriever.retrieve(snapshot,'beta');expect(count()).toBe(4);expect((f.retriever as any).cache.size).toBe(2);
 f.time(10);await f.retriever.retrieve(snapshot,'beta');expect(count()).toBe(5);
});
test('cache bytes use serialized payload bytes, refuse oversized entries and evict before growth',async()=>{
 const f=await retrievalFixture({cacheBytes:1600});f.add('meeting-a','alpha beta gamma');await f.index.tick();const count=searchCalls(f),snapshot=f.snapshot();for(const question of ['alpha','beta','gamma'])await f.retriever.retrieve(snapshot,question);
 const entries=[...(f.retriever as any).cache.entries()] as Array<[string,any]>;expect(entries.reduce((n,[key,e])=>n+Buffer.byteLength(key)+Buffer.byteLength(JSON.stringify(e.result)),0)).toBe((f.retriever as any).cacheBytes);expect((f.retriever as any).cacheBytes).toBeLessThanOrEqual(1600);expect((f.retriever as any).cache.size).toBeLessThanOrEqual(2);
 const tiny=await retrievalFixture({cacheBytes:1});tiny.add('meeting-b','alpha');await tiny.index.tick();const countTiny=searchCalls(tiny);await tiny.retriever.retrieve(tiny.snapshot(),'alpha');await tiny.retriever.retrieve(tiny.snapshot(),'alpha');expect(countTiny()).toBe(2);expect((tiny.retriever as any).cache.size).toBe(0);expect(count()).toBe(3);
});
test('selected partial manifest progress invalidates fallback coverage inside the same generation',async()=>{
 const f=await retrievalFixture({evidenceRows:2});f.add('meeting-a','space occupied',['Other']);f.add('meeting-b','alpha\n\nalpha',['Work']);await f.index.tick();const snapshot=f.snapshot({kind:'library',scope:{mode:'labels',labels:['work'],match:'any'}}),generation=f.index.describe(snapshot).generationId,calls=searchCalls(f);
 const first=await f.retriever.retrieve(snapshot,'alpha');expect(first.coverage.indexComplete).toBe(false);f.store.remove('meeting-a');await f.index.tick();await f.index.tick();expect(f.index.describe(f.snapshot()).generationId).toBe(generation);
 const next=await f.retriever.retrieve(snapshot,'alpha');expect(calls()).toBe(2);expect(next.coverage.indexComplete).toBe(true);expect(next.coverage.strategy).toBe('lexical');
});
test('excluded manifest progress preserves an eligible cache entry while a new generation invalidates it',async()=>{
 const f=await retrievalFixture();f.add('meeting-a','alpha',['Work']);await f.index.tick();const snapshot=f.snapshot({kind:'library',scope:{mode:'labels',labels:['work'],match:'any'}}),calls=searchCalls(f);await f.retriever.retrieve(snapshot,'alpha');
 f.add('excluded','alpha',['Other']);await f.index.tick();await f.retriever.retrieve(snapshot,'alpha');expect(calls()).toBe(1);await f.index.rebuild();await f.retriever.retrieve(snapshot,'alpha');expect(calls()).toBe(2);
});
test('cache source guards reject out-of-band source edits before returning stale IDs',async()=>{
 const f=await retrievalFixture();f.add('meeting-a','alpha');await f.index.tick();const snapshot=f.snapshot();await f.retriever.retrieve(snapshot,'alpha');const path=join(f.root,'sessions','meeting-a.json'),record=JSON.parse(readFileSync(path,'utf8'));record.transcript='changed';writeFileSync(path,JSON.stringify(record));await expect(f.retriever.retrieve(snapshot,'alpha')).rejects.toThrow();
});
test('fallback byte accounting includes raw JSON whitespace and respects source/evidence bounds',async()=>{
 const f=await retrievalFixture({fallbackSourceBytes:1500,fallbackSources:2,fallbackEvidence:3});for(const id of ['meeting-a','meeting-b','meeting-c'])f.add(id,'alpha\n\nalpha');
 const path=join(f.root,'sessions','meeting-a.json'),raw=readFileSync(path,'utf8');writeFileSync(path,raw+' '.repeat(1000));const sized=f.store.readSized('meeting-a',10000);expect(sized.bytes).toBe(Buffer.byteLength(raw)+1000);const result=await f.retriever.retrieve(f.snapshot(),'alpha');expect(result.coverage.lookupComplete).toBe(false);expect(result.coverage.partialReasons).toContain('fallback-limit');expect(result.coverage.searchedMeetings).toBeLessThanOrEqual(2);expect(result.coverage.searchedEvidence).toBeLessThanOrEqual(3);
 const second=await retrievalFixture({fallbackSources:2,fallbackEvidence:3});for(const id of ['meeting-a','meeting-b','meeting-c'])second.add(id,'alpha\n\nalpha');const bounded=await second.retriever.retrieve(second.snapshot(),'alpha');expect(bounded.coverage).toMatchObject({searchedMeetings:2,searchedEvidence:3,matchedEvidence:3,lookupComplete:false});expect(bounded.hits.every((h:any)=>h.sessionId!=='meeting-c')).toBe(true);expect((await second.retriever.materialize(bounded)).length).toBeLessThanOrEqual(3);
});
test('ABA and non-hash metadata source changes invalidate cache versions',async()=>{
 const f=await retrievalFixture();let source=f.add('meeting-a','alpha');await f.index.tick();const snapshot=f.snapshot();await f.retriever.retrieve(snapshot,'alpha');source=f.store.commitSource(source.id,transcriptGuard(source),s=>({...s!,language:'pt'}));await expect(f.retriever.retrieve(snapshot,'alpha')).rejects.toThrow();expect((await f.retriever.retrieve(f.snapshot(),'alpha')).hits[0].transcriptVersion).toBe(source.transcriptVersion!);
});
