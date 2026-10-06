import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
const root=realpathSync(resolve(import.meta.dir,'../../..'));
test('API exposes checkout identity and refuses foreign sidecar HTTP success without changing local access',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'heed-port-api-'));let mode='html';
 const sidecar=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>mode==='html'?new Response('<html>other app</html>'):Response.json(mode==='wrong'?{whisper:true,ready:true}:{service:'heed-transcription',protocolVersion:1,checkoutRoot:'/synthetic-external',pid:process.pid,whisper:true,pyannote:false,ready:true})});
 const lease=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response()});const port=lease.port!;lease.stop(true);const base=`http://127.0.0.1:${port}`;
 const child=Bun.spawn([process.execPath,join(root,'packages/server/server.ts')],{cwd:root,env:{...process.env,PORT:String(port),HEED_API_PORT:String(port),HEED_APP_DIR:dir,HEED_RECORDINGS_DIR:join(dir,'media'),HEED_TRANSCRIPTION_URL:`http://127.0.0.1:${sidecar.port}`,OLLAMA_HOST:'http://127.0.0.1:1'},stdout:'ignore',stderr:'pipe'});
 try{
  let identity:any;for(let i=0;i<120;i++){try{const response=await fetch(base+'/.well-known/heed-service');if(response.ok){identity=await response.json();break;}}catch{}await Bun.sleep(20);}
  expect(identity).toEqual({service:'heed-api',protocolVersion:1,checkoutRoot:root,pid:child.pid});
  expect((await fetch(base+'/.well-known/heed-service',{headers:{origin:'https://outside.example'}})).status).toBe(403);
  for(mode of ['html','wrong']){const status=await(await fetch(base+'/api/desktop/control/status')).json();expect(status.service).toBe('heed-api');expect(status.ready).toBe(false);expect((await(await fetch(base+'/api/health')).json()).whisper).toBe(false);}
  mode='heed';expect((await(await fetch(base+'/api/desktop/control/status')).json()).ready).toBe(true);
  expect((await fetch(base+'/api/sessions')).status).toBe(200);expect((await(await fetch(base+'/api/recording/status')).json()).state).toBe('idle');
 }finally{child.kill('SIGTERM');await child.exited;sidecar.stop(true);rmSync(dir,{recursive:true,force:true});}
});
test('configured forbidden API exits before creating a personal store or binding',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'heed-port-reject-'));
 const child=Bun.spawn([process.execPath,join(root,'packages/server/server.ts')],{cwd:root,env:{...process.env,PORT:'5001',HEED_API_PORT:'5001',HEED_APP_DIR:join(dir,'never-created')},stdout:'ignore',stderr:'pipe'});
 try{const error=await new Response(child.stderr).text();expect(await child.exited).not.toBe(0);expect(error).toContain('outside 3000');expect((await import('node:fs')).existsSync(join(dir,'never-created'))).toBe(false);}finally{child.kill();await child.exited;rmSync(dir,{recursive:true,force:true});}
});
test('real Python sidecar health handler identifies itself without loading models or using recordings',async()=>{
 const lease=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response()});const port=lease.port!;lease.stop(true);
 const source=join(root,'packages/transcription/transcription_server.py');
 const code=`import runpy,sys\nsys.path.insert(0,${JSON.stringify(join(root,'packages/transcription'))})\nm=runpy.run_path(${JSON.stringify(source)})\ns=m['ThreadingHTTPServer'](('127.0.0.1',m['PORT']),m['Handler'])\ns.serve_forever()\n`;
 const child=Bun.spawn(['/usr/bin/python3','-u','-c',code],{cwd:root,env:{...process.env,HEED_TRANSCRIPTION_PORT:String(port)},stdout:'ignore',stderr:'pipe'});
 try{let health:any;for(let i=0;i<100;i++){if(child.exitCode!==null)throw Error(await new Response(child.stderr).text());try{const response=await fetch(`http://127.0.0.1:${port}/health`);if(response.ok){health=await response.json();break;}}catch{}await Bun.sleep(20);}
  expect(health?.service).toBe('heed-transcription');expect(health?.checkoutRoot).toBe(root);expect(health?.pid).toBe(child.pid);expect(health?.protocolVersion).toBe(1);expect(health?.ready).toBe(false);expect(health?.whisper).toBe(false);
 }finally{child.kill('SIGTERM');await child.exited;}
});
test('Vite strict safe interface port publishes matching checkout identity',async()=>{
 const lease=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response()});const port=lease.port!;lease.stop(true);
 const child=Bun.spawn([process.execPath,join(root,'packages/client/node_modules/vite/bin/vite.js')],{cwd:join(root,'packages/client'),env:{...process.env,HEED_UI_PORT:String(port)},stdout:'ignore',stderr:'pipe'});
 try{let identity:any;for(let i=0;i<140;i++){if(child.exitCode!==null)throw Error(await new Response(child.stderr).text());try{const response=await fetch(`http://127.0.0.1:${port}/.well-known/heed-service`);if(response.ok){identity=await response.json();break;}}catch{}await Bun.sleep(20);}
  expect(identity?.service).toBe('heed-ui');expect(identity?.checkoutRoot).toBe(root);expect(identity?.protocolVersion).toBe(1);expect(identity?.pid).toBe(child.pid);
 }finally{child.kill('SIGTERM');await child.exited;}
},10000);
test('saved custom installation works for envless API and independently launched browser native host',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'heed-envless-ports-'));const lease=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response()});const port=lease.port!;lease.stop(true);
 const sidecar=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>Response.json({service:'heed-transcription',protocolVersion:1,checkoutRoot:root,pid:process.pid,whisper:false,pyannote:false,ready:false})});
 const installEnv={...process.env,HEED_APP_DIR:dir,HEED_API_PORT:String(port),HEED_UI_PORT:'48121',HEED_TRANSCRIPTION_PORT:String(sidecar.port)};delete installEnv.PORT;
 const saved=Bun.spawn(['/usr/bin/python3',join(root,'scripts/service_config.py'),'api','--save'],{cwd:root,env:installEnv,stdout:'pipe',stderr:'pipe'});expect(await saved.exited).toBe(0);
 const env={...process.env,HEED_APP_DIR:dir,HEED_RECORDINGS_DIR:join(dir,'media'),OLLAMA_HOST:'http://127.0.0.1:1'};for(const key of ['PORT','HEED_API_PORT','HEED_UI_PORT','HEED_TRANSCRIPTION_PORT','HEED_TRANSCRIPTION_URL'])delete env[key];
 const child=Bun.spawn([process.execPath,join(root,'packages/server/server.ts')],{cwd:root,env,stdout:'ignore',stderr:'pipe'});let host:Bun.Subprocess|undefined;
 try{
  let response:Response|undefined;for(let i=0;i<100;i++){try{response=await fetch(`http://127.0.0.1:${port}/.well-known/heed-service`);if(response.ok)break;}catch{}await Bun.sleep(20);}expect(response?.status).toBe(200);
  const payload=Buffer.from(JSON.stringify({app:'meet',detectorId:'browser:synthetic-saved-port',sequence:1,state:'unknown',callId:null,capability:'degraded'}));const header=Buffer.alloc(4);header.writeUInt32LE(payload.length);
  host=Bun.spawn(['/usr/bin/python3',join(root,'packages/desktop/browser-meet/native-host.py'),`chrome-extension://${'a'.repeat(32)}/`],{cwd:root,env,stdin:'pipe',stdout:'pipe',stderr:'pipe'});host.stdin.write(Buffer.concat([header,payload]));host.stdin.end();
  const output=Buffer.from(await new Response(host.stdout).arrayBuffer());expect(await host.exited).toBe(0);expect(JSON.parse(output.subarray(4).toString())).toEqual({ok:true});
  const status=await(await fetch(`http://127.0.0.1:${port}/api/meeting-detection/status`)).json();expect(status.sources.some((item:any)=>item.detectorId==='browser:synthetic-saved-port')).toBe(true);
 }finally{host?.kill();if(host)await host.exited;child.kill('SIGTERM');await child.exited;sidecar.stop(true);rmSync(dir,{recursive:true,force:true});}
},10000);
