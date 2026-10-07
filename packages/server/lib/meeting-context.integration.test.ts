import { afterEach, expect, test } from 'bun:test';
import { join } from 'node:path';
import { LibraryChatService } from './library-chat';
import { closeRetrievalFixtures, retrievalFixture } from './retrieval-test-utils';

afterEach(closeRetrievalFixtures);

test('latest named speaker answer cites the speaker segment and recorded meeting time within the selected label', async () => {
 const f = await retrievalFixture();
 const add = (id:string,tags:string[],recordedAt:string,speaker:string,quote:string) => {
  f.store.commitSource(id,null,()=>({id,title:id,createdAt:recordedAt,duration:1,language:'en',transcript:quote,segments:[{speaker,text:quote,start:0,end:1}],speakers:[speaker],tags,aiNotes:'',summary:'',pinned:false,transcriptFinalized:true}));
 };
 add('older',['Work'],'2026-10-01T11:00:00Z','Brunô','We approved the budget.');
 add('mention-only',['Work'],'2026-10-07T11:00:00Z','Ana','Bruno will receive the notes.');
 add('excluded',['Private'],'2026-10-08T11:00:00Z','Bruno','The launch is ready.');
 await f.index.tick();
 const scope={mode:'labels' as const,labels:['Work'],match:'any' as const};
 let suppliedIds:string[]=[];
 const chat=new LibraryChatService({directory:join(f.root,'chat'),getSession:id=>f.store.read(id),catalog:f.catalog,retriever:f.retriever,isBusy:()=>false,generate:async input=>{
  suppliedIds=[...input.metadata.map(m=>m.sessionId),...input.evidence.map(e=>e.sessionId)];
  const spoken=input.evidence.find(e=>e.speaker==='Brunô');
  const recorded=input.metadata.find(m=>m.sessionId===spoken?.sessionId);
  expect(spoken?.quote).toBe('We approved the budget.');
  expect(recorded?.recordedAt).toBe('2026-10-01T11:00:00.000Z');
  return JSON.stringify({claims:[{text:'The latest meeting with Brunô started on October 1, 2026 at 11:00 UTC.',evidenceIds:[spoken!.id,recorded!.id]}],notFound:false});
 }});
 const preview=chat.preview(scope);
 chat.command(scope,{action:'send',requestId:'speaker-date',question:'When was the latest meeting with Bruno?',model:'local',expectedSourceRevision:preview.snapshot.key});
 let turn=chat.get(scope).thread.turns[0]!;
 for(let i=0;i<100&&turn.status!=='completed'&&turn.status!=='failed';i++){await Bun.sleep(2);turn=chat.get(scope).thread.turns[0]!;}
 expect(turn.status).toBe('completed');
 expect(suppliedIds).not.toContain('excluded');
 expect(turn.answer?.claims).toEqual([{text:'The latest meeting with Brunô started on October 1, 2026 at 11:00 UTC.',citations:[expect.objectContaining({speaker:'Brunô',quote:'We approved the budget.'}),expect.objectContaining({kind:'meeting-metadata',sessionId:'older',recordedAt:'2026-10-01T11:00:00.000Z'})]}]);
});
