import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
const root=realpathSync(resolve(import.meta.dir,'../../..'));
function freePort(){const probe=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response()});const port=probe.port!;probe.stop(true);return port;}
async function waitFor(url:string){for(let i=0;i<200;i++){try{const response=await fetch(url);if(response.ok)return response;}catch{}await Bun.sleep(25);}throw Error('Synthetic service did not become ready');}

test('API diagnostics reject foreign sidecar HTML/JSON, hide profiles and recover without terminating it',async()=>{
 const app=mkdtempSync(join(tmpdir(),'heed-notice-http-'));let json=false;
 const foreign=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>json?Response.json({ready:true,whisper:true,pyannote:true,whisper_info:{device:'cpu',final_model:'false-working-profile'}}):new Response('<html>unrelated application</html>')});
 const port=freePort(),ui=freePort(),transcription=freePort(),base=`http://127.0.0.1:${port}`;
 const env={...process.env,HEED_APP_DIR:app,HEED_RECORDINGS_DIR:join(app,'media'),HEED_MODEL:'',PORT:String(port),HEED_API_PORT:String(port),HEED_UI_PORT:String(ui),HEED_TRANSCRIPTION_PORT:String(transcription),HEED_TRANSCRIPTION_URL:`http://127.0.0.1:${foreign.port}`,OLLAMA_HOST:'http://127.0.0.1:1'};
 const server=Bun.spawn([process.execPath,'run','packages/server/server.ts'],{cwd:root,env,stdout:'ignore',stderr:'pipe'});
 try{
  await waitFor(base+'/.well-known/heed-service');
  for(json of [false,true]){
   const response=await fetch(base+'/.well-known/heed-services?refresh=1');expect(response.status).toBe(200);const statuses=await response.json();
   expect(statuses.find((item:any)=>item.service==='api').state).toBe('ready');
   expect(statuses.find((item:any)=>item.service==='transcription')).toMatchObject({port:foreign.port,state:'conflict'});
   expect(JSON.stringify(statuses)).not.toMatch(/checkoutRoot|command|cwd|pid|\/private/);
   const health=await(await fetch(base+'/api/health?refresh=1')).json();expect(health.whisper).toBe(false);expect(health.whisper_info).toBeNull();expect(health.services).toEqual(statuses);
   expect((await fetch(`http://127.0.0.1:${foreign.port}`)).status).toBe(200);
  }
  expect((await fetch(base+'/.well-known/heed-services',{headers:{origin:'https://outside.example'}})).status).toBe(403);
  expect((await fetch(base+'/.well-known/heed-services',{headers:{host:'outside.example'}})).status).toBe(403);
  await foreign.stop(true);const recovered=await(await fetch(base+'/.well-known/heed-services?refresh=1')).json();expect(recovered.find((item:any)=>item.service==='transcription').state).toBe('stopped');
 }finally{server.kill('SIGTERM');await server.exited;await foreign.stop(true);rmSync(app,{recursive:true,force:true});}
},20000);

test('Node-run Vite exposes a safe conflict notice while the configured API is another application',async()=>{
 const app=mkdtempSync(join(tmpdir(),'heed-notice-vite-'));
 const foreign=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>Response.json({ready:true,application:'foreign-json'})});
 const ui=freePort(),transcription=freePort(),base=`http://127.0.0.1:${ui}`;
 const configuredApi=freePort();const env={...process.env,HEED_APP_DIR:app,PORT:String(configuredApi),HEED_API_PORT:String(configuredApi),HEED_UI_PORT:String(ui),HEED_TRANSCRIPTION_PORT:String(transcription),VITE_API_BASE:`http://127.0.0.1:${foreign.port}`};delete env.HEED_TRANSCRIPTION_URL;
 const vite=Bun.spawn(['node',join(root,'packages/client/node_modules/vite/bin/vite.js')],{cwd:join(root,'packages/client'),env,stdout:'ignore',stderr:'pipe'});
 try{
  await waitFor(base+'/.well-known/heed-service');
  const response=await fetch(base+'/.well-known/heed-services?refresh=1');expect(response.status).toBe(200);expect(response.headers.get('content-type')).toContain('application/json');const statuses=await response.json();
  expect(statuses.find((item:any)=>item.service==='api')).toMatchObject({port:foreign.port,state:'conflict'});
  expect(statuses.find((item:any)=>item.service==='ui').state).toBe('ready');
  expect(JSON.stringify(statuses)).not.toMatch(/checkoutRoot|command|cwd|pid|\/private/);
  expect((await fetch(base+'/.well-known/heed-services',{headers:{origin:'https://outside.example'}})).status).toBe(403);
  expect((await fetch(base+'/.well-known/heed-services',{headers:{host:'outside.example'}})).status).toBe(403);
  expect((await fetch(`http://127.0.0.1:${foreign.port}`)).status).toBe(200);
 }finally{vite.kill('SIGTERM');await vite.exited;await foreign.stop(true);rmSync(app,{recursive:true,force:true});}
},15000);
