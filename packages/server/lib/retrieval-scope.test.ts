import {afterEach,expect,test} from 'bun:test';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {closeRetrievalFixtures,retrievalFixture} from './retrieval-test-utils';
afterEach(closeRetrievalFixtures);
test('excluded sources never influence eligible scores, coverage or returned evidence',async()=>{
 const f=await retrievalFixture();f.add('eligible','Delivery approved',['Work']);f.add('excluded','Delivery rejected '.repeat(100),['Other']);await f.index.tick();
 const scope={kind:'library',scope:{mode:'labels',labels:['work'],match:'any'}} as const,snapshot=f.snapshot({...scope,scope:{...scope.scope,labels:[...scope.scope.labels]}}),before=await f.retriever.retrieve(snapshot,'delivery');
 f.store.save({...f.store.read('excluded')!,title:'Excluded title changed'});f.add('another-excluded','delivery '.repeat(200),['Other']);await f.index.tick();
 const after=await f.retriever.retrieve(snapshot,'delivery');expect(after.hits).toEqual(before.hits);expect(after.coverage).toEqual(before.coverage);expect(after.hits.every((hit:any)=>hit.sessionId==='eligible')).toBe(true);expect((await f.retriever.materialize(after)).map((e:any)=>e.quote)).toEqual(['Delivery approved']);
});
test('protected source winners survive more than64 better-scoring repetitions in one source',async()=>{
 const f=await retrievalFixture();f.add('meeting-a',Array.from({length:100},()=> 'delivery delivery budget budget').join('\n\n'));f.add('meeting-b','delivery');await f.index.tick();
 const result=await f.retriever.retrieve(f.snapshot(),'delivery budget');expect(result.hits.some((hit:any)=>hit.sessionId==='meeting-b')).toBe(true);expect(result.hits.length).toBeLessThanOrEqual(32);expect(result.coverage).toMatchObject({matchedEvidence:101,searchedMeetings:2,lookupComplete:true});
});
test('prefetched rows are budgeted and incomplete candidates are discarded when another term stream stops',async()=>{
 const f=await retrievalFixture({queryRows:3});f.add('meeting-a','alpha beta\n\nalpha beta');await f.index.tick();const result=await f.index.search(f.snapshot(),['alpha','beta']);
 expect(result.coverage).toMatchObject({lookupComplete:false,searchedEvidence:null,matchingRowsVisited:2,matchedEvidence:1});expect(result.coverage.partialReasons).toContain('query-budget');expect(result.hits.filter((hit:any)=>hit.score>0).map((hit:any)=>[hit.evidenceOrdinal,hit.score])).toEqual([[0,202]]);
});
test('a held query retains its old generation through rebuild and retires it after reader release',async()=>{
 const f=await retrievalFixture();f.add('meeting-a',Array.from({length:200},(_,i)=>`delivery ${i}`).join('\n\n'));await f.index.tick();const snapshot=f.snapshot(),old=f.index.describe(snapshot).generationId!;
 const realSleep=Bun.sleep;let release!:()=>void,entered!:()=>void,held=false;const wait=new Promise<void>(resolve=>{entered=resolve;}),barrier=new Promise<void>(resolve=>{release=resolve;});
 Bun.sleep=((...args:Parameters<typeof Bun.sleep>)=>{if(!held){held=true;entered();return barrier;}return realSleep(...args);}) as typeof Bun.sleep;
 let searching:Promise<any>|undefined;
 try{searching=f.index.search(snapshot,['delivery']);await wait;await f.index.rebuild();expect(f.index.describe(snapshot).generationId).not.toBe(old);expect(existsSync(join(f.directory,old))).toBe(true);release();const result=await searching;expect(result.generationId).toBe(old);expect(result.coverage.lookupComplete).toBe(true);expect(existsSync(join(f.directory,old))).toBe(false);}
 finally{release();Bun.sleep=realSleep;await searching?.catch(()=>{});}
});
test('empty scoped posting pages do not impose a separate timer per source',async()=>{
 const f=await retrievalFixture();for(let i=0;i<100;i++)f.add(`meeting-${i}`,'unrelated');await f.index.tick();const sleep=Bun.sleep;let yields=0;Bun.sleep=((...args:Parameters<typeof Bun.sleep>)=>{yields++;return sleep(...args);}) as typeof Bun.sleep;
 try{const result=await f.index.search(f.snapshot(),['absent']);expect(result.coverage).toMatchObject({searchedMeetings:100,searchedEvidence:100,lookupComplete:true});expect(yields).toBeLessThanOrEqual(1);}finally{Bun.sleep=sleep;}
});
test('current scope snapshots are immutable and forged copies cannot enter SQL',async()=>{
 const f=await retrievalFixture();f.add('meeting-a','delivery',['Work']);f.add('excluded','delivery',['Other']);await f.index.tick();const snapshot=f.snapshot({kind:'library',scope:{mode:'labels',labels:['work'],match:'any'}});
 expect(Object.isFrozen(snapshot)).toBe(true);expect(Object.isFrozen(snapshot.sources)).toBe(true);expect(Object.isFrozen(snapshot.sources[0])).toBe(true);
 await expect(f.index.search({...snapshot,sources:[...snapshot.sources]},['delivery'])).rejects.toThrow();
});
