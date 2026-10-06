import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {atomicWriteJson} from '../atomic-json';

test('disabled unresolved Google intent is preserved after restart while local transcripts and sole audio remain available',async()=>{
 const root=mkdtempSync(join(tmpdir(),'heed-google-recovery-http-')),journal=join(root,'library/catalog/google-drive'),recordings=join(root,'recordings'),credentialRef=randomUUID(),connectionId=randomUUID(),folder={id:'synthetic-folder',name:'Synthetic library',destinationId:randomUUID(),canUpload:true};mkdirSync(journal,{recursive:true});mkdirSync(recordings);const wav=join(recordings,'sole.wav');writeFileSync(wav,Buffer.alloc(1200000));
 atomicWriteJson(join(root,'google-drive.json'),{version:1,generation:2,connectionId,credentialRef,clientId:'registered.apps.googleusercontent.com',accessMode:'existing-readwrite',folder});
 atomicWriteJson(join(journal,'settings-intent.json'),{version:1,intent:{action:'select',selection:{generation:1,connectionId,credentialRef,folder:{...folder,canUpload:false}},protection:{version:1,pending:{},acknowledged:{}},currentId:null,preferredId:null}});
 const sidecar=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>Response.json({whisper:true})});let child:ReturnType<typeof Bun.spawn>|undefined,base='';
 async function start(){const port=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response()});base=`http://127.0.0.1:${port.port}`;port.stop(true);child=Bun.spawn([process.execPath,resolve(import.meta.dir,'../../server.ts')],{cwd:resolve(import.meta.dir,'../../../..'),env:{...process.env,PORT:base.split(':').at(-1)!,HEED_APP_DIR:root,HEED_RECORDINGS_DIR:recordings,HEED_TRANSCRIPTION_URL:`http://127.0.0.1:${sidecar.port}`},stdout:'ignore',stderr:'ignore'});for(let attempt=0;attempt<150;attempt++){try{if((await fetch(base+'/api/sessions')).ok)return;}catch{}await Bun.sleep(30);}throw new Error('Isolated recovery server did not become ready');}
 const post=(path:string,body:unknown,origin?:string)=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',...(origin?{Origin:origin}:{})},body:JSON.stringify(body)});
 try{await start();expect((await post('/api/sessions',{id:'local-only',title:'Synthetic',transcript:'LOCAL_SYNTHETIC_ONLY',transcriptFinalized:true,files:{wav}})).status).toBe(200);
 for(let iteration=0;iteration<2;iteration++){
  const status=await fetch(base+'/api/google-drive');expect(status.status).toBe(503);expect((await status.json()).code).toBe('oauth-configuration-pending');
  expect((await post('/api/google-drive',{action:'enable',expectedGeneration:2,expectedConnectionId:connectionId,expectedFolderId:folder.id})).status).toBe(503);
  expect((await fetch(base+'/api/library')).status).toBe(200);
  expect((await post('/api/library',{action:'refresh',expectedProviderId:randomUUID()})).status).toBe(409);
  expect((await post('/api/storage/preview',{limitBytes:1048576})).status).toBe(409);
  const sessions=await(await fetch(base+'/api/sessions')).json();expect(sessions.find((s:any)=>s.id==='local-only')?.transcript).toBe('LOCAL_SYNTHETIC_ONLY');expect((await fetch(base+'/api/recording/status')).status).toBe(200);expect(existsSync(wav)).toBe(true);
  expect(JSON.parse(readFileSync(join(journal,'settings-intent.json'),'utf8')).intent).not.toBeNull();
  expect((await fetch(base+'/api/library',{headers:{Origin:'https://outside.example'}})).status).toBe(403);
  child!.kill();await child!.exited;child=undefined;if(iteration===0)await start();
 }
 }finally{child?.kill();if(child)await child.exited;sidecar.stop(true);rmSync(root,{recursive:true,force:true});}
},15000);
