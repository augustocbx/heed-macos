import {describe,test,expect} from 'bun:test';
import {randomUUID} from 'node:crypto';
import {portableMeeting,validateBundle,encode,sha256,makeBundle} from './portable-schema';
import type {Session} from '@heed/shared';
const session=()=>({id:'session-legacy',title:'Planning',createdAt:'2026-01-01T00:00:00.000Z',duration:12,language:'pt',transcript:'Ana: entregar revisão',speakers:['Ana'],segments:[{speaker:'Ana',start:0,end:12,text:'entregar revisão',channel:'mic'}],aiNotes:'Notes',summary:'Summary',tags:['Product'],pinned:true,transcriptFinalized:true,transcriptionModel:'local-model',liveModel:'live',embeddings:{Ana:[1]},files:{wav:'/private/audio.wav'},notesJobs:{secret:'token'}} as unknown as Session);
describe('portable schema',()=>{
 test('round trip retains explicit meeting fields and excludes device/private data',()=>{
  const payload=portableMeeting(session(),randomUUID());const bundle=makeBundle(randomUUID(),randomUUID(),payload,[]);
  expect(validateBundle(bundle.marker,bundle.manifest,encode(payload))).toEqual(payload);
  const raw=JSON.stringify(bundle);expect(raw).not.toContain('/private');expect(raw).not.toContain('embeddings');expect(raw).not.toContain('secret');
  expect(payload.tags).toEqual(['Product']);expect(payload.segments[0]?.speaker).toBe('Ana');expect(payload.transcriptionModel).toBe('local-model');
 });
 test('rejects unknown schemas, path traversal, corrupt hashes, conflicting identities and unsupported secret fields',()=>{
  const payload=portableMeeting(session(),randomUUID());const bundle=makeBundle(randomUUID(),randomUUID(),payload,[]);const bytes=encode(payload);
  for(const change of [{schemaVersion:2},{artifacts:[{path:'../meeting.json',bytes:bytes.length,sha256:sha256(bytes)}]},{meetingId:randomUUID()},{parents:[bundle.manifest.revisionId]}]) {
   const manifest={...bundle.manifest,...change};const marker={...bundle.marker,manifestHash:sha256(encode(manifest))};expect(()=>validateBundle(marker,manifest,bytes)).toThrow();
  }
  expect(()=>validateBundle(bundle.marker,bundle.manifest,encode({...payload,title:'corrupt'}))).toThrow();
  const altered={...payload,files:{wav:'/etc/passwd'}};const manifest={...bundle.manifest,artifacts:[{path:'meeting.json',bytes:encode(altered).length,sha256:sha256(encode(altered))}]};
  expect(()=>validateBundle({...bundle.marker,manifestHash:sha256(encode(manifest))},manifest,encode(altered))).toThrow();
 });
 test('enforces bounded segments, finite timing and finalized transcripts',()=>{
  expect(()=>portableMeeting({...session(),transcriptFinalized:false},randomUUID())).toThrow();
  expect(()=>portableMeeting({...session(),segments:[{speaker:'Ana',text:'x',start:0,end:Infinity}]},randomUUID())).toThrow();
 });
});
test('portable archival intent survives without device-local paths or cleanup receipts and cannot advertise audio',()=>{const source={...session(),meetingMode:'transcript-only' as const,audioUnavailableReason:'transcript-only' as const,audioCleanup:{status:'pending' as const,requestedAt:'2026-10-07'}};const payload=portableMeeting(source,randomUUID());expect(payload.schemaVersion).toBe(2);expect(payload).toMatchObject({meetingMode:'transcript-only',audioUnavailableReason:'transcript-only'});expect(JSON.stringify(payload)).not.toContain('audioCleanup');expect(JSON.stringify(payload)).not.toContain('/private');const audio={sha256:'a'.repeat(64),bytes:44,format:'wav' as const,mode:'archived' as const,objectPath:`objects/${'a'.repeat(64)}`};expect(()=>portableMeeting(source,randomUUID(),audio)).toThrow();});
