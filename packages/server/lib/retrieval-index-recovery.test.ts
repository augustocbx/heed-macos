import {afterEach,expect,test} from 'bun:test';
import {Database} from 'bun:sqlite';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,readFileSync,readdirSync,rmSync,writeFileSync,existsSync,statSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SessionTags,transcriptGuard} from './session-tags';
import {RetrievalCatalog} from './retrieval-catalog';
import {createRetrievalPolicy} from './retrieval-policy';
import {ManagedQuota} from './managed-quota';
import {setAtomicWriteBudget} from './atomic-json';
const module=await import('./retrieval-index').catch(()=>null);
const fixtures:any[]=[];
afterEach(()=>{setAtomicWriteBudget(undefined);for(const f of fixtures.splice(0)){f.index?.close();f.catalog.close();rmSync(f.root,{recursive:true,force:true});}});
async function fixture(overrides:any={}){
 expect(module).not.toBeNull();const root=mkdtempSync(join(tmpdir(),'heed-retrieval-recovery-')),sessions=join(root,'sessions'),directory=join(root,'indexes');mkdirSync(sessions);mkdirSync(directory);
 const store=new SessionTags(sessions),policy=createRetrievalPolicy(overrides);let busy=false;
 const catalog=new RetrievalCatalog({store,policy,isBusy:()=>busy,now:()=>0}),quota=new ManagedQuota({ledgerPath:join(root,'quota.json'),roots:{text:[sessions],indexes:[directory]},getLimit:()=>1_000_000_000,setLimit:()=>{},protectedPaths:()=>[]});
 const options={directory,catalog,store,quota,policy,isBusy:()=>busy,now:()=>0},index=new module!.RetrievalIndex(options);
 const f={root,store,catalog,quota,options,index,busy:(v:boolean)=>{busy=v;},add:(text:string)=>store.commitSource('meeting',null,()=>({id:'meeting',title:'Synthetic',createdAt:'2026-10-07',duration:1,language:'en',transcript:text,segments:[],speakers:[],tags:[],aiNotes:'',summary:'',pinned:false,transcriptFinalized:true})),snapshot:()=>catalog.resolve({kind:'library',scope:{mode:'all',labels:[],match:'any'}}).snapshot,replaceIndex:(next:any)=>{f.index.close();f.index=next;}};
 fixtures.push(f);await catalog.reconcile();return f;
}
test('compatible active generation reopens without tokenizing or changing authoritative JSON',async()=>{
 const f=await fixture(),s=f.add('Original evidence');await f.index.tick();const before=f.index.describe(f.snapshot()),bytes=readFileSync(join(f.root,'sessions',s.id+'.json'));
 f.index.close();f.index=new module!.RetrievalIndex(f.options);
 expect(f.index.describe(f.snapshot())).toEqual(before);expect(readFileSync(join(f.root,'sessions',s.id+'.json'))).toEqual(bytes);expect(f.quota.snapshot().reservedBytes).toBe(0);
});
test('interruption during source slices rolls back all new rows and preserves the prior active pointer',async()=>{
 const f=await fixture({evidenceSlice:1}),s=f.add('Original');await f.index.tick();const pointer=readFileSync(join(f.options.directory,'active.json'));
 f.store.commitSource(s.id,transcriptGuard(s),current=>({...current!,transcript:Array.from({length:20},(_,i)=>`New paragraph ${i}`).join('\n\n')}));
 const work=f.index.tick();f.busy(true);await work;expect(readFileSync(join(f.options.directory,'active.json'))).toEqual(pointer);expect(f.index.describe(f.snapshot()).sources[0].current).toBe(false);
 const id=JSON.parse(pointer.toString()).generationId,db=new Database(join(f.options.directory,id,'index.sqlite'),{readonly:true});try{expect(db.query('SELECT COUNT(*) AS n FROM chunks').get()).toEqual({n:1});}finally{db.close();}
 expect(f.quota.snapshot().reservedBytes).toBe(0);f.busy(false);await f.index.tick();expect(f.index.describe(f.snapshot()).sources[0]).toMatchObject({current:true,indexedEvidence:20});
});
test('source changes or deletion during an indexing slice cannot commit obsolete evidence',async()=>{
 const f=await fixture({evidenceSlice:1}),s=f.add('Original');await f.index.tick();
 f.store.commitSource(s.id,transcriptGuard(s),current=>({...current!,transcript:'First replacement\n\nAnother chunk'}));
 const work=f.index.tick();f.store.commitSource(s.id,transcriptGuard(f.store.read(s.id)!),current=>({...current!,transcript:'Latest accepted'}));await work;
 expect(f.index.describe(f.snapshot()).sources[0].current).toBe(false);await f.index.tick();expect(f.index.describe(f.snapshot()).sources[0]).toMatchObject({transcriptVersion:3,indexedEvidence:1,current:true});
 f.store.commitSource(s.id,transcriptGuard(f.store.read(s.id)!),current=>({...current!,transcript:'Soon deleted\n\nChunk'}));const deleting=f.index.tick();f.store.remove(s.id);await deleting;await f.index.tick();expect(f.index.describe(f.snapshot()).sources).toEqual([]);
});
test('SQLite FULL preserves the previous transaction and authoritative source while reporting index capacity',async()=>{
 const f=await fixture({databaseBytes:65536}),s=f.add('Original');await f.index.tick();const before=readFileSync(join(f.options.directory,'active.json'));
 f.store.commitSource(s.id,transcriptGuard(s),current=>({...current!,transcript:Array.from({length:100},(_,i)=>`${i} `+'x'.repeat(1190)).join('\n\n')}));const source=readFileSync(join(f.root,'sessions',s.id+'.json'));
 await f.index.tick();expect(readFileSync(join(f.options.directory,'active.json'))).toEqual(before);expect(readFileSync(join(f.root,'sessions',s.id+'.json'))).toEqual(source);expect(f.index.describe(f.snapshot()).sources[0]).toMatchObject({current:false,reason:'index-capacity'});
 const id=JSON.parse(before.toString()).generationId;expect(statSync(join(f.options.directory,id,'index.sqlite')).size).toBeLessThanOrEqual(65536);expect(existsSync(join(f.options.directory,id,'index.sqlite-journal'))).toBe(false);expect(f.quota.snapshot().reservedBytes).toBe(0);
});
test('restart releases only owned interrupted retrieval claims and removes an unpublished stage',async()=>{
 const f=await fixture();f.add('Original');await f.index.tick();const active=f.index.describe(f.snapshot()).generationId;f.index.close();
 const stage=randomUUID();mkdirSync(join(f.options.directory,stage));writeFileSync(join(f.options.directory,stage,'index.sqlite'),'Unpublished partial database');
 f.quota.reserve('retrieval-rebuild-'+stage,200000,[f.options.directory]);f.quota.reserve('provider-pending',1000,[join(f.root,'sessions','provider')]);
 f.index=new module!.RetrievalIndex(f.options);expect(f.index.describe(f.snapshot()).generationId).toBe(active);expect(existsSync(join(f.options.directory,stage))).toBe(false);expect(f.quota.allocation('retrieval-rebuild-'+stage)).toBeNull();expect(f.quota.allocation('provider-pending')).not.toBeNull();
});
test('corrupt or configuration-mismatched derived data never alters source and can rebuild cleanly',async()=>{
 const f=await fixture();const s=f.add('Original');await f.index.tick();const original=readFileSync(join(f.root,'sessions',s.id+'.json')),old=f.index.describe(f.snapshot()).generationId;f.index.close();
 writeFileSync(join(f.options.directory,old!,'index.sqlite'),'Corrupt SQLite');f.index=new module!.RetrievalIndex(f.options);expect(f.index.describe(f.snapshot()).generationId).toBeNull();await f.index.tick();expect(f.index.describe(f.snapshot()).sources[0].current).toBe(true);
 expect(readdirSync(f.options.directory).filter(id=>id!=='active.json')).toHaveLength(1);expect(readFileSync(join(f.root,'sessions',s.id+'.json'))).toEqual(original);
 f.index.close();f.index=new module!.RetrievalIndex({...f.options,policy:createRetrievalPolicy({evidenceRows:1})});expect(f.index.describe(f.snapshot()).generationId).toBeNull();await f.index.tick();expect(f.index.describe(f.snapshot()).sources[0].current).toBe(true);expect(readdirSync(f.options.directory).filter(id=>id!=='active.json')).toHaveLength(1);
});
test('a real interrupted SQLite DELETE journal is recovered before the active generation serves descriptions',async()=>{
 const f=await fixture();f.add('Original');await f.index.tick();const id=f.index.describe(f.snapshot()).generationId,path=join(f.options.directory,id!,'index.sqlite'),bytes=statSync(path).size;f.index.close();
 const child=spawnSync(process.execPath,['-e',`import {Database} from 'bun:sqlite';const db=new Database(process.argv[1]);db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA cache_size=1; PRAGMA cache_spill=ON; BEGIN IMMEDIATE; UPDATE chunks SET quote=zeroblob(50000); UPDATE metadata SET value=zeroblob(50000)");process.kill(process.pid,'SIGKILL');`,path],{encoding:'utf8'});expect(child.signal).toBe('SIGKILL');expect(existsSync(path+'-journal')).toBe(true);expect(statSync(path).size).toBeGreaterThan(bytes);
 f.index=new module!.RetrievalIndex(f.options);expect(f.index.describe(f.snapshot()).sources[0].current).toBe(true);const db=new Database(path,{readonly:true});try{const row=db.query('SELECT quote FROM chunks').get() as {quote:Uint8Array};expect(Buffer.from(row.quote).toString('utf16le')).toBe('Original');}finally{db.close();}expect(existsSync(path+'-journal')).toBe(false);expect(f.quota.snapshot().reservedBytes).toBe(0);
});
test('a post-rename pointer acknowledgment failure retains a verified generation for restart',async()=>{
 const f=await fixture();f.add('Original');await f.index.tick();const old=f.index.describe(f.snapshot()).generationId;
 let failed=false;setAtomicWriteBudget(path=>()=>{if(path.endsWith('active.json')&&!failed){failed=true;throw new Error('Synthetic acknowledgment failure after rename');}});
 await f.index.rebuild();setAtomicWriteBudget(undefined);const pointer=JSON.parse(readFileSync(join(f.options.directory,'active.json'),'utf8'));
 expect(pointer.generationId).not.toBe(old);expect(existsSync(join(f.options.directory,pointer.generationId,'index.sqlite'))).toBe(true);
 f.index.close();f.index=new module!.RetrievalIndex(f.options);expect(f.index.describe(f.snapshot())).toMatchObject({generationId:pointer.generationId,sources:[{current:true}]});expect(f.quota.snapshot().reservedBytes).toBe(0);
});
test('aborted rebuild and close during a source slice preserve the active generation and release owned claims',async()=>{
 const f=await fixture({evidenceSlice:1});f.add('First\n\nSecond');await f.index.tick();const pointer=readFileSync(join(f.options.directory,'active.json'));
 const controller=new AbortController(),work=f.index.rebuild(controller.signal);controller.abort();await expect(work).rejects.toThrow();
 expect(readFileSync(join(f.options.directory,'active.json'))).toEqual(pointer);expect(readdirSync(f.options.directory).filter(id=>id!=='active.json')).toHaveLength(1);expect(f.quota.snapshot().reservedBytes).toBe(0);
 const closing=f.index.rebuild();f.index.close();await closing;expect(readFileSync(join(f.options.directory,'active.json'))).toEqual(pointer);expect(f.quota.snapshot().reservedBytes).toBe(0);
});
test('derived pointer reads admit the exact four-KiB boundary and reject larger or symlinked pointers',async()=>{
 const f=await fixture();const s=f.add('Source preserved');await f.index.tick();const id=f.index.describe(f.snapshot()).generationId!,pointer=join(f.options.directory,'active.json'),original=readFileSync(pointer,'utf8'),source=readFileSync(join(f.root,'sessions',s.id+'.json'));
 f.index.close();writeFileSync(pointer,' '.repeat(4096-Buffer.byteLength(original))+original);f.index=new module!.RetrievalIndex(f.options);expect(f.index.describe(f.snapshot()).generationId).toBe(id);
 f.index.close();writeFileSync(pointer,' '.repeat(4097-Buffer.byteLength(original))+original);f.index=new module!.RetrievalIndex(f.options);expect(f.index.describe(f.snapshot()).generationId).toBeNull();await f.index.tick();expect(f.index.describe(f.snapshot()).sources[0].current).toBe(true);expect(readFileSync(join(f.root,'sessions',s.id+'.json'))).toEqual(source);
 f.index.close();const foreign=join(f.root,'unrelated-pointer.json');writeFileSync(foreign,readFileSync(pointer));const foreignBytes=readFileSync(foreign);rmSync(pointer);symlinkSync(foreign,pointer);f.index=new module!.RetrievalIndex(f.options);expect(f.index.describe(f.snapshot()).generationId).toBeNull();await f.index.tick();expect(f.index.describe(f.snapshot()).sources[0].current).toBe(true);expect(readFileSync(foreign)).toEqual(foreignBytes);
});
