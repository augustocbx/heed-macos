import {test,expect} from 'bun:test';
import {createKeychainVault} from './keychain-vault';
test('keeps tokens and upload URLs in stdin behind opaque durable refs',async()=>{
 const stored=new Map<string,string>();const invocations:string[][]=[];const vault=createKeychainVault({helperPath:'/isolated/heed-keychain',run:async(command:string[],stdin:string)=>{
  invocations.push(command);const request=JSON.parse(stdin);
  expect(request.service).toBe('local.heed.connectors.v1');
  if(request.operation==='put')stored.set(request.reference,request.value);
  if(request.operation==='remove')stored.delete(request.reference);
  return {code:0,stdout:JSON.stringify({ok:true,...(request.operation==='get'?{value:stored.get(request.reference)??null}:{})})};
 }});
 const ref=await vault.put({refreshToken:'SECRET_REFRESH',uploadUrl:'https://upload.example/SECRET_SESSION'});expect(ref).toMatch(/^[a-f0-9-]{36}$/);
 expect(JSON.stringify(invocations)).not.toContain('SECRET');expect(await vault.get<Record<string,string>>(ref)).toEqual({refreshToken:'SECRET_REFRESH',uploadUrl:'https://upload.example/SECRET_SESSION'});
 expect(await vault.put({accessToken:'UPDATED'},ref)).toBe(ref);expect(await vault.get<Record<string,string>>(ref)).toEqual({accessToken:'UPDATED'});await vault.remove(ref);expect(await vault.get<Record<string,string>>(ref)).toBeNull();
});
test('unavailable, locked, oversized and invalid-reference vault operations fail closed',async()=>{
 const vault=createKeychainVault({helperPath:'/fake',run:async()=>({code:1,stdout:JSON.stringify({ok:false,error:'locked'})})});
 await expect(vault.get('not-ref')).rejects.toThrow('Invalid secret reference');await expect(vault.put({token:'secret'})).rejects.toThrow('Protected credential storage is unavailable');
 await expect(vault.put({token:'s'.repeat(70000)})).rejects.toThrow('Secret exceeds');
});
test('native pipe failure reaps its isolated helper before rejecting the vault request',async()=>{
 const {runNativeVault}=await import('./keychain-vault');let child:Bun.Subprocess|undefined;
 const running=runNativeVault(['/isolated/helper'],'SECRET_STDIN_FIXTURE',()=>{
  child=Bun.spawn(['node','-e','setInterval(()=>{},1000)'],{stdin:'pipe',stdout:'pipe',stderr:'ignore'});
  return {stdin:child.stdin as Bun.FileSink,stdout:new ReadableStream({start(controller){controller.error(new Error('synthetic pipe failure'));}}),exited:child.exited,kill:()=>child!.kill('SIGKILL')};
 });
 try{await expect(running).rejects.toThrow();expect(()=>process.kill(child!.pid,0)).toThrow();}
 finally{child?.kill('SIGKILL');await child?.exited;}
});
test('server shutdown reaps a pending protected credential helper',async()=>{
 const {mkdtempSync,existsSync,readFileSync,writeFileSync,rmSync}=await import('node:fs');const {join}=await import('node:path');const {tmpdir}=await import('node:os');const root=mkdtempSync(join(tmpdir(),'heed-vault-shutdown-')),pidPath=join(root,'helper.pid'),runnerPath=join(root,'runner.ts');let helperPid:number|undefined;let runner:Bun.Subprocess|undefined;
 try{const helperCode=`require('node:fs').writeFileSync(${JSON.stringify(pidPath)},String(process.pid));setInterval(()=>{},1000);`;writeFileSync(runnerPath,`import {runNativeVault} from ${JSON.stringify(join(import.meta.dir,'keychain-vault.ts'))};import {installShutdownHooks} from ${JSON.stringify(join(import.meta.dir,'../process.ts'))};installShutdownHooks();void runNativeVault([process.execPath,'-e',${JSON.stringify(helperCode)}],'{}').catch(()=>{});`);runner=Bun.spawn([process.execPath,runnerPath],{stdout:'ignore',stderr:'ignore'});const deadline=Date.now()+3000;while(!existsSync(pidPath)&&Date.now()<deadline)await Bun.sleep(10);expect(existsSync(pidPath)).toBe(true);helperPid=Number(readFileSync(pidPath,'utf8'));runner.kill('SIGTERM');await runner.exited;expect(()=>process.kill(helperPid!,0)).toThrow();}
 finally{runner?.kill('SIGKILL');await runner?.exited.catch(()=>{});if(helperPid)try{process.kill(helperPid,'SIGKILL');}catch{}rmSync(root,{recursive:true,force:true});}
});
