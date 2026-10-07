import {afterEach,expect,test} from 'bun:test';
import {join} from 'node:path';
import {MeetingChatService,meetingMetadataRevision,readChatCommand} from './meeting-chat';
import {LibraryChatService} from './library-chat';
import {RetrievalIndex} from './retrieval-index';
import {RetrievalCatalog} from './retrieval-catalog';
import {MeetingRetriever} from './meeting-retrieval';
import {createRetrievalPolicy} from './retrieval-policy';
import {sourceRevision} from '../../shared/lib/transcript-source';
import {closeRetrievalFixtures,retrievalFixture} from './retrieval-test-utils';
afterEach(closeRetrievalFixtures);
test('pending chat waits only for real catalog discovery and queries fallback despite its own model-slot ownership',async()=>{
 const f=await retrievalFixture();for(let i=0;i<100;i++)f.add(`meeting-${i}`,'Delivery confirmed.',['Work']);f.retriever.close();f.index.close();f.catalog.close();let calls=0;let service:MeetingChatService;
 const catalog=new RetrievalCatalog({store:f.store,policy:f.policy,now:f.now,isBusy:()=>false}),index=new RetrievalIndex({directory:f.directory,catalog,store:f.store,policy:f.policy,now:f.now,quota:f.quota,isBusy:()=>service.pending||service.busy,isQueryBusy:()=>false}),retriever=new MeetingRetriever({store:f.store,catalog,index,policy:f.policy,now:f.now});
 try{service=new MeetingChatService({directory:join(f.root,'chat'),getSession:id=>f.store.read(id),catalog,retriever,isBusy:()=>false,waitingReason:()=>catalog.state()==='ready'?'queued':'retrieval',generate:async input=>{calls++;return JSON.stringify({claims:[{text:'Confirmed',evidenceIds:[input.evidence[0].id]}],notFound:false});}});const source=f.store.read('meeting-0')!;
 service.command(source.id,{action:'send',requestId:'waiting',question:'Delivery?',model:'fixture',expectedSourceRevision:source.transcriptRevision!});await service.tick();expect(service.get(source.id).turns[0]).toMatchObject({status:'waiting',attempts:0,waitingReason:'retrieval'});expect(calls).toBe(0);
 await catalog.reconcile();await service.tick();expect(service.get(source.id).turns[0]).toMatchObject({status:'completed',attempts:1,answer:{coverage:{complete:false,retrieval:{strategy:'fallback',selectedMeetings:1,suppliedEvidence:1,citedEvidence:1}}}});expect(calls).toBe(1);expect(index.describe(catalog.resolve({kind:'meeting',sessionId:source.id}).snapshot).generationId).toBeNull();await index.tick();expect(index.describe(catalog.resolve({kind:'meeting',sessionId:source.id}).snapshot).generationId).toBeString();
 }finally{retriever.close();index.close();catalog.close();}
});
test('catalog source failure becomes an actionable failed queued turn instead of waiting forever',async()=>{
 const f=await retrievalFixture();f.add('meeting-a','Delivery confirmed.');const policy=createRetrievalPolicy({sourceRecordBytes:32}),catalog=new RetrievalCatalog({store:f.store,policy,now:f.now,isBusy:()=>false});
 const service=new MeetingChatService({directory:join(f.root,'chat'),getSession:id=>f.store.read(id),catalog,retriever:f.retriever,isBusy:()=>false,generate:async()=>{throw new Error('Unreadable source must never generate');}});
 try{const source=f.store.read('meeting-a')!;service.command(source.id,{action:'send',requestId:'queued',question:'Delivery?',model:'fixture',expectedSourceRevision:source.transcriptRevision!});await catalog.reconcile();expect(catalog.state()).toBe('unavailable');await service.tick();expect(service.get(source.id).turns[0]).toMatchObject({status:'failed',reason:'retrieval-not-ready'});expect(service.pending).toBe(false);}finally{catalog.close();}
});
test('public catalog preview remains byte-compatible and returned display tags cannot mutate authoritative metadata',async()=>{
 const f=await retrievalFixture();f.add('meeting-a','Delivery',['Work']);f.add('meeting-b','Delivery',['Work','Client']);const scope={mode:'labels',labels:['work'],match:'any'} as const,preview=f.catalog.preview({...scope,labels:[...scope.labels]});
 const {createHash}=await import('node:crypto'),expected={scope:{mode:'labels',labels:['work'],match:'any'},sources:['meeting-a','meeting-b'].map(id=>{const s=f.store.read(id)!;return {sessionId:s.id,title:s.title,tags:[...s.tags].sort(),sourceRevision:sourceRevision(s)};}),metadata:['meeting-a','meeting-b'].map(id=>meetingMetadataRevision(f.store.read(id)!))};expect(preview.snapshot.key).toBe(createHash('sha256').update(JSON.stringify(expected)).digest('hex'));
 const snapshot=f.catalog.resolve({kind:'library',scope:{...scope,labels:[...scope.labels]}}).snapshot,description=f.catalog.describe(snapshot);description[0].displayTags.push('Forged');expect(f.catalog.preview({...scope,labels:[...scope.labels]}).snapshot).toEqual(preview.snapshot);f.catalog.validate(snapshot);
});
test('chunked request bodies are bounded by original UTF8 bytes and malformed scalar JSON is rejected',async()=>{
 const streamed=(bytes:Uint8Array)=>new Request('http://localhost/chat',{method:'POST',body:new ReadableStream({start(controller){controller.enqueue(bytes.subarray(0,10000));controller.enqueue(bytes.subarray(10000));controller.close();}})});
 await expect(readChatCommand(streamed(new TextEncoder().encode(JSON.stringify({question:'漢'.repeat(7000)}))))).rejects.toThrow('invalid-command');await expect(readChatCommand(streamed(new Uint8Array([0xff])))).rejects.toThrow('invalid-command');const valid={question:'"\\漢'};expect(await readChatCommand(streamed(new TextEncoder().encode(JSON.stringify(valid))))).toEqual(valid);
});
