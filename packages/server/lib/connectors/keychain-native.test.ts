import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
test('packaged native vault compiles and validates protocol without accessing Keychain',async()=>{
 const root=mkdtempSync(join(tmpdir(),'heed-keychain-fixture-'));
 try{
  const build=Bun.spawn(['bash',join(import.meta.dir,'../../../desktop/native-keychain/build.sh'),'--build-only'],{env:{...process.env,HEED_KEYCHAIN_BUILD_DIR:root},stdout:'pipe',stderr:'pipe'});
  const errors=await new Response(build.stderr).text();expect(await build.exited,errors).toBe(0);
  const child=Bun.spawn([join(root,'heed-keychain')],{stdin:'pipe',stdout:'pipe',stderr:'pipe'});child.stdin.write(JSON.stringify({service:'outside-service',operation:'put',reference:'invalid',value:'PRIVATE_FIXTURE_MARKER'}));child.stdin.end();
  const output=await new Response(child.stdout).text();expect(await child.exited).toBe(1);expect(JSON.parse(output)).toEqual({ok:false,error:'invalid-request'});expect(output).not.toContain('PRIVATE_FIXTURE_MARKER');
 }finally{rmSync(root,{recursive:true,force:true});}
},30000);
