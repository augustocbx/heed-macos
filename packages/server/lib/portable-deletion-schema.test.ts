import {test,expect} from 'bun:test';
import {randomUUID} from 'node:crypto';
import {validateDeletionRecord,validatePublicationIntent} from './portable-deletion-schema';
const key=()=>({libraryId:randomUUID(),meetingId:randomUUID(),revisionId:randomUUID()});
test('portable deletion controls reject broadened targets and private fields',()=>{
 const record={version:1,jobId:randomUUID(),destinationId:randomUUID(),revisions:[{...key(),manifestHash:'a'.repeat(64),parents:[]}],artifacts:[{path:`objects/${'a'.repeat(64)}`,bytes:1,sha256:'a'.repeat(64)}]};
 expect(validateDeletionRecord(record)).toEqual(record);
 for(const patch of [{token:'secret'},{artifacts:[{...record.artifacts[0],path:'objects/../private'}]},{revisions:[record.revisions[0],record.revisions[0]]},{artifacts:[{...record.artifacts[0],bytes:Infinity}]}])expect(()=>validateDeletionRecord({...record,...patch})).toThrow();
});
test('pending references are bound to content address and exact revision',()=>{
 const intent={version:1,id:randomUUID(),deviceId:randomUUID(),revision:key(),audio:{path:`objects/${'b'.repeat(64)}`,bytes:123,sha256:'b'.repeat(64)}};
 expect(validatePublicationIntent(intent)).toEqual(intent);
 for(const patch of [{audio:{...intent.audio,path:`objects/${'c'.repeat(64)}`}},{revision:{...intent.revision,absolutePath:'/private'}},{version:2}])expect(()=>validatePublicationIntent({...intent,...patch})).toThrow();
});
