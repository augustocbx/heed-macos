import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';

test.each([null,'google-drive.json','library/catalog/google-drive/protection.json','onedrive-account.json','library/catalog/onedrive/connections.json'])('disabled cloud routes preserve local access and protect existing %s without touching authorization',async(relative)=>{
 const root=mkdtempSync(join(tmpdir(),'heed-cloud-disabled-')),media=join(root,'media'),effects=join(root,'effects.log');mkdirSync(media);mkdirSync(join(root,'sessions'));
 const wav=join(media,'sole.wav');writeFileSync(wav,Buffer.alloc(1200000));writeFileSync(join(root,'config.json'),JSON.stringify({storage_limit_bytes:4000000}));
 writeFileSync(join(root,'sessions','synthetic.json'),JSON.stringify({id:'synthetic',title:'Synthetic local meeting',createdAt:'2026-10-06T00:00:00Z',duration:1,language:'en',transcript:'SYNTHETIC_LOCAL_TRANSCRIPT',segments:[],speakers:[],tags:[],pinned:false,transcriptFinalized:true,files:{wav}}));
 if(!relative){mkdirSync(join(root,'library','catalog','google-drive'),{recursive:true});mkdirSync(join(root,'library','catalog','onedrive'),{recursive:true});}
 const privateBytes='{preserve unfinished or corrupt private cloud state';if(relative){mkdirSync(dirname(join(root,relative)),{recursive:true});writeFileSync(join(root,relative),privateBytes);}
 const preferredId=randomUUID();writeFileSync(join(root,'provider-preference.json'),JSON.stringify({version:1,preferredId}));
 // Test-process-only traps: production has no opt-in and no fake credential path.
 const trap=(name:string)=>`(()=>{appendFileSync(${JSON.stringify(effects)},${JSON.stringify(name+'\n')});throw Error(${JSON.stringify('Synthetic authorization trap: '+name)});})`;
 const keychain=resolve(import.meta.dir,'connectors/keychain-vault.ts'),google=resolve(import.meta.dir,'connectors/google-drive-runtime.ts');
 // Vault construction is pure; every credential operation and native launch remains forbidden.
 const preload=join(root,'test-preload.ts');writeFileSync(preload,`import {mock} from 'bun:test';import {appendFileSync} from 'node:fs';mock.module(${JSON.stringify(keychain)},()=>({createKeychainVault:()=>({put:${trap('vault-put')},get:${trap('vault-get')},remove:${trap('vault-remove')}}),runNativeVault:${trap('vault-native')}}));mock.module(${JSON.stringify(google)},()=>({createGoogleDriveController:${trap('google-controller')}}));`);
 const sidecar=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>Response.json({whisper:true})});let child:Bun.Subprocess|undefined,base='';
 async function stop(){
  if(!child)return;const owned=child;
  async function wait(){let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([owned.exited.then(()=>true),new Promise<false>(resolve=>{timer=setTimeout(()=>resolve(false),1500);})]);}finally{clearTimeout(timer);}}
  owned.kill('SIGTERM');if(!await wait()){owned.kill('SIGKILL');if(!await wait())throw Error(`Isolated fixture child ${owned.pid} did not exit after SIGKILL`);}
  expect(()=>process.kill(owned.pid,0)).toThrow();child=undefined;
 }
 async function start(){const lease=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response()});base=`http://127.0.0.1:${lease.port}`;lease.stop(true);child=Bun.spawn([process.execPath,'--preload',preload,resolve(import.meta.dir,'../server.ts')],{cwd:resolve(import.meta.dir,'../../..'),env:{...process.env,PORT:base.split(':').at(-1)!,HEED_APP_DIR:root,HEED_RECORDINGS_DIR:media,HEED_TRANSCRIPTION_URL:`http://127.0.0.1:${sidecar.port}`,OLLAMA_HOST:'http://127.0.0.1:1'},stdout:'ignore',stderr:'pipe'});for(let i=0;i<120;i++){try{if((await fetch(base+'/api/sessions')).ok)return;}catch{}await Bun.sleep(25);}throw Error('Isolated default-off server did not start: '+await new Response(child!.stderr).text());}
 try{for(let restart=0;restart<2;restart++){await start();for(const path of ['/api/google-drive','/api/connectors/onedrive']){
   const status=await fetch(base+path);expect(status.status).toBe(503);expect((await status.json()).code).toBe('oauth-configuration-pending');expect(status.headers.get('cache-control')).toBe('no-store');
   for(const action of ['connect','select','create','enable','sync','disconnect']){const denied=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action})});expect(denied.status).toBe(503);expect((await denied.json()).code).toBe('oauth-configuration-pending');}
   for(const method of ['GET','POST'])expect((await fetch(base+path,{method,headers:{origin:'https://outside.example'}})).status).toBe(403);
  }
  expect(existsSync(effects)&&readFileSync(effects,'utf8')).toBe(false);expect((await fetch(base+'/api/library')).status).toBe(200);expect((await fetch(base+'/api/smb')).status).toBe(200);expect((await fetch(base+'/api/icloud')).status).toBe(200);
  expect((await(await fetch(base+'/api/recording/status')).json()).state).toBe('idle');expect((await(await fetch(base+'/api/sessions')).json())[0].transcript).toBe('SYNTHETIC_LOCAL_TRANSCRIPT');
  const preview=await fetch(base+'/api/storage/preview',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({limitBytes:1048576})});expect(preview.status).toBe(relative?409:200);if(!relative)expect((await preview.json()).removals.map((item:{path:string})=>item.path)).toContain(wav);
  if(relative)expect(readFileSync(join(root,relative),'utf8')).toBe(privateBytes);expect(readFileSync(wav).length).toBe(1200000);expect(JSON.parse(readFileSync(join(root,'provider-preference.json'),'utf8')).preferredId).toBe(preferredId);
  await stop();expect(existsSync(effects)&&readFileSync(effects,'utf8')).toBe(false);
 }}finally{try{await stop();}finally{sidecar.stop(true);rmSync(root,{recursive:true,force:true});}}
},15000);
