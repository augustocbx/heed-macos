import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,symlinkSync,rmSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {ManagedQuota} from './managed-quota';
import {disabledCloudProtectedPaths} from './disabled-cloud-protection';

test.each(['library/catalog/google-drive/destination/provider.json','library/catalog/onedrive/opaque-provider/provider.json','dangling-account'])('disabled %s protects sole audio without parsing state or following account links',state=>{
 const root=mkdtempSync(join(tmpdir(),'heed-disabled-cloud-quota-')),library=join(root,'library'),media=join(root,'media'),wav=join(media,'sole.wav');mkdirSync(media);writeFileSync(wav,Buffer.alloc(1200000));
 mkdirSync(join(library,'catalog','google-drive'),{recursive:true});mkdirSync(join(library,'catalog','onedrive'),{recursive:true});
 const quota=new ManagedQuota({ledgerPath:join(root,'ledger.json'),roots:{media:[media]},getLimit:()=>4000000,setLimit:()=>{},protectedPaths:()=>disabledCloudProtectedPaths(root,library,[media])});
 try{
  expect(quota.preview(1048576).removals.map(item=>item.path)).toEqual([wav]);
  if(state==='dangling-account')symlinkSync(join(root,'never-read-private-target'),join(root,'google-drive.json'));
  else {const path=join(root,state);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,'{preserve unknown pending transfer state');}
  expect(()=>quota.preview(1048576)).toThrow();expect(quota.snapshot().protectedBytes).toBe(1200000);
 }finally{rmSync(root,{recursive:true,force:true});}
});
