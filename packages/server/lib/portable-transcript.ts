import { isDeepStrictEqual } from "node:util";
import {createHash} from 'node:crypto';
import type { Session, PortableMeeting, PortableTranscriptHistory, NotesMetadata, Segment } from "@heed/shared";
import type { RecognitionGeneration, TranscriptEdit, TranscriptSourceIdentity } from "../../shared/types/transcript-editing";
import { sourceRevision, transcriptSourceIdentity } from "../../shared/lib/transcript-source";
import { renderAcceptedTranscript, transcriptRecoveryState } from "./transcript-editing";
import {acceptedSourceChanged,speakerOnly} from './session-tags';

const maxBytes = 16_000_000, hash = /^[a-f0-9]{64}$/;
function fail(message = "Invalid portable transcript history"): never { throw new Error(message); }
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
function fields(value: unknown, allowed: string[]): asserts value is Record<string, any> { if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) fail(); }
export function portableText(value: unknown, max = maxBytes): value is string {
 if (typeof value !== "string" || Buffer.byteLength(value) > max || value.includes("\0")) return false;
 for (let i=0;i<value.length;i++) {const code=value.charCodeAt(i);if(code>=0xd800&&code<=0xdbff){const next=value.charCodeAt(++i);if(!(next>=0xdc00&&next<=0xdfff))return false;}else if(code>=0xdc00&&code<=0xdfff)return false;}
 return true;
}
const date = (value: unknown) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
const id = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(value);
export function portableSegment({speaker,text,start,end,channel,overlap,auto,attribution}: Segment): Segment { return {speaker,text,start,end,...(channel!==undefined?{channel}:{}),...(overlap!==undefined?{overlap}:{}),...(auto!==undefined?{auto}:{}),...(attribution!==undefined?{attribution}:{})}; }
function segments(value: unknown): asserts value is Segment[] {
 if (!Array.isArray(value)||value.length>100000) fail();
 for (const segment of value) {fields(segment,["speaker","text","start","end","channel","overlap","auto","attribution"]);if(!portableText(segment.speaker,10000)||!portableText(segment.text)||!Number.isFinite(segment.start)||!Number.isFinite(segment.end)||segment.start<0||segment.end<segment.start||(segment.channel!==undefined&&!['mic','sys'].includes(segment.channel))||(segment.overlap!==undefined&&typeof segment.overlap!=="boolean")||(segment.auto!==undefined&&typeof segment.auto!=="boolean")||(segment.attribution!==undefined&&segment.attribution!=="fallback"))fail();}
}
const strings = (value: unknown): value is string[] => Array.isArray(value)&&value.length<=10000&&value.every(item=>portableText(item,10000))&&new Set(value).size===value.length;
export function portableHistory(state: Session['transcriptEditing']): PortableTranscriptHistory | undefined {
 if (!state) return;
 return {schemaVersion:1,activeGenerationId:state.activeGenerationId,generations:state.generations.map(({transcriptionDiagnostics,...g})=>({...g,segments:g.segments.map(portableSegment)})),edits:state.edits.map(({requestId,requestSignature,...edit})=>edit)};
}
type SourceState = Pick<Session,'transcript'|'segments'|'speakers'|'language'>;
interface ReplayNode {base:SourceState;parent?:ReplayNode;changes?:TranscriptEdit['changes'];sourceIdentity?:TranscriptSourceIdentity}
/** History holds compact parent/change references; materialize only the state being checked. */
function materialize(node:ReplayNode):SourceState {
 const chain:ReplayNode[]=[];for(let cursor:ReplayNode|undefined=node;cursor;cursor=cursor.parent)chain.push(cursor);
 const state:SourceState={transcript:node.base.transcript,language:node.base.language,speakers:[...node.base.speakers],segments:node.base.segments.map(segment=>({...segment}))};
 for(const step of chain.reverse())if(step.changes){for(const c of step.changes){if(c.target.kind==='document')state.transcript=c.after;else state.segments[c.target.index]!.text=c.after;}if(state.segments.length)state.transcript=renderAcceptedTranscript(state.segments);}
 return node.sourceIdentity?withIdentity(state,node.sourceIdentity):state;
}
function identity(value: unknown): asserts value is TranscriptSourceIdentity {
 fields(value,['language','speakers','segments']);
 if(!portableText(value.language,100)||!strings(value.speakers)||!Array.isArray(value.segments)||value.segments.length>100000)fail('Invalid portable source identity');
 for(const segment of value.segments){fields(segment,['speaker','start','end','channel']);if(!portableText(segment.speaker,10000)||!value.speakers.includes(segment.speaker)||!Number.isFinite(segment.start)||!Number.isFinite(segment.end)||segment.start<0||segment.end<segment.start||(segment.channel!==undefined&&!['mic','sys'].includes(segment.channel)))fail('Invalid portable source identity');}
}
const topology=(a:TranscriptSourceIdentity,b:TranscriptSourceIdentity)=>a.language===b.language&&a.segments.length===b.segments.length&&a.segments.every((s,i)=>s.start===b.segments[i]!.start&&s.end===b.segments[i]!.end&&s.channel===b.segments[i]!.channel);
function withIdentity(text:SourceState,witness:TranscriptSourceIdentity):SourceState {
 return {transcript:text.transcript,language:witness.language,speakers:witness.speakers,segments:witness.segments.map((segment,i)=>({...segment,text:text.segments[i]!.text}))};
}
/** Only reconstructed states prove known provenance. Raw journal hashes remain recorded data. */
export function validatePortableTranscript(source: SourceState, history: unknown, metadata: unknown): Set<string> {
 if(!portableText(source.transcript)||!portableText(source.language,100))fail();
 segments(source.segments);if(!strings(source.speakers))fail();
 const revisions=new Set([sourceRevision(source)]),states:ReplayNode[]=[{base:source}];
 if(history!==undefined){
  fields(history,['schemaVersion','activeGenerationId','generations','edits']);
  if(history.schemaVersion!==1||!id(history.activeGenerationId)||!Array.isArray(history.generations)||!history.generations.length||!Array.isArray(history.edits))fail();
  const generations=new Map<string,RecognitionGeneration>(),replay=new Map<string,Map<string,ReplayNode>>();
  for(const g of history.generations){
   fields(g,['id','createdAt','origin','transcript','segments','speakers','language','transcriptionModel','duration']);
   if(!id(g.id)||generations.has(g.id)||!date(g.createdAt)||!['recognition','legacy-preserved'].includes(g.origin)||!portableText(g.transcript)||!strings(g.speakers)||!portableText(g.language,100)||!Number.isFinite(g.duration)||g.duration<0||(g.transcriptionModel!==undefined&&!portableText(g.transcriptionModel,10000)))fail();
   segments(g.segments);generations.set(g.id,g as RecognitionGeneration);const revision=sourceRevision(g as RecognitionGeneration);revisions.add(revision);const node={base:g as RecognitionGeneration};states.push(node);replay.set(g.id,new Map([[revision,node]]));
  }
  if(!generations.has(history.activeGenerationId))fail();
  const seen=new Set<string>();
  for(const edit of history.edits){
   fields(edit,['id','generationId','kind','changes','createdAt','beforeRevision','afterRevision','sourceIdentity']);const g=generations.get(edit.generationId);
   if(!id(edit.id)||seen.has(edit.id)||!g||!['edit','replace','revert'].includes(edit.kind)||!date(edit.createdAt)||typeof edit.beforeRevision!=='string'||!hash.test(edit.beforeRevision)||typeof edit.afterRevision!=='string'||!hash.test(edit.afterRevision)||!Array.isArray(edit.changes)||!edit.changes.length||edit.changes.length>1000)fail();
   seen.add(edit.id);const targets=new Set<string>();
   for(const change of edit.changes){
    fields(change,['target','before','after']);fields(change.target,['kind','index']);const t=change.target;
    if(!portableText(change.before)||!portableText(change.after)||!(t.kind==='document'&&!g.segments.length&&t.index===undefined||t.kind==='segment'&&Number.isSafeInteger(t.index)&&t.index>=0&&t.index<g.segments.length))fail();
    const key=t.kind==='document'?'document':`segment:${t.index}`;if(targets.has(key))fail();targets.add(key);
   }
   const original=transcriptSourceIdentity(g),current=transcriptSourceIdentity(source),witnesses=[original,...(topology(original,current)?[current]:[])];
   if(edit.sourceIdentity!==undefined){identity(edit.sourceIdentity);if(!topology(original,edit.sourceIdentity))fail('Invalid portable edit source identity');witnesses.splice(0,witnesses.length,edit.sourceIdentity);}
   const branches=replay.get(g.id)!;let verified=false,matchedText=false;const additions:Array<{hash:string;node:ReplayNode}>=[];
   const exact=branches.get(edit.beforeRevision),candidates=exact?[exact]:[...branches.values()];
   for(const node of candidates){
    const state=materialize(node);
    if(!edit.changes.every((c:any)=>(c.target.kind==='document'?state.transcript:state.segments[c.target.index]?.text)===c.before))continue;
    matchedText=true;
    for(const witness of !edit.sourceIdentity&&node.sourceIdentity?[node.sourceIdentity,...witnesses]:witnesses){
     const before=withIdentity(state,witness),beforeHash=sourceRevision(before);
     if(beforeHash!==edit.beforeRevision)continue;
     const after=structuredClone(before);for(const c of edit.changes){if(c.target.kind==='document')after.transcript=c.after;else after.segments[c.target.index].text=c.after;}
     if(after.segments.length)after.transcript=renderAcceptedTranscript(after.segments);
     const afterHash=sourceRevision(after);if(afterHash!==edit.afterRevision)fail('Invalid reconstructable portable edit hash');
     const beforeNode={base:node.base,parent:node,sourceIdentity:witness};revisions.add(beforeHash);revisions.add(afterHash);additions.push({hash:beforeHash,node:beforeNode},{hash:afterHash,node:{base:node.base,parent:beforeNode,changes:edit.changes,sourceIdentity:witness}});verified=true;
    }
   }
   if(edit.sourceIdentity!==undefined&&!verified)fail('Invalid portable edit source witness');
   if(!matchedText)fail('Invalid portable edit before text');
   // Old unwitnessed identities may be mathematically irrecoverable after a
   // rename. Keep their journal, but never treat the declared hashes as proof.
   if(!verified){for(const node of candidates){const state=materialize(node);if(edit.changes.every((c:any)=>(c.target.kind==='document'?state.transcript:state.segments[c.target.index]?.text)===c.before)){const afterNode={base:node.base,parent:node,changes:edit.changes,sourceIdentity:node.sourceIdentity};additions.push({hash:sourceRevision(materialize(afterNode)),node:afterNode});}}}
   // A full source hash already identifies the same replayable text and identity.
   // Retain its first node: edit/revert ABA must not deepen an identical state.
   for(const {hash,node} of additions)if(!branches.has(hash)){branches.set(hash,node);states.push(node);}
  }
 }
 if(metadata!==undefined){
  fields(metadata,['origin','sourceRevision','stale','unverifiedSourceRevision','sourceIdentity','templateId','templateName','templateHash','model','language','generatedAt']);
  if(!['manual','automatic'].includes(metadata.origin)||typeof metadata.stale!=='boolean')fail('Invalid portable notes provenance');
  if(metadata.sourceIdentity!==undefined){identity(metadata.sourceIdentity);if(metadata.sourceRevision===null)fail('Invalid portable notes source witness');const witnessed=states.some(node=>{const state=materialize(node);return topology(transcriptSourceIdentity(state),metadata.sourceIdentity)&&sourceRevision(withIdentity(state,metadata.sourceIdentity))===metadata.sourceRevision;});if(!witnessed)fail('Invalid portable notes source witness');revisions.add(metadata.sourceRevision);}
  if(!(metadata.sourceRevision===null||typeof metadata.sourceRevision==='string'&&hash.test(metadata.sourceRevision)&&revisions.has(metadata.sourceRevision)))fail('Invalid portable notes provenance');
  if(metadata.unverifiedSourceRevision!==undefined&&(metadata.sourceRevision!==null||metadata.stale!==true||metadata.sourceIdentity!==undefined||typeof metadata.unverifiedSourceRevision!=='string'||!hash.test(metadata.unverifiedSourceRevision)))fail('Invalid unverified portable notes provenance');
  for(const key of ['templateId','templateName','templateHash','model','language'])if(metadata[key]!==undefined&&!portableText(metadata[key],10000))fail();
  if(metadata.generatedAt!==undefined&&!date(metadata.generatedAt))fail();
  if((metadata.sourceRevision===null||metadata.sourceRevision!==sourceRevision(source))&&!metadata.stale)fail('Historical or unknown notes cannot be labeled current');
 }
 if(Buffer.byteLength(JSON.stringify({source:{transcript:source.transcript,segments:source.segments,speakers:source.speakers,language:source.language},history,metadata}))>maxBytes)fail('Portable transcript exceeds supported artifact size');
 return revisions;
}
/** Explicitly preserve an irrecoverable old recorded hash as unverified/unknown. */
export function portableNotesMetadata(source:SourceState,history:unknown,metadata:NotesMetadata):NotesMetadata {
 const verified=validatePortableTranscript(source,history,undefined);
 if(metadata.sourceRevision!==null&&!metadata.sourceIdentity&&!verified.has(metadata.sourceRevision)){const {sourceRevision,...rest}=metadata;return {...rest,sourceRevision:null,unverifiedSourceRevision:sourceRevision,stale:true};}
 return metadata;
}
export function sessionFromPortable(payload: PortableMeeting, localId: string): Session {
 const {schemaVersion,meetingId,audio,...raw}=payload;
 const {transcriptHistory,notesMetadata,...fields}=raw as typeof raw & {transcriptHistory?:PortableTranscriptHistory;notesMetadata?:NotesMetadata};
 return {...fields,id:localId,files:undefined,audioArchived:!!audio,...(transcriptHistory?{transcriptEditing:{...structuredClone(transcriptHistory),candidates:[],candidateRequestReceipts:[]}}:{}),...(fields.aiNotes.trim()?{notesMetadata:schemaVersion===2&&notesMetadata?structuredClone(notesMetadata):{origin:'manual',sourceRevision:null,stale:true}}:{})} as Session;
}
const semanticGeneration=(g:RecognitionGeneration)=>{const {transcriptionDiagnostics,...fields}=g;return {...fields,segments:g.segments.map(portableSegment)};};
const semanticEdit=(e:TranscriptEdit)=>{const {requestId,requestSignature,...fields}=e;return fields;};
function merge<T extends {id:string}>(local:T[],incoming:T[],projection:(value:T)=>unknown):T[]{const result=[...local],byId=new Map(local.map(value=>[value.id,value]));for(const item of incoming){const saved=byId.get(item.id);if(saved){if(!isDeepStrictEqual(projection(saved),projection(item)))fail('Portable transcript history ID collision');}else{result.push(item);byId.set(item.id,item);}}return result;}
/** Latest local identity/history/private state survives a validated accepted replacement. */
export function preparePortableTranscript(current: Session|null, incoming: Session, now: string): Session {
 const portable=portableHistory(incoming.transcriptEditing);validatePortableTranscript(incoming,portable,incoming.notesMetadata);
 let next={...current,...incoming,id:current?.id??incoming.id,createdAt:current?.createdAt??incoming.createdAt};
 delete next.transcriptVersion;delete next.transcriptRevision;
 if(current){next.transcriptVersion=current.transcriptVersion;next.notesJobs=structuredClone(current.notesJobs);}
 if(next.segments.length)next.transcript=renderAcceptedTranscript(next.segments);
 if(current){
  const recognized=incoming.transcriptEditing;
  const sameSource=sourceRevision(current)===sourceRevision(next);
  if(sameSource)next.segments=next.segments.map((segment,index)=>({...segment,
   ...(segment.auto===undefined&&current.segments[index]?.auto!==undefined?{auto:current.segments[index]!.auto}:{}),
   ...(segment.attribution===undefined&&current.segments[index]?.attribution!==undefined?{attribution:current.segments[index]!.attribution}:{})}));
  const prior=transcriptRecoveryState(current,now);
  const applicable=sameSource&&current.transcriptionModel===next.transcriptionModel&&current.duration===next.duration&&(!recognized||recognized.activeGenerationId===prior.activeGenerationId);
  next.embeddings=applicable?current.embeddings:undefined;
  next.transcriptionDiagnostics=applicable?current.transcriptionDiagnostics:undefined;
  if(current.transcriptEditing||recognized||acceptedSourceChanged(current,next)){
   next.transcriptEditing={...prior,
    generations:merge(prior.generations,recognized?.generations??[],semanticGeneration),
    edits:merge(prior.edits,recognized?.edits??[],semanticEdit),
    activeGenerationId:recognized?.activeGenerationId??prior.activeGenerationId};
   // Prepare the same recognition transition the central boundary would retain,
   // so its durable intent hashes the exact eventual accepted projection.
   if(!speakerOnly(current,next)&&next.transcriptEditing.activeGenerationId===prior.activeGenerationId&&isDeepStrictEqual(next.transcriptEditing.edits,prior.edits)){
    const {transcriptionDiagnostics,...g}=transcriptRecoveryState({...next,transcriptEditing:undefined},now).generations[0]!;
    const generation={...g,id:`generation-${createHash('sha256').update(JSON.stringify(semanticGeneration(g))).digest('hex')}`,origin:'recognition' as const};
    next.transcriptEditing={...next.transcriptEditing,generations:merge(next.transcriptEditing.generations,[generation],semanticGeneration),activeGenerationId:generation.id};
   }
  }
 }
 if(next.notesMetadata&&(next.notesMetadata.sourceRevision===null||next.notesMetadata.sourceRevision!==sourceRevision(next)))next.notesMetadata={...next.notesMetadata,stale:true};
 const accepted=portableHistory(next.transcriptEditing);validatePortableTranscript(next,accepted,next.notesMetadata);
 return next;
}
