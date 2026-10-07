import {expect,test} from 'bun:test';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {LocalVocabulary} from './vocabulary';
import {RecordingCoordinator} from './recording-coordinator';
import {portableMeeting} from './portable-schema';
import {transcriptRecoveryState} from './transcript-editing';
import {vocabularyConfiguration} from '../../shared/lib/vocabulary';
import {vocabularyHttp} from './vocabulary-http';

test('frozen capture vocabulary survives restart and final save without leaking into portable history',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'heed-vocab-provenance-'));try{
 const library=new LocalVocabulary(join(dir,'vocabulary.json'));library.save({schemaVersion:1,defaultGlossaryId:'work',glossaries:[{id:'work',name:'Work',entries:[{term:'Secret client João'}]}]},0);
 const path=join(dir,'capture.wav');writeFileSync(path,'retained fixture');const snapshot=library.snapshot();const run={schemaVersion:1 as const,snapshot,configuration:vocabularyConfiguration(snapshot,'mlx','base','pt')};let saved:any;
 const adapter={start:async()=>({path}),stop:async()=>{throw Error('interrupt')},finalize:async()=>({path,duration:1,language:'pt' as const,model:'base',turns:[{speaker:'Speaker 1',text:'ordinary transcript',start:0,end:1}],vocabularyRun:run}),save:(session:any)=>{saved={...session,id:'meeting'};return saved;}};
 const first=new RecordingCoordinator({manifestPath:join(dir,'manifest.json'),adapter,resolveVocabulary:()=>library.snapshot()});await first.start('start');first.recordVocabularyRun(run);
 library.save({...library.read(),glossaries:[] ,defaultGlossaryId:null},1);
 const resumed=new RecordingCoordinator({manifestPath:join(dir,'manifest.json'),adapter});expect(resumed.snapshot().vocabulary).toEqual(snapshot);await resumed.retry('retry',resumed.snapshot().meetingId!);
 expect(saved.vocabularyRun).toEqual(run);expect(saved.liveVocabularyRuns).toEqual([run]);saved.transcriptEditing=transcriptRecoveryState(saved,'2026-10-07T00:00:00Z');
 const portable=portableMeeting(saved,'00000000-0000-4000-8000-000000000001');expect(JSON.stringify(portable)).not.toContain('Secret client João');expect(JSON.stringify(portable)).not.toContain('vocabularyRun');
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('HTTP roundtrip validates snapshots, rejects stale writes and malformed imports',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'heed-vocab-http-'));try{const store=new LocalVocabulary(join(dir,'vocabulary.json'));const post=(path:string,body:unknown)=>vocabularyHttp(new Request('http://localhost/api/vocabulary'+path,{method:'POST',body:JSON.stringify(body)}),store);
 const library={schemaVersion:1,defaultGlossaryId:'work',glossaries:[{id:'work',name:'Work',entries:[{term:'João'}]}]};expect((await post('',{library,expectedVersion:0})).status).toBe(200);expect((await post('',{library,expectedVersion:0})).status).toBe(409);
 expect((await post('/snapshot',{glossaryId:'missing'})).status).toBe(400);expect((await post('',{importText:'{',expectedVersion:1})).status).toBe(400);
 const exported=await vocabularyHttp(new Request('http://localhost/api/vocabulary/export'),store);expect(JSON.parse(await exported.text()).glossaries[0].entries).toEqual([{term:'João'}]);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('actual session service and recognition baseline preserve private vocabulary config locally',()=>{
 const dir=mkdtempSync(join(tmpdir(),'heed-vocab-session-'));try{
 const snapshot={schemaVersion:1 as const,libraryVersion:4,glossaryId:'work',glossaryVersion:2,entries:[{term:'João'}],additions:[]};const run={schemaVersion:1 as const,snapshot,configuration:vocabularyConfiguration(snapshot,'mlx','small','pt')};
 const notes=new AutomaticNotesService({sessionsDir:dir,getSettings:()=>({enabled:false,model:null,templateId:"general",language:'meeting'}),loadTemplate:()=>undefined,isBusy:()=>false,generate:async()=>''});
 const original=notes.create({title:'Existing',transcriptFinalized:true,duration:1,language:'pt',transcriptionModel:'small',transcript:'Ordinary speech.',segments:[{speaker:'Ana',start:0,end:1,text:'Ordinary speech.'}],speakers:['Ana'],aiNotes:'Original notes',vocabularyRun:run,liveVocabularyRuns:[run]});
 expect(notes.get(original.id)?.vocabularyRun).toEqual(run);expect(transcriptRecoveryState(original,'2026-10-07T00:00:00Z').generations[0]?.vocabularyRun).toEqual(run);
 const source=notes.get(original.id)!;const store=new LocalVocabulary(join(dir,'vocabulary.json'));store.save({schemaVersion:1,defaultGlossaryId:null,glossaries:[{id:'fresh',name:'Fresh',entries:[{term:'New term'}]}]},0);
 expect(notes.get(original.id)).toEqual(source);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
import {AutomaticNotesService} from './automatic-notes';


test('successive captures isolate live vocabulary and record actual native unsupported configuration',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'heed-vocab-two-meetings-'));try{
 const path=join(dir,'capture.wav');writeFileSync(path,'fixture');let enabled=true;const saved:any[]=[];
 const firstSnapshot={schemaVersion:1 as const,libraryVersion:1,glossaryId:null,glossaryVersion:null,entries:[],additions:[{term:'Private A'}]};
 const empty={...firstSnapshot,additions:[]};
 const nativeRun={schemaVersion:1 as const,snapshot:firstSnapshot,configuration:vocabularyConfiguration(firstSnapshot,'parakeet','parakeet-v3','pt')};
 const finalRun={schemaVersion:1 as const,snapshot:firstSnapshot,configuration:vocabularyConfiguration(firstSnapshot,'mlx','base','pt')};
 const adapter={start:async()=>({path}),stop:async()=>({path,duration:1,language:'pt' as const,model:'base',turns:[],vocabularyRun:saved.length?undefined:finalRun}),finalize:async()=>{throw Error('unused');},save:(session:any)=>{saved.push(session);return session;}};
 const coordinator=new RecordingCoordinator({manifestPath:join(dir,'manifest.json'),adapter,realTimeTranscription:()=>enabled,resolveVocabulary:selection=>selection?.additions?.length?firstSnapshot:empty});
 await coordinator.start('start-A','both',{additions:firstSnapshot.additions});coordinator.recordVocabularyRun(nativeRun);await coordinator.stop('stop-A',coordinator.snapshot().meetingId!);
 expect(saved[0].liveVocabularyRuns).toEqual([nativeRun]);expect(saved[0].vocabularyRun.configuration.engine).toBe('mlx');
 enabled=false;await coordinator.start('start-B');expect(coordinator.snapshot().liveVocabularyRuns).toBeUndefined();await coordinator.stop('stop-B',coordinator.snapshot().meetingId!);
 expect(saved[1].liveVocabularyRuns).toBeUndefined();expect(JSON.stringify(saved[1])).not.toContain('Private A');
 }finally{rmSync(dir,{recursive:true,force:true});}
});
