import {afterEach, expect, test} from 'bun:test';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ManagedQuota, configuredManagedLimit} from './managed-quota';
import {atomicWriteJson,setAtomicWriteBudget} from './atomic-json';

const roots: string[]=[];
afterEach(()=>{setAtomicWriteBudget(undefined);for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function setup(limit=100){
 const root=mkdtempSync(join(tmpdir(),'heed-quota-'));roots.push(root);
 const text=join(root,'sessions'),media=join(root,'media'),staging=join(root,'staging');
 for(const path of [text,media,staging])mkdirSync(path);
 let value=limit;
 const options={ledgerPath:join(root,'quota.json'),roots:{text:[text],media:[media],staging:[staging]},getLimit:()=>value,setLimit:(next:number)=>{value=next;},protectedPaths:()=>[] as string[]};
 return {root,text,media,staging,options,quota:new ManagedQuota(options),value:()=>value};
}
test('counts each managed physical file once and excludes symlinks and unrelated data',()=>{
 const s=setup();writeFileSync(join(s.text,'meeting.json'),'12345');writeFileSync(join(s.media,'a.wav'),'1234567');
 writeFileSync(join(s.root,'model.bin'),'x'.repeat(200));symlinkSync(join(s.root,'model.bin'),join(s.media,'external.wav'));
 const quota=new ManagedQuota({...s.options,roots:{...s.options.roots,text:[s.text,s.text]}});
 expect(quota.snapshot().usedBytes).toBe(12);expect(quota.snapshot().categories.text).toBe(5);expect(quota.snapshot().availableBytes).toBe(88);
});
test('durable reservations prevent concurrent jobs consuming the same allowance without double-counting staged bytes',()=>{
 const s=setup();const file=join(s.staging,'upload');s.quota.reserve('upload',70,[file]);
 expect(()=>s.quota.reserve('capture',40,[])).toThrow('quota');writeFileSync(file,'x'.repeat(20));
 const restored=new ManagedQuota(s.options);expect(restored.snapshot().usedBytes).toBe(20);expect(restored.snapshot().reservedBytes).toBe(50);
 expect(restored.snapshot().availableBytes).toBe(30);restored.release('upload');expect(restored.snapshot().reservedBytes).toBe(0);
});
test('repeated reservation keys are idempotent but cannot change their allocation or claim the same path',()=>{
 const s=setup();const path=join(s.staging,'a');s.quota.reserve('a',60,[path]);s.quota.reserve('a',60,[path]);
 expect(s.quota.snapshot().reservedBytes).toBe(60);expect(()=>s.quota.reserve('a',30,[path])).toThrow();expect(()=>s.quota.reserve('b',20,[path])).toThrow();
 expect(()=>s.quota.reserve('external',1,[join(s.root,'private')])).toThrow();
});
test('reviewed reduction removes only eligible oldest media and leaves text and protected pending audio',()=>{
 const s=setup();const old=join(s.media,'old.wav'),pending=join(s.media,'pending.wav');
 writeFileSync(join(s.text,'meeting.json'),'1234567890');writeFileSync(old,'x'.repeat(40));writeFileSync(pending,'x'.repeat(20));
 const quota=new ManagedQuota({...s.options,protectedPaths:()=>[pending]});const preview=quota.preview(40);
 expect(preview.removals.map(x=>x.path)).toEqual([old]);expect(preview.protectedBytes).toBe(30);
 expect(()=>quota.apply(40,'unreviewed')).toThrow('preview');quota.apply(40,preview.token);
 expect(s.value()).toBe(40);expect(existsSync(old)).toBe(false);expect(existsSync(pending)).toBe(true);expect(quota.snapshot().usedBytes).toBe(30);
});
test('changed usage invalidates destructive preview and protected usage rejects reduction',()=>{
 const s=setup();writeFileSync(join(s.text,'meeting.json'),'x'.repeat(60));writeFileSync(join(s.media,'a.wav'),'x'.repeat(30));
 expect(()=>s.quota.preview(50)).toThrow('protected');const preview=s.quota.preview(70);
 writeFileSync(join(s.text,'another.json'),'1');expect(()=>s.quota.apply(70,preview.token)).toThrow('preview');expect(s.value()).toBe(100);
});
test('explicit disposable index files are reviewed before media and retired only after current-token validation',()=>{
 const s=setup(1000),indexes=join(s.root,'indexes');mkdirSync(indexes);const derived=join(indexes,'derived.sqlite'),foreign=join(indexes,'provider.json'),audio=join(s.media,'old.wav');
 writeFileSync(derived,'x'.repeat(100));writeFileSync(foreign,'provider');writeFileSync(audio,'x'.repeat(30));writeFileSync(join(s.text,'source.json'),'source');
 let eligible=true,calls=0;
 const quota=new ManagedQuota({...s.options,roots:{...s.options.roots,indexes:[indexes]},disposableFiles:()=>eligible?[derived]:[],disposeFiles:(paths:string[])=>{expect(paths).toEqual([derived]);calls++;rmSync(derived);}} as any);
 const preview=quota.preview(50);expect(preview.removals).toEqual([]);expect(preview.derivedCache).toEqual({bytes:100,files:1});expect(calls).toBe(0);expect(existsSync(derived)).toBe(true);
 eligible=false;expect(()=>quota.apply(50,preview.token)).toThrow();expect(calls).toBe(0);expect(existsSync(audio)).toBe(true);eligible=true;
 expect(()=>quota.apply(50,'stale')).toThrow('preview');expect(calls).toBe(0);quota.apply(50,preview.token);expect(calls).toBe(1);expect(readFileSync(foreign,'utf8')).toBe('provider');expect(existsSync(audio)).toBe(true);expect(s.value()).toBe(50);
});
test('one protected or missing bundle member prevents partial disposable-cache review',()=>{
 const s=setup(1000),indexes=join(s.root,'indexes');mkdirSync(indexes);const database=join(indexes,'index.sqlite'),pointer=join(indexes,'active.json');writeFileSync(database,'x'.repeat(100));writeFileSync(pointer,'pointer');let protectedPaths=[database],calls=0;
 const quota=new ManagedQuota({...s.options,roots:{...s.options.roots,indexes:[indexes]},protectedPaths:()=>protectedPaths,disposableFiles:()=>[database,pointer],disposeFiles:()=>{calls++;}});
 expect(quota.snapshot().reclaimableCacheBytes).toBe(0);expect(()=>quota.preview(50)).toThrow('protected');expect(calls).toBe(0);
 protectedPaths=[];const preview=quota.preview(50);expect(preview.derivedCache).toEqual({bytes:107,files:2});quota.reserve('foreign-active',107,[database]);expect(()=>quota.apply(50,preview.token)).toThrow();expect(calls).toBe(0);quota.release('foreign-active');rmSync(pointer);expect(quota.snapshot().reclaimableCacheBytes).toBe(0);expect(()=>quota.preview(50)).toThrow('protected');expect(existsSync(database)).toBe(true);
});
test('default and persisted byte limits validate safe integer accounting',()=>{
 expect(configuredManagedLimit(undefined)).toBe(2_000_000_000);expect(configuredManagedLimit(3_000_000_000)).toBe(3_000_000_000);
 for(const value of [0,-1,NaN,Infinity,1.5,Number.MAX_SAFE_INTEGER,'2000000000',null])expect(configuredManagedLimit(value)).toBe(2_000_000_000);
});
test('atomic metadata updates reserve the replacement copy and fail without changing committed text',()=>{
 const s=setup(40);const path=join(s.text,'meeting.json');atomicWriteJson(path,{text:'old'});
 setAtomicWriteBudget((file,bytes)=>s.quota.atomicWriteBudget(file,bytes));
 expect(()=>atomicWriteJson(path,{text:'x'.repeat(40)})).toThrow('quota');
 expect(JSON.parse(require('node:fs').readFileSync(path,'utf8')).text).toBe('old');expect(s.quota.snapshot().reservedBytes).toBe(0);
 atomicWriteJson(path,{text:'new'});expect(JSON.parse(require('node:fs').readFileSync(path,'utf8')).text).toBe('new');expect(s.quota.snapshot().reservedBytes).toBe(0);
});
test('a job directory consumes its reservation as temporary files grow and excludes overlapping claims',()=>{
 const s=setup();const job=join(s.staging,'job');mkdirSync(job);s.quota.reserve('job',70,[job]);
 writeFileSync(join(job,'payload.json'),'x'.repeat(20));expect(s.quota.snapshot().reservedBytes).toBe(50);expect(s.quota.snapshot().availableBytes).toBe(30);
 expect(()=>s.quota.reserve('other',10,[join(job,'another')])).toThrow();
 setAtomicWriteBudget((file,bytes)=>s.quota.atomicWriteBudget(file,bytes));atomicWriteJson(join(job,'more.json'),{text:'hello'});
 expect(s.quota.snapshot().usedBytes+s.quota.snapshot().reservedBytes).toBe(70);
});
test('restart cleans only recorded interrupted atomic-write copies and releases their transient reservation',()=>{
 const s=setup(1000);const path=join(s.text,'meeting.json'),temporary=`${path}.00000000-0000-4000-8000-000000000000.tmp`;
 writeFileSync(path,'committed');writeFileSync(temporary,'partial');
 writeFileSync(s.options.ledgerPath,JSON.stringify({version:1,reservations:{'write-interrupted':{bytes:200,paths:[path,temporary]},'provider-pending':{bytes:100,paths:[s.staging]}}}));
 const recovered=new ManagedQuota(s.options);expect(existsSync(temporary)).toBe(false);expect(require('node:fs').readFileSync(path,'utf8')).toBe('committed');expect(recovered.snapshot().reservedBytes).toBe(100);
});
test('managed singleton metadata roots account for their atomic sibling copies',()=>{
 const s=setup(1000);const path=join(s.root,'recording-manifest.json'),temporary=`${path}.00000000-0000-4000-8000-000000000000.tmp`;
 const quota=new ManagedQuota({...s.options,roots:{...s.options.roots,text:[s.text,path]}});
 setAtomicWriteBudget((file,bytes,tmp)=>quota.atomicWriteBudget(file,bytes,tmp));atomicWriteJson(path,{state:'recording'});
 writeFileSync(temporary,'working');expect(quota.snapshot().categories.text).toBe(require('node:fs').statSync(path).size+7);
});
test('allocated metadata counts atomic siblings once and cleans interrupted writes without dropping provider claims',()=>{
 const s=setup(1000);const path=join(s.text,'meeting.json'),temporary=`${path}.00000000-0000-4000-8000-000000000000.tmp`;
 s.quota.reserve('provider',200,[path]);writeFileSync(path,'committed');writeFileSync(temporary,'partial');
 expect(s.quota.snapshot().usedBytes+s.quota.snapshot().reservedBytes).toBe(200);
 writeFileSync(s.options.ledgerPath,JSON.stringify({version:1,reservations:{provider:{bytes:200,paths:[path]}},atomicWrites:{interrupted:{path,temporary,allocationId:'provider'}}}));
 const resumed=new ManagedQuota(s.options);expect(existsSync(temporary)).toBe(false);expect(resumed.allocation('provider')?.bytes).toBe(200);
});
test('restart releases only interrupted manual imports and removes their staging, preserving audio and capture/provider claims',()=>{
 const s=setup(1000),job='00000000-0000-4000-8000-000000000000',stage=join(s.staging,`media-${job}`),audio=join(s.media,'import.wav');mkdirSync(stage);writeFileSync(join(stage,'upload'),'partial');writeFileSync(audio,'audio');
 writeFileSync(s.options.ledgerPath,JSON.stringify({version:1,reservations:{[`media-${job}`]:{bytes:100,paths:[stage,audio]},'capture-pending':{bytes:200,paths:[]}}}));
 const restarted=new ManagedQuota(s.options);expect(existsSync(stage)).toBe(false);expect(existsSync(audio)).toBe(true);expect(restarted.allocation(`media-${job}`)).toBeNull();expect(restarted.allocation('capture-pending')?.bytes).toBe(200);
});
test('legacy text sidecars remain protected when eligible audio is evicted',()=>{const s=setup();const audio=join(s.media,'capture.wav'),text=join(s.media,'capture.txt');writeFileSync(audio,'a'.repeat(40));writeFileSync(text,'transcript');const preview=s.quota.preview(20);expect(preview.removals.map(file=>file.path)).toEqual([audio]);s.quota.apply(20,preview.token);expect(existsSync(text)).toBe(true);expect(s.quota.snapshot().categories.text).toBe(10);});

test('explicit ledger storage keeps construction and reservation off the pathname filesystem',()=>{
 const fixture=setup();const sentinel=join(fixture.root,'not-a-directory');writeFileSync(sentinel,'owned fixture sentinel');
 const writes:unknown[]=[];const quota=new ManagedQuota({ledgerPath:join(sentinel,'ledger'),roots:{},getLimit:()=>1000,setLimit:()=>{},protectedPaths:()=>[],ledgerStorage:{load:()=>null,save:(value:unknown)=>{writes.push(structuredClone(value));}}} as any);
 quota.reserve('qa-fixture',512,[]);expect(quota.allocation('qa-fixture')).toEqual({bytes:512,paths:[]});expect(writes).toHaveLength(1);
});
test('default pathname ledger keeps rejecting an existing null document',()=>{
 const s=setup();writeFileSync(s.options.ledgerPath,'null');expect(()=>new ManagedQuota(s.options)).toThrow();
});

test('opted-in quota uses original inventory and refuses ungranted reservation without fallback',()=>{
 const s=setup();writeFileSync(join(s.media,'a.wav'),'foreign visible bytes');
 const localIo={inventory(){return [];},owns(){return false;},exists(){throw new Error('Original descriptor refused');},stat(){throw new Error('Original descriptor refused');},unlink(){throw new Error('Original descriptor refused');},removeStaging(){throw new Error('Original descriptor refused');}};
 const quota=new ManagedQuota({...s.options,ledgerStorage:{load:()=>null,save(){}},localIo});
 expect(quota.snapshot().usedBytes).toBe(0);expect(()=>quota.reserve('x',1,[join(s.media,'a.wav')])).toThrow('Invalid quota reservation');
});

test('cache owner refusal or incomplete retirement prevents media removal and limit mutation',()=>{
 for(const failure of ['refuse','incomplete']){
  const s=setup(1000),indexes=join(s.root,'indexes');mkdirSync(indexes);
  const derived=join(indexes,'derived.sqlite'),media=join(s.media,'old.wav');writeFileSync(derived,'x'.repeat(100));writeFileSync(media,'x'.repeat(100));
  const quota=new ManagedQuota({...s.options,roots:{...s.options.roots,indexes:[indexes]},disposableFiles:()=>[derived],disposeFiles:()=>{if(failure==='refuse')throw Error('Owner refused');}});
  const preview=quota.preview(50);expect(preview.removals.map(file=>file.path)).toEqual([media]);
  expect(()=>quota.apply(50,preview.token)).toThrow(failure==='refuse'?'Owner refused':'did not retire');
  expect(readFileSync(media,'utf8')).toBe('x'.repeat(100));expect(existsSync(derived)).toBe(true);expect(s.value()).toBe(1000);
 }
});
