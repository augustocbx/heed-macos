import {createHash,randomUUID} from 'node:crypto';
import type {PortableCommit,PortableManifest,PortableMeeting,Session} from '@heed/shared';
import {portableHistory,portableNotesMetadata,portableSegment,portableText,validatePortableTranscript} from './portable-transcript';
export const MAX_ARTIFACT_BYTES=16_000_000;
export const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const HASH=/^[a-f0-9]{64}$/;
export const encode=(value:unknown)=>Buffer.from(JSON.stringify(value),'utf8');
export const sha256=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
export const revisionPath=(meetingId:string,revisionId:string)=>`meetings/${meetingId}/revisions/${revisionId}`;
function assert(condition:unknown,message='Invalid portable library artifact'):asserts condition {if(!condition)throw new Error(message);}
function record(value:unknown):asserts value is Record<string,any> {assert(value && typeof value==='object' && !Array.isArray(value));}
function keys(value:Record<string,any>,allowed:string[]){assert(Object.keys(value).every(key=>allowed.includes(key)),'Unsupported portable fields');}
const text=(value:unknown,max=MAX_ARTIFACT_BYTES)=>typeof value==='string' && Buffer.byteLength(value)<=max && !value.includes('\u0000');
const date=(value:unknown)=>typeof value==='string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
const strings=(value:unknown)=>Array.isArray(value)&&value.length<=10000&&value.every(item=>text(item,10000));
export function validateMeeting(value:unknown):PortableMeeting {
 record(value);keys(value,['schemaVersion','meetingId','title','createdAt','updatedAt','duration','language','transcript','segments','speakers','tags','aiNotes','summary','pinned','transcriptFinalized','transcriptionModel','liveModel','audio',...(value.schemaVersion===2?['transcriptHistory','notesMetadata','meetingMode','audioUnavailableReason']:[])]);
 assert([1,2].includes(value.schemaVersion) && UUID.test(value.meetingId) && value.transcriptFinalized===true);
 for(const key of ['title','language','transcript','aiNotes','summary'])assert(text(value[key],key==='title'?10000:key==='language'?100:MAX_ARTIFACT_BYTES));
 assert(date(value.createdAt) && (value.updatedAt===undefined||date(value.updatedAt)) && Number.isFinite(value.duration) && value.duration>=0 && typeof value.pinned==='boolean');
 assert(strings(value.speakers) && strings(value.tags));
 for(const key of ['transcriptionModel','liveModel'])assert(value[key]===undefined || text(value[key],10000));
 assert(Array.isArray(value.segments) && value.segments.length<=100000);
 for(const segment of value.segments){record(segment);keys(segment,['speaker','text','start','end','channel','overlap',...(value.schemaVersion===2?['auto','attribution']:[])]);assert(text(segment.speaker,10000)&&text(segment.text)&&Number.isFinite(segment.start)&&Number.isFinite(segment.end)&&segment.start>=0&&segment.end>=segment.start);assert(segment.channel===undefined||['mic','sys'].includes(segment.channel));assert(segment.overlap===undefined||typeof segment.overlap==='boolean');}
 if(value.schemaVersion===2){for(const key of ['title','language','transcript','aiNotes','summary','transcriptionModel','liveModel'])assert(value[key]===undefined||portableText(value[key]));assert(value.tags.every((tag:unknown)=>portableText(tag,10000)));validatePortableTranscript(value as Session,value.transcriptHistory,value.notesMetadata);}
 if(value.schemaVersion===2){
  assert(value.meetingMode===undefined || ['audio-transcript','transcript-only'].includes(value.meetingMode));
  assert(value.audioUnavailableReason===undefined || value.meetingMode==='transcript-only'&&value.audioUnavailableReason==='transcript-only');
  if(value.meetingMode==='transcript-only')assert(value.audio===undefined && value.audioUnavailableReason==='transcript-only','Transcript-only portable meetings cannot advertise audio');
 }
 if(value.audio!==undefined){record(value.audio);keys(value.audio,['sha256','bytes','format','mode','objectPath']);assert(HASH.test(value.audio.sha256)&&Number.isSafeInteger(value.audio.bytes)&&value.audio.bytes>0&&value.audio.bytes<=8_000_000_000_000&&value.audio.format==='wav'&&value.audio.mode==='archived'&&value.audio.objectPath===`objects/${value.audio.sha256}`);}
 assert(encode(value).length<=MAX_ARTIFACT_BYTES,'Portable transcript exceeds supported artifact size');return value as PortableMeeting;
}
export function portableMeeting(session:Session,meetingId:string,audio?:PortableMeeting['audio'],version?:1|2):PortableMeeting {
 const payload={schemaVersion:1,meetingId,title:session.title,createdAt:session.createdAt,updatedAt:session.updatedAt,duration:session.duration,language:session.language,transcript:session.transcript,
  segments:session.segments.map(({speaker,text,start,end,channel,overlap})=>({speaker,text,start,end,channel,overlap})),speakers:session.speakers,tags:session.tags,aiNotes:session.aiNotes,summary:session.summary,pinned:session.pinned,
  transcriptFinalized:session.transcriptFinalized,transcriptionModel:session.transcriptionModel,liveModel:session.liveModel,audio};
 const selected=version??(session.meetingMode||session.transcriptEditing||session.notesMetadata?2:1);
 if(selected===1)return validateMeeting(JSON.parse(JSON.stringify(payload)));
 return validateMeeting(JSON.parse(JSON.stringify({...payload,schemaVersion:2,meetingMode:session.meetingMode,audioUnavailableReason:session.meetingMode === "transcript-only"?"transcript-only":undefined,segments:session.segments.map(portableSegment),transcriptHistory:portableHistory(session.transcriptEditing),notesMetadata:session.aiNotes?.trim()?portableNotesMetadata(session,portableHistory(session.transcriptEditing),session.notesMetadata??{origin:'manual',sourceRevision:null,stale:true}):undefined})));
}
export function acceptedPortableHash(session:Session,payload:PortableMeeting):string{return sha256(encode(portableMeeting(session,payload.meetingId,payload.audio,payload.schemaVersion)));}
export function validateManifest(value:unknown):PortableManifest {
 record(value);keys(value,['schemaVersion','libraryId','meetingId','revisionId','parents','artifacts']);
 assert(value.schemaVersion===1 && [value.libraryId,value.meetingId,value.revisionId].every(id=>typeof id==='string'&&UUID.test(id)));
 assert(Array.isArray(value.parents)&&value.parents.length<=32&&new Set(value.parents).size===value.parents.length&&value.parents.every((id:unknown)=>typeof id==='string'&&UUID.test(id)&&id!==value.revisionId));
 assert(Array.isArray(value.artifacts)&&value.artifacts.length===1);const artifact=value.artifacts[0];record(artifact);keys(artifact,['path','bytes','sha256']);assert(artifact.path==='meeting.json'&&Number.isSafeInteger(artifact.bytes)&&artifact.bytes>0&&artifact.bytes<=MAX_ARTIFACT_BYTES&&HASH.test(artifact.sha256));return value as PortableManifest;
}
export function validateCommit(value:unknown):PortableCommit {
 record(value);keys(value,['schemaVersion','libraryId','meetingId','revisionId','deviceId','manifestPath','manifestHash']);
 assert(value.schemaVersion===1 && [value.libraryId,value.meetingId,value.revisionId,value.deviceId].every(id=>typeof id==='string'&&UUID.test(id)) && HASH.test(value.manifestHash));
 assert(value.manifestPath===`${revisionPath(value.meetingId,value.revisionId)}/manifest.json`);return value as PortableCommit;
}
export function validateBundle(markerInput:unknown,manifestInput:unknown,bytes:Uint8Array):PortableMeeting {
 const marker=validateCommit(markerInput),manifest=validateManifest(manifestInput);assert(['libraryId','meetingId','revisionId'].every(key=>marker[key as keyof PortableCommit]===manifest[key as keyof PortableManifest]));
 assert(marker.manifestHash===sha256(encode(manifest)),'Manifest hash mismatch');const artifact=manifest.artifacts[0]!;assert(bytes.length===artifact.bytes&&sha256(bytes)===artifact.sha256,'Meeting integrity verification failed');const payload=validateMeeting(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));assert(payload.meetingId===manifest.meetingId);return payload;
}
export function makeBundle(libraryId:string,deviceId:string,payload:PortableMeeting,parents:string[],revisionId=randomUUID()) {
 const manifest=validateManifest({schemaVersion:1,libraryId,meetingId:payload.meetingId,revisionId,parents,artifacts:[{path:'meeting.json',bytes:encode(payload).length,sha256:sha256(encode(payload))}]});
 const marker=validateCommit({schemaVersion:1,libraryId,meetingId:payload.meetingId,revisionId,deviceId,manifestPath:`${revisionPath(payload.meetingId,revisionId)}/manifest.json`,manifestHash:sha256(encode(manifest))});return {payload,manifest,marker};
}
