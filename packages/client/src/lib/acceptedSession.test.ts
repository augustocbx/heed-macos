import {expect,test} from 'vitest';
import type {Session} from '@heed/shared';
import {guardForSession,mergeAcceptedSession} from './acceptedSession';
const meeting=(version=1):Session=>({id:'s',title:'Meeting',createdAt:'2026-10-06T12:00:00Z',duration:1,language:'en',transcript:'Current',segments:[],speakers:[],tags:[],pinned:false,aiNotes:'Current notes',summary:'',transcriptVersion:version,transcriptRevision:'a'.repeat(64),notesMetadata:{origin:'manual',sourceRevision:'a'.repeat(64),stale:true}});
test('guards use authoritative displayed hash and local version, including normalized legacy zero',()=>{
 expect(guardForSession(meeting(4))).toEqual({expectedTranscriptRevision:'a'.repeat(64),expectedTranscriptVersion:4});expect(guardForSession({...meeting(),transcriptVersion:undefined}).expectedTranscriptVersion).toBe(0);
 for(const invalid of [{...meeting(),transcriptRevision:undefined},{...meeting(),transcriptRevision:''},{...meeting(),transcriptVersion:-1},{...meeting(),transcriptVersion:NaN}])expect(()=>guardForSession(invalid)).toThrow();
});
test('lower-version source and notes cannot restore old recognition/history or claim freshness',()=>{
 const current=meeting(4);current.transcriptEditing={schemaVersion:1,activeGenerationId:'g',generations:[],edits:[],candidates:[],candidateRequestReceipts:[]};const incoming={...meeting(3),title:'Independent title',transcript:'Old text',transcriptRevision:'b'.repeat(64),aiNotes:'Old completion',notesMetadata:{origin:'automatic' as const,sourceRevision:'b'.repeat(64),stale:false},transcriptEditing:undefined};const merged=mergeAcceptedSession(current,incoming);
 expect(merged).toMatchObject({title:'Independent title',transcript:'Current',transcriptVersion:4,transcriptRevision:current.transcriptRevision,aiNotes:'Current notes',notesMetadata:{stale:true}});expect(merged.transcriptEditing).toBe(current.transcriptEditing);
});
test('higher accepted version becomes authoritative, while equal-version history is mergeable by the request owner',()=>{
 const current=meeting(),newer={...meeting(2),transcript:'Confirmed correction',transcriptRevision:'b'.repeat(64)};expect(mergeAcceptedSession(current,newer)).toEqual(newer);expect(mergeAcceptedSession(newer,newer)).toEqual(newer);
});
