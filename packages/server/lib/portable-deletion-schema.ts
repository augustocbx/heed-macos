import type {ArtifactIdentity,DeletionRecord,PublicationIntent,RevisionKey,RevisionDescriptor,RevisionDeletionFence} from '@heed/shared';
import {UUID,revisionPath,encode} from './portable-schema';
const HASH=/^[a-f0-9]{64}$/;
function check(value:unknown):asserts value {if(!value)throw new Error('Invalid remote deletion control');}
function object(value:any,keys:string[]){check(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(key=>keys.includes(key)));}
export const revisionKey=(r:RevisionKey)=>`${r.libraryId}/${r.meetingId}/${r.revisionId}`;
export function validateRevisionKey(value:any):RevisionKey {object(value,['libraryId','meetingId','revisionId']);check([value.libraryId,value.meetingId,value.revisionId].every(id=>typeof id==='string'&&UUID.test(id)));return value;}
export function validateRevisionDescriptor(value:any):RevisionDescriptor {object(value,['libraryId','meetingId','revisionId','manifestHash','parents']);validateRevisionKey({libraryId:value.libraryId,meetingId:value.meetingId,revisionId:value.revisionId});check(HASH.test(value.manifestHash)&&Array.isArray(value.parents)&&value.parents.length<=32&&new Set(value.parents).size===value.parents.length&&value.parents.every((id:any)=>typeof id==='string'&&UUID.test(id)&&id!==value.revisionId));return value;}
export function validateArtifactIdentity(value:any):ArtifactIdentity {
 object(value,['path','bytes','sha256']);check(typeof value.path==='string'&&value.path.length<=512&&HASH.test(value.sha256)&&Number.isSafeInteger(value.bytes)&&value.bytes>0&&value.bytes<=8_000_000_000_000);
 const parts=value.path.split('/');check(parts.every((p:string)=>p!=='.'&&p!=='..'&&p.length));
 const valid=parts[0]==='objects'?parts.length===2&&parts[1]===value.sha256:parts[0]==='commits'?parts.length===3&&UUID.test(parts[1])&&parts[2].endsWith('.json')&&UUID.test(parts[2].slice(0,-5)):parts[0]==='meetings'&&parts.length===5&&UUID.test(parts[1])&&parts[2]==='revisions'&&UUID.test(parts[3])&&['meeting.json','manifest.json'].includes(parts[4]);check(valid);return value;
}
export function validateDeletionRecord(value:any):DeletionRecord {
 object(value,['version','jobId','destinationId','revisions','artifacts']);check(value.version===1&&UUID.test(value.jobId)&&UUID.test(value.destinationId)&&Array.isArray(value.revisions)&&value.revisions.length>0&&value.revisions.length<=1000&&Array.isArray(value.artifacts)&&value.artifacts.length>0&&value.artifacts.length<=10000&&encode(value).length<=2_000_000);
 value.revisions.forEach(validateRevisionDescriptor);value.artifacts.forEach(validateArtifactIdentity);
 for(const artifact of value.artifacts as ArtifactIdentity[]){if(artifact.path.startsWith('meetings/')){check(value.revisions.some((revision:RevisionDescriptor)=>artifact.path.startsWith(`${revisionPath(revision.meetingId,revision.revisionId)}/`)&&(!artifact.path.endsWith('/manifest.json')||artifact.sha256===revision.manifestHash)));}else if(artifact.path.startsWith('commits/')){check(value.revisions.some((revision:RevisionDescriptor)=>artifact.path.endsWith(`/${revision.revisionId}.json`)));}}
 check(new Set(value.revisions.map(revisionKey)).size===value.revisions.length&&new Set(value.artifacts.map((a:ArtifactIdentity)=>a.path)).size===value.artifacts.length);return value;
}
export function validatePublicationIntent(value:any):PublicationIntent {object(value,['version','id','deviceId','revision','audio']);check(value.version===1&&UUID.test(value.id)&&UUID.test(value.deviceId));validateRevisionKey(value.revision);if(value.audio!==undefined){validateArtifactIdentity(value.audio);check(value.audio.path===`objects/${value.audio.sha256}`);}return value;}
export function validateRevisionFence(value:any):RevisionDeletionFence {object(value,['kind','version','jobId','destinationId','revision','artifact']);check(value.kind==='heed-deleted-revision'&&value.version===1&&UUID.test(value.jobId)&&UUID.test(value.destinationId));validateRevisionDescriptor(value.revision);validateArtifactIdentity(value.artifact);check(value.artifact.path===`${revisionPath(value.revision.meetingId,value.revision.revisionId)}/manifest.json`&&value.artifact.sha256===value.revision.manifestHash);return value;}
/** Control equality ignores serialization order while preserving every exact value. */
export function canonicalControl(value:unknown):string {if(Array.isArray(value))return `[${value.map(canonicalControl).join(',')}]`;if(value&&typeof value==='object')return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonicalControl((value as Record<string,unknown>)[key])}`).join(',')}}`;return JSON.stringify(value);}

/** Equality without job identity grants no authority; callers must also validate both exact intents. */
export function equivalentRevisionFence(a:RevisionDeletionFence,b:RevisionDeletionFence):boolean {return a.destinationId===b.destinationId&&canonicalControl(a.revision)===canonicalControl(b.revision)&&canonicalControl(a.artifact)===canonicalControl(b.artifact);}
