import { expect, test } from "bun:test";
import type { Session } from "../../shared/types/session";
import { sourceRevision } from "../../shared/lib/transcript-source";
import { applyTextCommand } from "./transcript-editing";
import { portableMeeting, validateMeeting, encode, sha256 } from "./portable-schema";
import { preparePortableTranscript, sessionFromPortable } from "./portable-transcript";
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SessionTags,transcriptGuard} from './session-tags';
import {AutomaticNotesService} from './automatic-notes';

const now = "2026-10-06T12:00:00.000Z", meetingId = "10000000-0000-4000-8000-000000000001";
function meeting(): Session { return { id: "local", title: "Olá", createdAt: now, duration: 2, language: "pt", transcript: "Original", segments: [{ speaker: "Ana", text: "Original", start: 0, end: 2, channel: "mic", auto: false, attribution: "fallback" }], speakers: ["Ana"], tags: [], aiNotes: "Old notes", summary: "", pinned: false, transcriptFinalized: true, embeddings: { Ana: [1] }, files: { wav: "/private.wav" } }; }
function corrected() { const s = meeting(); return applyTextCommand(s, { expectedTranscriptRevision: sourceRevision(s), expectedTranscriptVersion: 0, requestId: "edit", action: "edit", target: { kind: "segment", index: 0 }, text: "Corrigido" }, now); }
test("explicit v1 keeps literal historic bytes and excludes correction/provenance fields", () => {
 const s = { ...meeting(), transcript: "Legacy: Original", segments: [{ ...meeting().segments[0]!, overlap: true }], notesMetadata: { origin: "manual" as const, sourceRevision: null, stale: true }, transcriptEditing: corrected().transcriptEditing };
 const literal = '{"schemaVersion":1,"meetingId":"10000000-0000-4000-8000-000000000001","title":"Olá","createdAt":"2026-10-06T12:00:00.000Z","duration":2,"language":"pt","transcript":"Legacy: Original","segments":[{"speaker":"Ana","text":"Original","start":0,"end":2,"channel":"mic","overlap":true}],"speakers":["Ana"],"tags":[],"aiNotes":"Old notes","summary":"","pinned":false,"transcriptFinalized":true}';
 expect(encode(portableMeeting(s, meetingId, undefined, 1)).toString()).toBe(literal);
 expect(sha256(encode(portableMeeting(s, meetingId, undefined, 1)))).toBe("f9b1b1259e80b1fec537d94624c7c91c33c7cca282cb9fffaf733239927bd663");
});
test("v2 roundtrip preserves original/edit/fallback provenance without transporting private local state", () => {
 const s = corrected(); s.transcriptVersion = 7; s.notesMetadata = { origin: "manual", sourceRevision: sourceRevision(s), stale: false };
 s.transcriptEditing!.candidates = [{ id: "candidate", createdAt: now, transcript: "Pending", segments: [], speakers: [], language: "pt", duration: 2, requestId: "stage", requestSignature: "signature", baseGuard: { expectedTranscriptRevision: sourceRevision(s), expectedTranscriptVersion: 7 } }];
 const payload = portableMeeting(s, meetingId); expect(payload.schemaVersion).toBe(2); const restored = sessionFromPortable(validateMeeting(JSON.parse(encode(payload).toString())), "imported");
 expect(restored.transcript).toBe("Corrigido"); expect(restored.transcriptEditing!.generations[0]!.transcript).toBe("Original"); expect(restored.transcriptEditing!.edits[0]!.changes[0]!.before).toBe("Original"); expect(restored.segments[0]!.attribution).toBe("fallback"); expect(restored.notesMetadata?.sourceRevision).toBe(sourceRevision(s));
 const raw = encode(payload).toString(); for (const field of ["/private", "embeddings", "transcriptVersion", "requestId", "requestSignature", "candidates", "notesJobs", "transcriptionDiagnostics"]) expect(raw).not.toContain(field);
 expect(restored.transcriptEditing!.candidates).toEqual([]); expect(restored.transcriptVersion).toBeUndefined();
});
test("v1 imported notes remain unknown and malformed v2 history/provenance reject", () => {
 const v1 = portableMeeting(meeting(), meetingId, undefined, 1); expect(sessionFromPortable(v1, "imported").notesMetadata).toMatchObject({ sourceRevision: null, stale: true });
 const v2 = portableMeeting(corrected(), meetingId, undefined, 2) as any;
 for (const bad of [{ ...v2, schemaVersion: 3 }, { ...v2, notesMetadata: { origin: "manual", sourceRevision: "f".repeat(64), stale: false } }, { ...v2, transcriptHistory: { ...v2.transcriptHistory, activeGenerationId: "missing" } }, { ...v2, transcriptHistory: { ...v2.transcriptHistory, generations: [...v2.transcriptHistory.generations, v2.transcriptHistory.generations[0]] } }, { ...v2, transcriptHistory: { ...v2.transcriptHistory, edits: [{ ...v2.transcriptHistory.edits[0], generationId: "missing" }] } }]) expect(() => validateMeeting(bad)).toThrow();
});
test("accepted history merge preserves local request receipts and rejects semantic ID collisions", () => {
 const local = corrected(); local.transcriptVersion = 3; const incoming = sessionFromPortable(portableMeeting(local, meetingId), "imported");
 const merged = preparePortableTranscript(local, incoming, now); expect(merged.id).toBe("local"); expect(merged.transcriptEditing!.edits[0]!.requestId).toBe("edit"); expect(merged.transcriptVersion).toBe(3);
 incoming.transcriptEditing!.generations[0]!.transcript = "Collision"; expect(() => preparePortableTranscript(local, incoming, now)).toThrow();
});
test("history-only accepted import advances the local version once through the source boundary", () => {
 const dir=mkdtempSync(join(tmpdir(),'heed-portable-history-only-'));
 try{const store=new SessionTags(dir),notes=new AutomaticNotesService({sessionsDir:dir,sessionStore:store,getSettings:()=>({enabled:false,templateId:'none',model:null,language:'meeting'}),loadTemplate:()=>undefined,generate:async()=>'',isBusy:()=>false});const initial=notes.create(meeting());
 const current=notes.commitTranscript(initial.id,{...transcriptGuard(initial),requestId:'edit',action:'edit',target:{kind:'segment',index:0},text:'Corrigido'});
 const incoming=structuredClone(current);incoming.transcriptEditing!.generations.push({...incoming.transcriptEditing!.generations[0]!,id:'remote-generation'});
 const accepted=notes.replaceAccepted(current.id,transcriptGuard(current),latest=>preparePortableTranscript(latest,incoming,now));
 expect(accepted.transcriptRevision).toBe(current.transcriptRevision);expect(accepted.transcriptVersion).toBe(current.transcriptVersion!+1);expect(accepted.transcriptEditing!.generations).toHaveLength(2);
 expect(notes.replaceAccepted(accepted.id,transcriptGuard(accepted),latest=>preparePortableTranscript(latest,incoming,now)).transcriptVersion).toBe(accepted.transcriptVersion);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('historical recorded notes hash survives legitimate speaker rename without claiming current provenance',()=>{
 const s=corrected(),originalHash=s.transcriptEditing!.edits[0]!.beforeRevision;s.speakers=['Renamed speaker'];s.segments=s.segments.map(segment=>({...segment,speaker:'Renamed speaker'}));s.notesMetadata={origin:'automatic',sourceRevision:originalHash,stale:true};
 const payload=portableMeeting(s,meetingId,undefined,2);expect(sessionFromPortable(validateMeeting(payload),'imported').notesMetadata).toEqual(s.notesMetadata);expect(s.notesMetadata.sourceRevision).not.toBe(sourceRevision(s));
 expect(()=>validateMeeting({...payload,notesMetadata:{...s.notesMetadata,sourceRevision:'f'.repeat(64)}})).toThrow('provenance');
});
test('malformed portable targets, scalars, private fields and aggregate history size reject before preparation',()=>{
 const valid=portableMeeting(corrected(),meetingId,undefined,2) as any;
 for(const change of [
  (v:any)=>v.transcriptHistory.edits[0].changes[0].target.index=99,
  (v:any)=>v.transcriptHistory.edits[0].changes.push(v.transcriptHistory.edits[0].changes[0]),
  (v:any)=>v.transcriptHistory.edits[0].requestId='private-request',
  (v:any)=>v.transcriptHistory.generations[0].transcriptionDiagnostics={},
  (v:any)=>v.transcriptHistory.generations[0].transcript='\ud800',
  (v:any)=>v.transcriptHistory.generations[0].segments[0].end=NaN,
  (v:any)=>v.transcriptHistory.generations[0].transcript='x'.repeat(16_000_000),
 ]){const malformed=structuredClone(valid);change(malformed);expect(()=>validateMeeting(malformed)).toThrow();}
});
test('private recognition evidence survives applicable metadata import and clears on a new recognition identity',()=>{
 const current=corrected();current.transcriptVersion=3;current.embeddings={Ana:[1]};const unchanged=sessionFromPortable(portableMeeting(current,meetingId),'other');unchanged.title='Metadata';const kept=preparePortableTranscript(current,unchanged,now);expect(kept.embeddings).toEqual(current.embeddings);
 unchanged.transcriptEditing!.generations.push({...unchanged.transcriptEditing!.generations[0]!,id:'new-recognition',origin:'recognition'});unchanged.transcriptEditing!.activeGenerationId='new-recognition';expect(preparePortableTranscript(current,unchanged,now).embeddings).toBeUndefined();
 const legacy=sessionFromPortable(portableMeeting(current,meetingId,undefined,1),'other');const old=preparePortableTranscript(current,legacy,now);expect(old.segments[0]).toMatchObject({auto:false,attribution:'fallback'});expect(old.transcriptEditing!.edits[0]!.requestId).toBe('edit');
});
test('aggregate bound counts portable history once and accepts a valid artifact above eight megabytes',()=>{
 const s=meeting();s.transcript='Document';s.segments=[];s.speakers=[];s.aiNotes='';s.transcriptEditing={schemaVersion:1,activeGenerationId:'large-original',generations:[{id:'large-original',createdAt:now,origin:'legacy-preserved',transcript:'x'.repeat(8_100_000),segments:[],speakers:[],language:'pt',duration:2}],edits:[],candidates:[],candidateRequestReceipts:[]};
 const payload=portableMeeting(s,meetingId);expect(encode(payload).length).toBeGreaterThan(8_100_000);expect(encode(payload).length).toBeLessThan(16_000_000);expect(validateMeeting(payload)).toBe(payload);
});
