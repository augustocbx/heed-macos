import {expect,test} from 'bun:test';
import {cpSync,existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';

// Real production HTTP/coordinator/FFmpeg boundary, synthetic PCM helper, no device access.
test.skipIf(process.platform!=='darwin')('final-only browser and menu capture keeps audio and final speakers with zero preview jobs, including setting changes',async()=>{
 const temporary=mkdtempSync(join(tmpdir(),'heed-real-time-http-'));
 const source=join(temporary,'source'),root=join(temporary,'app');
 mkdirSync(join(source,'packages'),{recursive:true});mkdirSync(root);
 for(const name of ['server','shared'])cpSync(resolve(import.meta.dir,'../../',name),join(source,'packages',name),{recursive:true,filter:path=>!path.includes('node_modules')&&!path.endsWith('.test.ts')});
 cpSync(resolve(import.meta.dir,'../../../config'),join(source,'config'),{recursive:true});
 for(const name of ['package.json','VERSION'])cpSync(resolve(import.meta.dir,'../../..',name),join(source,name));
 writeFileSync(join(root,'config.json'),JSON.stringify({real_time_transcription:false}));
 const binary=join(source,'packages/transcription/native/heed-parakeet/.build/release/heed-syscap');mkdirSync(resolve(binary,'..'),{recursive:true});
 writeFileSync(binary,`#!${process.execPath}
import {existsSync} from 'node:fs';import {join} from 'node:path';
const mode=process.argv.at(-1),channels=mode==='both'?2:1;
console.error(JSON.stringify({ready:true,sample_rate:16000,channels,mode}));
const pcm=Buffer.alloc(3200*channels);for(let i=0;i<1600;i++)for(let ch=0;ch<channels;ch++)pcm.writeInt16LE(Math.round(3000*Math.sin(i/8+ch)),(i*channels+ch)*2);
setInterval(()=>{if(existsSync(join(process.env.HEED_APP_DIR,'fail-capture')))process.exit(1);process.stdout.write(pcm);},100);
`,{mode:0o700});
 let sidecarPid=process.pid;const jobs:string[]=[];const configurations:boolean[]=[];let app:Bun.Subprocess|undefined;
 const sidecar=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req){
  const path=new URL(req.url).pathname;if(req.method==='POST')jobs.push(path);
  if(path==='/preview/configure')configurations.push((await req.json()).enabled);
  if(path==='/finalize')return Response.json({finalized:true,duration:2.5,language:'pt',model:'fixture-final',turns:[{speaker:'Me',channel:'mic',text:'Synthetic microphone',start:0,end:1},{speaker:'Speaker 1',channel:'sys',text:'Synthetic system',start:1,end:2.5}],embeddings:{'Speaker 1':[1,2]}});
  if(path==='/transcribe-live')return Response.json({text:'Preview fixture',language:'en',segments:[]});
  return Response.json({service:'heed-transcription',protocolVersion:1,checkoutRoot:source,pid:sidecarPid,ready:true,pyannote:true,whisper:true,warm:true,live_tuning:{mode:'chunk',chunk_s:2,interval_ms:500},models:[]});
 }});
 const lease=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response()});const base=`http://127.0.0.1:${lease.port}`;lease.stop(true);
 const request=async(path:string,body?:unknown)=>{const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,body:await response.json()};};
 try{
  const env={...process.env,PATH:'/opt/homebrew/bin:'+process.env.PATH,PORT:base.split(':').at(-1)!,HEED_APP_DIR:root,HEED_RECORDINGS_DIR:join(root,'media'),HEED_TRANSCRIPTION_URL:`http://127.0.0.1:${sidecar.port}`,OLLAMA_HOST:`http://127.0.0.1:${sidecar.port}`};
  for(const name of ['HEED_API_PORT','HEED_UI_PORT','HEED_TRANSCRIPTION_PORT','HEED_SERVICE_CONFIG_ROOT'])delete env[name];
  app=Bun.spawn([process.execPath,join(source,'packages/server/server.ts')],{cwd:source,env,stdout:'ignore',stderr:'ignore'});
  const deadline=Date.now()+8000;while(Date.now()<deadline){try{if((await fetch(base+'/api/sessions')).ok)break;}catch{}await Bun.sleep(25);}
  const start=await request('/api/desktop/control/commands',{action:'start',mode:'both',requestId:'menu-off',realTimeTranscription:true});
  expect(start.status).toBe(200);
  const active=(await request('/api/recording/status')).body;expect(active).toMatchObject({state:'recording',realTimeTranscription:false});
  const changed=await request('/api/recording/settings',{enabled:true});expect(changed.body).toMatchObject({enabled:true,activeEnabled:false,engineState:'deferred'});
  await Bun.sleep(2600);
  const stopped=await request('/api/sysrecord/stop',{requestId:'browser-stop',meetingId:active.meetingId});
  expect(stopped.status).toBe(200);expect(stopped.body.session).toMatchObject({transcriptFinalized:true,speakers:['Me','Speaker 1'],transcript:'Synthetic microphone\nSynthetic system'});
  expect(existsSync(stopped.body.path)).toBe(true);const wav=readFileSync(stopped.body.path);expect(wav.byteLength).toBeGreaterThan(100000);
  const probe=Bun.spawnSync(['ffprobe','-v','error','-show_entries','stream=channels,sample_rate','-of','json',stopped.body.path],{env});
  expect(JSON.parse(probe.stdout.toString()).streams[0]).toMatchObject({channels:2,sample_rate:'16000'});
  expect(jobs.filter(path=>!['/preview/configure','/finalize'].includes(path))).toEqual([]);
  jobs.length=0;
  const next=await request('/api/sysrecord/start',{mode:'both',requestId:'browser-on',realTimeTranscription:false});expect(next.body.snapshot.realTimeTranscription).toBe(true);
  await request('/api/recording/settings',{enabled:false});
  const until=Date.now()+6000;while(!jobs.includes('/transcribe-live') && Date.now()<until)await Bun.sleep(50);
  expect(jobs).toContain('/transcribe-live');
  const beforeRestart=configurations.length;sidecarPid++;
  const restartDeadline=Date.now()+2500;while(configurations.length===beforeRestart && Date.now()<restartDeadline)await Bun.sleep(20);
  expect(configurations.length).toBeGreaterThan(beforeRestart);expect(configurations.at(-1)).toBe(true);

  expect((await request('/api/recording/status')).body.realTimeTranscription).toBe(true);
  await request('/api/desktop/control/commands',{action:'stop',requestId:'menu-stop',meetingId:next.body.meetingId});
  await request('/api/recording/settings',{enabled:true});
  const doomed=await request('/api/sysrecord/start',{mode:'both',requestId:'capture-failure'});expect(doomed.status).toBe(200);
  await request('/api/recording/settings',{enabled:false});
  writeFileSync(join(root,'fail-capture'),'Synthetic helper failure');
  const failureDeadline=Date.now()+3000;let failed:any;
  while(Date.now()<failureDeadline){failed=(await request('/api/recording/status')).body;if(failed.state==='failed' && configurations.at(-1)===false)break;await Bun.sleep(20);}
  expect(failed).toMatchObject({state:'failed',realTimeTranscription:true});expect(existsSync(failed.path)).toBe(true);
  expect(configurations.at(-1)).toBe(false);

 }finally{app?.kill();if(app)await app.exited;sidecar.stop(true);rmSync(temporary,{recursive:true,force:true});}
},20000);
