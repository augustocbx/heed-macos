import {expect,test} from 'bun:test';
import {makeBundle,sha256} from '../portable-schema';
import {comparePortableRevision,publicSynchronizationFixture} from './synchronization-integrity';

test.each(['en','pt'] as const)('public %s fixture preserves labels, manual names, corrections, notes and provenance',locale=>{
 const fixture=publicSynchronizationFixture(locale);
 expect(fixture.payload.language).toBe(locale);expect(fixture.payload.tags).toContain('Synchronization QA');
 expect(fixture.payload.speakers).toEqual(['Ana QA','Bruno QA']);
 expect(fixture.payload.transcript).toContain(locale==='en'?'Cobalt launch':'Lançamento Cobalto');
 expect(fixture.payload.aiNotes.length).toBeGreaterThan(0);expect(fixture.payload.summary.length).toBeGreaterThan(0);
 expect(fixture.payload.audio?.sha256).toBe(sha256(fixture.audio));
 expect(fixture.payload.transcriptionModel).toBe('public-qa-final');expect(fixture.payload.liveModel).toBe('public-qa-live');
 const actual={...structuredClone(fixture),audio:undefined};
 expect(comparePortableRevision(fixture,actual)).toEqual([]);
});

test('integrity comparator rejects changed portable metadata even when it remains a valid complete bundle',()=>{
 const expected=publicSynchronizationFixture('en');
 for(const [field,value] of Object.entries({tags:['Changed QA'],speakers:['Other QA'],transcript:'Changed correction',segments:[{speaker:'Other QA',text:'Changed',start:0,end:1}],aiNotes:'Changed notes',summary:'Changed summary',language:'pt',transcriptionModel:'changed-final',liveModel:'changed-live'})){
  const payload={...expected.payload,[field]:value};
  const actual={...makeBundle(expected.manifest.libraryId,expected.marker.deviceId,payload,expected.manifest.parents,expected.manifest.revisionId as Parameters<typeof makeBundle>[4]),audioSha256:expected.audioSha256};
  expect(comparePortableRevision(expected,actual)).toContain(`payload.${field}`);
 }
});

test('integrity comparator covers ancestry, stable identities, required artifacts and actual audio bytes',()=>{
 const expected=publicSynchronizationFixture('pt'),copy=structuredClone(expected);
 copy.manifest.parents=['e148492b-f9ad-4ab6-af1f-df246c92dfbc'];
 expect(comparePortableRevision(expected,copy)).toContain('manifest.parents');
 copy.payload.audio!.bytes++;expect(comparePortableRevision(expected,copy)).toContain('payload.audio');
 copy.audioSha256='0'.repeat(64);expect(comparePortableRevision(expected,copy)).toContain('audio.sha256');
 copy.payload.transcriptFinalized=false as true;
 expect(comparePortableRevision(expected,copy)).toContain('payload.invalid');
 expect(comparePortableRevision(expected,copy).join(' ')).not.toContain(expected.payload.transcript);
});
