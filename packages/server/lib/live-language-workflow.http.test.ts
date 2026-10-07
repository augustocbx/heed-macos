import {createHash} from 'node:crypto';
import {expect,test} from 'bun:test';
import {cpSync,existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';

// Real production HTTP/coordinator/FFmpeg boundary, synthetic PCM helper, no device access.
test.skipIf(process.platform!=='darwin')('PT workflow preserves corrected accepted source and recovers final-only without live inference',async()=>{
 const temporary=mkdtempSync(join(tmpdir(),'heed-real-time-http-'));
 const source=join(temporary,'source'),root=join(temporary,'app');
 mkdirSync(join(source,'packages'),{recursive:true});mkdirSync(root);
 for(const name of ['server','shared'])cpSync(resolve(import.meta.dir,'../../',name),join(source,'packages',name),{recursive:true,filter:path=>!path.includes('node_modules')&&!path.endsWith('.test.ts')});
 cpSync(resolve(import.meta.dir,'../../../config'),join(source,'config'),{recursive:true});
 for(const name of ['package.json','VERSION'])cpSync(resolve(import.meta.dir,'../../..',name),join(source,name));
 writeFileSync(join(root,'config.json'),JSON.stringify({real_time_transcription:true,live_speech_language:"pt",automatic_notes:{enabled:false}}));
 const binary=join(source,'packages/transcription/native/heed-parakeet/.build/release/heed-syscap');mkdirSync(resolve(binary,'..'),{recursive:true});
 writeFileSync(binary,`#!${process.execPath}
import {existsSync} from 'node:fs';import {join} from 'node:path';
const mode=process.argv.at(-1),channels=mode==='both'?2:1;
console.error(JSON.stringify({ready:true,sample_rate:16000,channels,mode}));
const pcm=Buffer.alloc(3200*channels);for(let i=0;i<1600;i++)for(let ch=0;ch<channels;ch++)pcm.writeInt16LE(Math.round(3000*Math.sin(i/8+ch)),(i*channels+ch)*2);
setInterval(()=>{if(existsSync(join(process.env.HEED_APP_DIR,'fail-capture')))process.exit(1);process.stdout.write(pcm);},100);
`,{mode:0o700});
 let failFinal=false;let failLive=false;const observer=new AbortController();let events="";let sidecarPid=process.pid;const jobs:string[]=[];const configurations:any[]=[];const asr:any[]=[];let usedModel="base";let app:Bun.Subprocess|undefined;
 const sidecar=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req){
  const path=new URL(req.url).pathname;if(req.method==='POST')jobs.push(path);
  if(path==='/preview/configure')configurations.push(await req.json());
  if(path==='/finalize' && failFinal){failFinal=false;return Response.json({error:'Synthetic final failure'},{status:503});}
  if(path==='/finalize')return Response.json({finalized:true,duration:2.5,language:'pt',model:'fixture-final',turns:[{speaker:'Me',channel:'mic',text:'Synthetic microphone',start:0,end:1},{speaker:'Speaker 1',channel:'sys',text:'Synthetic system',start:1,end:2.5}],embeddings:{'Speaker 1':[1,2]}});
  if(path==='/transcribe-live'){const body=await req.json();asr.push(body);if(failLive)return Response.json({error:'Synthetic live model failure'},{status:503});const model=usedModel;usedModel='tiny';return Response.json({text:'Prévia em português',language:body.language,task:'transcribe',engine:'mlx',model,modelIdentity:'mlx:mlx-community/whisper-'+model+'-mlx',gov:{live_model:'tiny',interval_ms:500,changed:model!=='tiny'},segments:[]});}
  const speech={engine:'mlx',model:usedModel,modelIdentity:'mlx:mlx-community/whisper-'+usedModel+'-mlx',modelRevision:null,state:'loaded',supportedLanguages:['en','pt'],automatic:{modelSupported:true,pipelineAvailable:true,offered:false},mixedLanguage:'unverified',mode:'chunk',adaptiveModels:[{model:'base',modelIdentity:'mlx:mlx-community/whisper-base-mlx',languages:['en','pt']},{model:'tiny',modelIdentity:'mlx:mlx-community/whisper-tiny-mlx',languages:['en','pt']}]};
  return Response.json({service:'heed-transcription',protocolVersion:1,checkoutRoot:source,pid:sidecarPid,ready:true,pyannote:true,whisper:true,warm:true,live_tuning:{mode:'chunk',chunk_s:2,interval_ms:500},models:[],languageCapabilities:{schemaVersion:1,capabilityKey:(usedModel==='base'?'a':'b').repeat(64),live:speech,final:{...speech,engine:'parakeet',model:'parakeet-v3',modelIdentity:'parakeet:FluidAudio/parakeet-tdt-0.6b-v3',mode:'full',adaptiveModels:[]}}});
 }});
 const lease=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response()});const base=`http://127.0.0.1:${lease.port}`;lease.stop(true);
 const request=async(path:string,body?:unknown)=>{const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,body:await response.json()};};
 try{
  const env={...process.env,PATH:'/opt/homebrew/bin:'+process.env.PATH,PORT:base.split(':').at(-1)!,HEED_APP_DIR:root,HEED_RECORDINGS_DIR:join(root,'media'),HEED_TRANSCRIPTION_URL:`http://127.0.0.1:${sidecar.port}`,OLLAMA_HOST:`http://127.0.0.1:${sidecar.port}`};
  for(const name of ['HEED_API_PORT','HEED_UI_PORT','HEED_TRANSCRIPTION_PORT','HEED_SERVICE_CONFIG_ROOT'])delete env[name];
  app=Bun.spawn([process.execPath,join(source,'packages/server/server.ts')],{cwd:source,env,stdout:'ignore',stderr:'ignore'});
  const deadline=Date.now()+8000;while(Date.now()<deadline){try{if((await fetch(base+'/api/sessions')).ok)break;}catch{}await Bun.sleep(25);}
  const start=await request('/api/desktop/control/commands',{action:'start',mode:'both',requestId:'menu-pt'});
  expect(start.status,JSON.stringify(start.body).slice(0,1024)).toBe(200);
  const active=(await request('/api/recording/status')).body;
  expect(active).toMatchObject({state:'recording',liveSpeechLanguage:'pt',liveOptions:{effectiveLanguage:'pt',engine:'mlx',initialModel:'base',mode:'chunk'}});
  const liveResponse=await fetch(base+'/api/sysrecord/live',{signal:observer.signal});
  const reader=liveResponse.body!.getReader();
  void(async()=>{try{while(true){const chunk=await reader.read();if(chunk.done)break;events+=new TextDecoder().decode(chunk.value);}}catch{}})();
  await request('/api/recording/settings',{liveLanguage:'en',enabled:false});
  const until=Date.now()+6000;while(asr.length<2&&Date.now()<until)await Bun.sleep(50);
  expect(asr.length).toBeGreaterThanOrEqual(2);expect(asr.every(call=>call.language==='pt'&&call.task==='transcribe')).toBe(true);
  expect(asr.some(call=>call.wav_path.includes('sys'))).toBe(true);
  failLive=true;
  const liveFailureDeadline=Date.now()+3500;
  while(!events.includes('"reason":"unavailable"') && Date.now()<liveFailureDeadline)await Bun.sleep(25);
  expect(events).toContain('"reason":"unavailable"');
  expect((await request('/api/recording/status')).body).toMatchObject({state:'recording'});
  expect((await request('/api/recording/status')).body.segments.length).toBeGreaterThan(0);
  failLive=false;
  const beforeRestart=configurations.length;sidecarPid++;
  const restarted=Date.now()+2500;while(configurations.length===beforeRestart&&Date.now()<restarted)await Bun.sleep(20);
  expect(configurations.length).toBeGreaterThan(beforeRestart);expect(configurations.at(-1)).toMatchObject({enabled:true,liveOptions:{effectiveLanguage:'pt',engine:'mlx',initialModel:'base'}});
  const stopped=await request('/api/sysrecord/stop',{requestId:'browser-stop',meetingId:active.meetingId});
  expect(stopped.status).toBe(200);expect(stopped.body.session).toMatchObject({transcriptFinalized:true,language:'pt',speakers:['Me','Speaker 1'],transcript:'Synthetic microphone\nSynthetic system'});
  expect(stopped.body.liveOptions.initialModel).toBe('base');expect(stopped.body.session.liveModel).toBe('tiny');
  const wav=readFileSync(stopped.body.path);expect(wav.byteLength).toBeGreaterThan(100000);
  const saved=stopped.body.session;
  const digest=createHash('sha256').update(wav).digest('hex');
  const correction={requestId:'correct-pt',action:'edit',target:{kind:'segment',index:1},text:'Decisão corrigida',expectedTranscriptRevision:saved.transcriptRevision,expectedTranscriptVersion:saved.transcriptVersion};
  const edited=await request(`/api/sessions/${saved.id}/transcript/commands`,correction);
  expect(edited.status).toBe(200);expect(edited.body.transcript).toBe('Synthetic microphone\nDecisão corrigida');
  expect(edited.body.segments[1]).toMatchObject({speaker:'Speaker 1',channel:'sys',start:1,end:2.5});
  expect(edited.body).toMatchObject({language:'pt',transcriptionModel:'fixture-final',liveModel:'tiny',embeddings:{'Speaker 1':[1,2]}});
  expect(edited.body.transcriptEditing.generations[0].segments[1].text).toBe('Synthetic system');
  const duplicate=await request('/api/sysrecord/stop',{requestId:'browser-stop',meetingId:active.meetingId});
  expect(duplicate.status).toBe(200);expect(duplicate.body.session.transcript).toBe(edited.body.transcript);
  const status=(await request('/api/recording/status')).body;
  expect(status.session.transcript).toBe(edited.body.transcript);expect(status.segments[1].text).toBe('Decisão corrigida');
  expect((await request(`/api/sessions/${saved.id}/transcript/commands`,correction)).body.transcriptVersion).toBe(edited.body.transcriptVersion);
  expect(createHash('sha256').update(readFileSync(stopped.body.path)).digest('hex')).toBe(digest);
  expect((await request('/api/sessions')).body.filter((item:any)=>item.id===saved.id)).toHaveLength(1);
  const next=await request('/api/sysrecord/start',{mode:'mic',requestId:'next-off'});expect(next.body).toMatchObject({realTimeTranscription:false,liveSpeechLanguage:'en',liveOptions:{effectiveLanguage:null}});
  const count=asr.length;await Bun.sleep(600);expect(asr.length).toBe(count);
  failFinal=true;
  const failure=await request('/api/sysrecord/stop',{requestId:'next-stop',meetingId:next.body.meetingId});
  expect(failure.status).toBe(409);
  expect((await request('/api/recording/status')).body).toMatchObject({state:'failed',realTimeTranscription:false});
  const retry=await request('/api/recording/retry',{requestId:'next-retry',meetingId:next.body.meetingId});
  expect(retry.status).toBe(200);expect(retry.body.state).toBe('completed');expect(retry.body.session.transcriptFinalized).toBe(true);
  expect(asr.length).toBe(count);expect((await request('/api/recording/status')).body.liveOptions.effectiveLanguage).toBeNull();
 }finally{observer.abort();app?.kill();if(app)await app.exited;sidecar.stop(true);rmSync(temporary,{recursive:true,force:true});}
},30000);
