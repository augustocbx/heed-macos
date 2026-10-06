import {expect,test,afterEach} from 'bun:test';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {ManagedQuota} from './managed-quota';
import {reserveMediaWork} from './media-budget';
const dirs:string[]=[];afterEach(()=>{for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
function fixture(){const dir=mkdtempSync(join(tmpdir(),'heed-media-budget-'));dirs.push(dir);const media=join(dir,'media'),work=join(dir,'staging','job');mkdirSync(media);mkdirSync(work,{recursive:true});const quota=new ManagedQuota({ledgerPath:join(dir,'quota.json'),roots:{media:[media],staging:[join(dir,'staging')]},getLimit:()=>2_000_000,setLimit:()=>{},protectedPaths:()=>[]});return {quota,work,path:join(media,'import.wav')};}
test('media imports claim working copies before writing and concurrent work cannot reuse the budget',()=>{const f=fixture();const claim=reserveMediaWork(f.quota,'job',f.path,f.work);expect(claim.maxSourceBytes*4).toBeLessThanOrEqual(claim.reservedBytes);expect(()=>reserveMediaWork(f.quota,'other',join(f.path,'other'),join(f.work,'other'))).toThrow();writeFileSync(f.path,Buffer.alloc(100));expect(f.quota.snapshot().usedBytes+f.quota.snapshot().reservedBytes).toBeLessThanOrEqual(2_000_000);claim.release();expect(f.quota.snapshot().reservedBytes).toBe(0);});
test('a known upload larger than source allowance is rejected before any disk writer starts',()=>{const f=fixture();expect(()=>reserveMediaWork(f.quota,'job',f.path,f.work,900_000)).toThrow('quota');expect(f.quota.snapshot().reservedBytes).toBe(0);});
