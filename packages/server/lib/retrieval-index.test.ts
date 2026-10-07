import {afterEach,expect,test} from 'bun:test';
import {Database} from 'bun:sqlite';
import {mkdtempSync,mkdirSync,readFileSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SessionTags,transcriptGuard} from './session-tags';
import {RetrievalCatalog} from './retrieval-catalog';
import {createRetrievalPolicy} from './retrieval-policy';
import {ManagedQuota} from './managed-quota';
import {transcriptEvidence} from './meeting-chat';
const module=await import('./retrieval-index').catch(()=>null);
const fixtures:Array<{root:string;catalog:RetrievalCatalog;index:any}>=[];
afterEach(()=>{for(const f of fixtures.splice(0)){f.index?.close();f.catalog.close();rmSync(f.root,{recursive:true,force:true});}});
async function fixture(overrides:any={},limit=1_000_000_000){
 expect(module).not.toBeNull();
 const root=mkdtempSync(join(tmpdir(),'heed-retrieval-index-')),sessions=join(root,'sessions'),directory=join(root,'indexes');mkdirSync(sessions);mkdirSync(directory);
 const store=new SessionTags(sessions),policy=createRetrievalPolicy(overrides);let busy=false;
 const catalog=new RetrievalCatalog({store,policy,isBusy:()=>busy,now:()=>0});
 const quota=new ManagedQuota({ledgerPath:join(root,'quota.json'),roots:{text:[sessions],indexes:[directory]},getLimit:()=>limit,setLimit:()=>{},protectedPaths:()=>[]});
 const options={directory,catalog,store,quota,policy,isBusy:()=>busy,now:()=>0};
 const index=new module!.RetrievalIndex(options);const f={root,catalog,index};fixtures.push(f);
 const add=(id:string,transcript:string)=>store.commitSource(id,null,()=>({id,title:id,createdAt:'2026-10-07',duration:1,language:'en',transcript,segments:[],speakers:[],tags:[],aiNotes:'',summary:'',pinned:false,transcriptFinalized:true}));
 const snapshot=()=>catalog.resolve({kind:'library',scope:{mode:'all',labels:[],match:'any'}}).snapshot;
 const database=()=>new Database(join(directory,JSON.parse(readFileSync(join(directory,'active.json'),'utf8')).generationId,'index.sqlite'),{readonly:true});
 await catalog.reconcile();return {...f,store,policy,quota,options,add,snapshot,database,busy:(value:boolean)=>{busy=value;}};
}
test('real SQLite stores exact accepted evidence and direct postings under a private generation',async()=>{
 const f=await fixture(),s=f.add('meeting-a','Ação delivery\n\nSecond paragraph');await f.index.tick();
 const info=f.index.describe(f.snapshot());expect(info.generationId).toBeString();expect(info.sources[0]).toMatchObject({sessionId:s.id,sourceRevision:s.transcriptRevision,transcriptVersion:1,totalEvidence:2,indexedEvidence:2,indexedPrefix:2,current:true});
 const db=f.database();try{
  const rows=db.query('SELECT evidenceId,quote,evidenceOrdinal FROM chunks ORDER BY evidenceOrdinal').all() as any[];
  expect(rows.map(row=>[row.evidenceId,Buffer.from(row.quote).toString('utf16le')])).toEqual(transcriptEvidence(s).map(e=>[e.id,e.quote]));
  expect(db.query("SELECT frequency FROM postings WHERE term='acao'").get()).toEqual({frequency:1});
  expect(db.query('PRAGMA journal_mode').get()).toEqual({journal_mode:'delete'});
  expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);
 }finally{db.close();}
 expect(statSync(join(f.options.directory,info.generationId!)).mode&0o777).toBe(0o700);
 expect(statSync(join(f.options.directory,info.generationId!,'index.sqlite')).mode&0o777).toBe(0o600);
 expect(f.quota.snapshot().reservedBytes).toBe(0);
});
test('source replacement and deletion remove obsolete rows while metadata-only commits preserve the manifest epoch',async()=>{
 const f=await fixture(),s=f.add('meeting-a','Old unique');await f.index.tick();
 const before=f.index.describe(f.snapshot()).sources[0];f.store.save({...f.store.read(s.id)!,title:'Metadata only'});await f.index.tick();
 expect(f.index.describe(f.snapshot()).sources[0].epoch).toBe(before.epoch);
 const changed=f.store.commitSource(s.id,transcriptGuard(f.store.read(s.id)!),current=>({...current!,transcript:'New accepted'}));
 expect(f.index.describe(f.snapshot()).sources[0].current).toBe(false);await f.index.tick();
 expect(f.index.describe(f.snapshot()).sources[0]).toMatchObject({current:true,sourceRevision:changed.transcriptRevision,transcriptVersion:2});
 const db=f.database();try{expect(db.query("SELECT COUNT(*) AS n FROM postings WHERE term='old'").get()).toEqual({n:0});expect(db.query("SELECT COUNT(*) AS n FROM postings WHERE term='new'").get()).toEqual({n:1});}finally{db.close();}
 f.store.remove(s.id);await f.index.tick();const deleted=f.database();try{expect(deleted.query('SELECT COUNT(*) AS n FROM chunks').get()).toEqual({n:0});}finally{deleted.close();}
});
test('hash ABA and nonhash accepted changes replace manifests using the exact local version',async()=>{
 const f=await fixture(),s=f.add('meeting-a','Original');await f.index.tick();
 f.store.commitSource(s.id,transcriptGuard(s),current=>({...current!,transcript:'Temporary'}));
 f.store.commitSource(s.id,transcriptGuard(f.store.read(s.id)!),current=>({...current!,transcript:'Original'}));
 expect(f.index.describe(f.snapshot()).sources[0].current).toBe(false);await f.index.tick();
 expect(f.index.describe(f.snapshot()).sources[0]).toMatchObject({sourceRevision:s.transcriptRevision,transcriptVersion:3,current:true});
 f.store.commitSource(s.id,transcriptGuard(f.store.read(s.id)!),current=>({...current!,transcriptionModel:'replacement'}));await f.index.tick();
 expect(f.index.describe(f.snapshot()).sources[0]).toMatchObject({sourceRevision:s.transcriptRevision,transcriptVersion:4,current:true});
});
test('row and posting capacities commit truthful deterministic prefixes without silently truncating source counts',async()=>{
 const rows=await fixture({evidenceRows:1}),s=rows.add('meeting-a','First\n\nSecond');await rows.index.tick();
 expect(rows.index.describe(rows.snapshot()).sources[0]).toMatchObject({totalEvidence:2,indexedEvidence:1,indexedPrefix:1,current:true,reason:'index-capacity'});
 expect(rows.store.read(s.id)!.transcript).toBe(s.transcript);
 const postings=await fixture({postingRows:1});postings.add('meeting-a','Two terms');await postings.index.tick();
 expect(postings.index.describe(postings.snapshot()).sources[0]).toMatchObject({totalEvidence:1,indexedEvidence:0,indexedPrefix:0,reason:'index-capacity'});
});
test('legacy UTF-16 split quotes survive SQLite storage including isolated surrogate halves',async()=>{
 const f=await fixture(),s=f.add('meeting-a','x'.repeat(1199)+'😀suffix');await f.index.tick();
 const db=f.database();try{const rows=db.query('SELECT quote FROM chunks ORDER BY evidenceOrdinal').all() as any[];expect(rows.map(row=>Buffer.from(row.quote).toString('utf16le'))).toEqual(transcriptEvidence(s).map(e=>e.quote));}finally{db.close();}
});
test('mandatory work pauses indexing and index descriptions reject stale or forged scope objects',async()=>{
 const f=await fixture();f.add('meeting-a','Accepted');f.busy(true);await f.index.tick();expect(f.index.describe(f.snapshot()).generationId).toBeNull();
 f.busy(false);await f.index.tick();const snapshot=f.snapshot();expect(()=>f.index.describe({...snapshot})).toThrow();
 f.store.save({...f.store.read('meeting-a')!,tags:['Changed']});expect(()=>f.index.describe(snapshot)).toThrow();
 expect(JSON.stringify(f.catalog.describe(f.snapshot()))).not.toContain('Accepted');
});
test('managed quota rejection leaves authoritative bytes unchanged and does not publish an unusable generation',async()=>{
 const f=await fixture({},10000),s=f.add('meeting-a','Preserved'),path=join(f.root,'sessions',s.id+'.json'),before=readFileSync(path);
 await f.index.tick();expect(f.index.describe(f.snapshot()).generationId).toBeNull();expect(readFileSync(path)).toEqual(before);expect(f.quota.snapshot().reservedBytes).toBe(0);
});
test('deletion frees index capacity and advances a previously empty source prefix in the same generation',async()=>{
 const f=await fixture({evidenceRows:1});f.add('meeting-a','First');f.add('meeting-b','Second');await f.index.tick();const initial=f.index.describe(f.snapshot()),generation=initial.generationId;
 expect(initial.sources[1]).toMatchObject({indexedEvidence:0,reason:'index-capacity'});const epoch=initial.sources[1].epoch;
 f.store.remove('meeting-a');await f.index.tick();await f.index.tick();const next=f.index.describe(f.snapshot());
 expect(next.generationId).toBe(generation);expect(next.sources[0]).toMatchObject({sessionId:'meeting-b',indexedEvidence:1,current:true});expect(next.sources[0].epoch).toBeGreaterThan(epoch);
});
test('large create/delete churn rebuilds a bounded current catalog instead of retaining obsolete queued identities',async()=>{
 const f=await fixture({catalogSources:2});f.add('old-a','Old A');f.add('old-b','Old B');await f.index.tick();const old=f.index.describe(f.snapshot()).generationId;
 f.store.remove('old-a');f.store.remove('old-b');f.add('new-a','Current A');f.add('new-b','Current B');await f.index.tick();
 const current=f.index.describe(f.snapshot());expect(current.generationId).not.toBe(old);expect(current.sources.map(s=>[s.sessionId,s.current])).toEqual([['new-a',true],['new-b',true]]);
});
test('database growth and DELETE journals stay covered by bounded owned reservations',async()=>{
 const f=await fixture({evidenceSlice:1});const claims:Array<{id:string;bytes:number;paths:string[]}>=[],reserve=f.quota.reserve.bind(f.quota);
 f.quota.reserve=(id,bytes,paths)=>{reserve(id,bytes,paths);claims.push({id,bytes,paths:paths!});expect(f.quota.snapshot().usedBytes+f.quota.snapshot().reservedBytes).toBeLessThanOrEqual(1_000_000_000);};
 const s=f.add('meeting-a','Original');await f.index.tick();f.store.commitSource(s.id,transcriptGuard(s),current=>({...current!,transcript:'Changed\n\nSecond'}));await f.index.tick();
 expect(claims.some(c=>c.id.startsWith('retrieval-rebuild-'))).toBe(true);expect(claims.some(c=>c.id.startsWith('retrieval-work-'))).toBe(true);
 for(const claim of claims){expect(claim.paths).toEqual([f.options.directory]);expect(claim.bytes).toBeLessThanOrEqual(claim.id.startsWith('retrieval-work-')?2*f.policy.databaseBytes:f.policy.workingDiskBytes);}
 const id=f.index.describe(f.snapshot()).generationId!,bytes=statSync(join(f.options.directory,id,'index.sqlite')).size;expect(bytes).toBeLessThanOrEqual(f.policy.databaseBytes);expect(f.quota.snapshot().reservedBytes).toBe(0);
});
