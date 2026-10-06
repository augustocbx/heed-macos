import {test,expect} from 'bun:test';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {MacCloudNative} from './icloud-folder';import {reapAll} from '../process';
test('server shutdown reaps a blocked native folder helper before returning',async()=>{
 const root=mkdtempSync(join(tmpdir(),'heed-cloud-native-')),helper=join(root,'synthetic-helper'),pidFile=join(root,'pid');let pid:number|undefined;let result:Promise<unknown>|undefined;
 try{
  // A shell handshake avoids an unrelated Python interpreter bootstrap in this process test.
  writeFileSync(helper,`#!/bin/sh\nread header\nprintf '%s' "$$" > '${pidFile}'\nexec /bin/sleep 60\n`,{mode:0o700});
  result=new MacCloudNative(helper).json({action:'probe'}).catch(()=>null);
  const deadline=Date.now()+3000;while(!existsSync(pidFile)&&Date.now()<deadline)await Bun.sleep(10);
  expect(existsSync(pidFile)).toBe(true);pid=Number(readFileSync(pidFile,'utf8'));await reapAll();await result;
  expect(()=>process.kill(pid!,0)).toThrow();
 }finally{await reapAll();if(existsSync(pidFile))pid=Number(readFileSync(pidFile,'utf8'));if(pid)try{process.kill(pid,'SIGKILL');}catch{}await result;rmSync(root,{recursive:true,force:true});}
});
test('cancellation drains bounded stderr and reaps an ignoring helper',async()=>{
 const root=mkdtempSync(join(tmpdir(),'heed-cloud-cancel-')),helper=join(root,'helper'),pidFile=join(root,'pid'),controller=new AbortController();let pid:number|undefined,result:Promise<unknown>|undefined;
 try{writeFileSync(helper,`#!/bin/sh\nread header\ntrap '' TERM\nprintf '%s' "$$" > '${pidFile}'\nhead -c 100000 /dev/zero >&2\nexec /bin/sleep 60\n`,{mode:0o700});result=new MacCloudNative(helper).json({action:'probe'},controller.signal);const deadline=Date.now()+3000;while(!existsSync(pidFile)&&Date.now()<deadline)await Bun.sleep(10);expect(existsSync(pidFile)).toBe(true);pid=Number(readFileSync(pidFile,'utf8'));controller.abort();await expect(result).rejects.toThrow();expect(()=>process.kill(pid!,0)).toThrow();}
 finally{controller.abort();await result?.catch(()=>{});if(pid)try{process.kill(pid,'SIGKILL');}catch{}rmSync(root,{recursive:true,force:true});}
});
