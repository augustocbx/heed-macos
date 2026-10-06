import {afterEach, expect, test} from 'bun:test';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, existsSync} from 'node:fs';
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
