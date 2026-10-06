import {expect,test} from 'bun:test';
import {cpSync,existsSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {withCaptureQuotaFixture} from './qa/capture-quota-fixture';

const repository=resolve(import.meta.dir,'../../..');
const retainedAudio=Buffer.alloc(364);
retainedAudio.write('RIFF');retainedAudio.writeUInt32LE(356,4);retainedAudio.write('WAVEfmt ',8);
retainedAudio.writeUInt32LE(16,16);retainedAudio.writeUInt16LE(1,20);retainedAudio.writeUInt16LE(1,22);
retainedAudio.writeUInt32LE(16000,24);retainedAudio.writeUInt32LE(32000,28);
retainedAudio.writeUInt16LE(2,32);retainedAudio.writeUInt16LE(16,34);
retainedAudio.write('data',36);retainedAudio.writeUInt32LE(320,40);

async function withServer(limit:number,retainingHelper:boolean,run:(fixture:{root:string;request:(path:string,body?:unknown)=>Promise<{status:number;body:any}>;restart:()=>Promise<void>})=>Promise<void>){
 const temporary=mkdtempSync(join(tmpdir(),'heed-capture-start-quota-')),root=join(temporary,'app');
 mkdirSync(root);writeFileSync(join(root,'config.json'),JSON.stringify({storage_limit_bytes:limit}));
 let source=repository;
 if(retainingHelper){
  source=join(temporary,'source');mkdirSync(join(source,'packages'),{recursive:true});
  for(const name of ['server','shared'])cpSync(join(repository,'packages',name),join(source,'packages',name),{recursive:true,filter:path=>!path.includes('node_modules')&&!path.endsWith('.test.ts')});
  cpSync(join(repository,'config'),join(source,'config'),{recursive:true});
  for(const name of ['package.json','VERSION'])cpSync(join(repository,name),join(source,name));
  const binary=join(source,'packages/transcription/native/heed-parakeet/.build/release/heed-syscap');
  mkdirSync(resolve(binary,'..'),{recursive:true});
  writeFileSync(binary,`#!${process.execPath}\nimport {readFileSync,writeFileSync} from 'node:fs';import {join} from 'node:path';
const snapshot=JSON.parse(readFileSync(join(process.env.HEED_APP_DIR,'recording-manifest.json'),'utf8')).snapshot;
writeFileSync(snapshot.path,Buffer.from(${JSON.stringify(retainedAudio.toString('base64'))},'base64'));
writeFileSync(join(process.env.HEED_APP_DIR,'library/staging','capture-'+snapshot.meetingId,'checkpoint.txt'),'Retained synthetic capture checkpoint');
console.error(JSON.stringify({error:'Synthetic startup failure after retained audio'}));\n`,{mode:0o700});
 }
 const sidecar=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>Response.json({service:'heed-transcription',whisper:true,warm:true,models:[]})});
 let app:Bun.Subprocess|undefined,base='',diagnostics:Promise<string>|undefined;
 const stop=async()=>{if(app){app.kill();await app.exited;app=undefined;await diagnostics;}};
 const start=async()=>{
  const lease=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response()});base=`http://127.0.0.1:${lease.port}`;lease.stop(true);
  const env:Record<string,string|undefined>={...process.env,PORT:base.split(':').at(-1)!,HEED_APP_DIR:root,HEED_RECORDINGS_DIR:join(root,'media'),HEED_TRANSCRIPTION_URL:`http://127.0.0.1:${sidecar.port}`,OLLAMA_HOST:`http://127.0.0.1:${sidecar.port}`};
  for(const name of ['HEED_API_PORT','HEED_UI_PORT','HEED_TRANSCRIPTION_PORT','HEED_SERVICE_CONFIG_ROOT'])delete env[name];
  app=Bun.spawn([process.execPath,join(source,'packages/server/server.ts')],{cwd:source,env,stdout:'ignore',stderr:'pipe'});
  diagnostics=new Response(app.stderr as ReadableStream<Uint8Array>).text();
  const deadline=Date.now()+8000;
  while(Date.now()<deadline&&app.exitCode===null){try{if((await fetch(`${base}/api/sessions`)).ok)return;}catch{}await Bun.sleep(25);}
  await stop();throw Error(`Isolated capture-quota server did not start: ${await diagnostics}`);
 };
 const request=async(path:string,body?:unknown)=>{
  const response=await fetch(`${base}${path}`,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  return {status:response.status,body:await response.json()};
 };
 try{await start();await run({root,request,restart:async()=>{await stop();await start();}});}
 finally{await stop();sidecar.stop(true);rmSync(temporary,{recursive:true,force:true});}
}

test('repeated quota-rejected starts remove only their abandoned capture staging',async()=>{
 await withServer(1_048_576,false,async({root,request,restart})=>{
  const staging=join(root,'library/staging');mkdirSync(join(staging,'unrelated-transfer'),{recursive:true});
  writeFileSync(join(staging,'unrelated-transfer','payload.txt'),'Pending unrelated transfer');
  const ids=new Set<string>();
  for(let index=0;index<2;index++){
   const result=await request('/api/sysrecord/start',{requestId:`quota-rejection-${index}`,mode:'mic'});
   expect(result.status).toBe(409);expect(result.body.error).toContain('insufficient space');
   const state=(await request('/api/recording/status')).body;
   expect(state).toMatchObject({state:'failed',path:null});ids.add(state.meetingId);
   expect((await request('/api/storage')).body.reservedBytes).toBe(0);
   expect(readdirSync(staging).filter(name=>name.startsWith('capture-'))).toEqual([]);
   expect(readFileSync(join(staging,'unrelated-transfer','payload.txt'),'utf8')).toBe('Pending unrelated transfer');
  }
  expect(ids.size).toBe(2);await restart();
  expect((await request('/api/recording/status')).body).toMatchObject({state:'failed',path:null});
  expect(readdirSync(staging).filter(name=>name.startsWith('capture-'))).toEqual([]);
 });
},15000);

test.skipIf(process.platform!=='darwin')('quota pressure automatically finalizes one durable meeting through real FFmpeg and releases its reservations',async()=>{
 await withCaptureQuotaFixture({sourceRoot:repository,limit:4_000_000,holdFinalization:true},async({root,temporary,request,restart,probe,finalizeCount,releaseFinalize})=>{
  const sentinel=join(root,'library/staging/unrelated-transfer');mkdirSync(sentinel,{recursive:true});
  writeFileSync(join(sentinel,'public.txt'),'Unrelated synthetic transfer');
  const result=await request('/api/sysrecord/start',{requestId:'synthetic-pressure',mode:'both'});
  expect(result.status).toBe(200);expect(result.body.recording).toBe(true);
  const initial=(await request('/api/recording/status')).body;
  expect(initial.state).toBe('recording');
  const initialLedger=JSON.parse(readFileSync(join(root,'quota-reservations.json'),'utf8'));
  const sourceAllowance=Math.floor(initialLedger.reservations[`capture-${initial.meetingId}`].bytes/4);
  let state=initial,observedFinalizing=false;const samples:any[]=[];const deadline=Date.now()+35000;
  while(Date.now()<deadline&&state.state!=='completed'){
   const usage=(await request('/api/storage')).body;samples.push(usage);
   expect(usage.usedBytes+usage.reservedBytes).toBeLessThanOrEqual(usage.limitBytes);
   if(state.state==='finalizing'&&!observedFinalizing){
    const desktop=(await request('/api/desktop/control/status')).body;
    expect(desktop.recording).toBe(false);expect(usage.reservedBytes).toBeGreaterThan(0);
    expect((await request('/api/sessions')).body).toHaveLength(0);
    expect(probe(initial.path).streams[0].channels).toBe(2);
    observedFinalizing=true;releaseFinalize();
   }
   expect(state.state).not.toBe('failed');await Bun.sleep(200);
   state=(await request('/api/recording/status')).body;
  }
  expect(state.state).toBe('completed');expect(state.meetingId).toBe(initial.meetingId);
  expect(observedFinalizing).toBe(true);
  expect(finalizeCount()).toBe(1);
  const sessions=(await request('/api/sessions')).body;
  expect(sessions).toHaveLength(1);const session=sessions[0];
  expect(session.id).toBe(initial.meetingId);expect(session.transcriptFinalized).toBe(true);
  expect(session.transcript).toBe('Public synthetic quota acceptance.');
  expect(session.language).toBe('en');expect(session.transcriptionModel).toBe('synthetic-quota-control');
  const durable=JSON.parse(readFileSync(join(root,'sessions',`${session.id}.json`),'utf8'));
  expect(durable).toMatchObject({id:session.id,transcript:session.transcript,transcriptFinalized:true,language:session.language,transcriptionModel:session.transcriptionModel,duration:session.duration,files:{wav:session.files.wav}});
  const wave=probe(session.files.wav);expect(wave.streams[0]).toMatchObject({codec_name:'pcm_s16le',sample_rate:'16000',channels:2});
  expect(readFileSync(session.files.wav).length).toBeGreaterThanOrEqual(sourceAllowance-Math.min(1_000_000,Math.floor(sourceAllowance/20)));
  expect(Number(wave.format.duration)).toBeGreaterThan(1);expect(session.duration).toBeCloseTo(Number(wave.format.duration),3);
  const hash=createHash('sha256').update(readFileSync(session.files.wav)).digest('hex');
  const desktop=(await request('/api/desktop/control/status')).body;
  expect(desktop).toMatchObject({recording:false,processing:false,quotaStopped:true});
  const usage=(await request('/api/storage')).body;expect(usage.reservedBytes).toBe(0);
  expect(usage.usedBytes+usage.reservedBytes).toBeLessThanOrEqual(usage.limitBytes);
  expect(samples.some(sample=>sample.reservedBytes>0)).toBe(true);
  const ledger=JSON.parse(readFileSync(join(root,'quota-reservations.json'),'utf8'));
  expect(ledger.reservations).toEqual({});
  expect(readdirSync(join(root,'library/staging')).filter(name=>name.startsWith('capture-'))).toEqual([]);
  expect(readFileSync(join(sentinel,'public.txt'),'utf8')).toBe('Unrelated synthetic transfer');
  const source=JSON.parse(readFileSync(join(temporary,'pcm-source.json'),'utf8'));expect(source.stopped).toBe(true);expect(source.chunks).toBeGreaterThan(10);
  expect(()=>process.kill(source.pid,0)).toThrow();
  const stopped=await request('/api/sysrecord/stop',{requestId:'already-completed',meetingId:session.id});
  expect(stopped.status).toBe(200);expect(finalizeCount()).toBe(1);
  await restart();expect((await request('/api/sessions')).body).toHaveLength(1);
  expect((await request('/api/recording/status')).body).toMatchObject({state:'completed',meetingId:session.id});
  expect((await request('/api/storage')).body.reservedBytes).toBe(0);
  expect(createHash('sha256').update(readFileSync(session.files.wav)).digest('hex')).toBe(hash);
 });
},45000);

test.skipIf(process.platform!=='darwin')('failed native startup preserves retained audio, staging and reservations for recovery',async()=>{
 await withServer(4_000_000,true,async({root,request,restart})=>{
  const result=await request('/api/sysrecord/start',{requestId:'retained-startup',mode:'mic'});
  expect(result.status).toBe(409);expect(result.body.error).toBe('Synthetic startup failure after retained audio');
  const state=(await request('/api/recording/status')).body;
  expect(state.state).toBe('failed');expect(existsSync(state.path)).toBe(true);
  expect(readFileSync(state.path)).toEqual(retainedAudio);
  const checkpoint=join(root,'library/staging',`capture-${state.meetingId}`,'checkpoint.txt');
  expect(readFileSync(checkpoint,'utf8')).toBe('Retained synthetic capture checkpoint');
  const reserved=(await request('/api/storage')).body.reservedBytes;expect(reserved).toBeGreaterThan(0);
  expect((await request('/api/sysrecord/start',{requestId:'blocked-by-retained-audio',mode:'mic'})).status).toBe(409);
  await restart();expect((await request('/api/recording/status')).body).toMatchObject({state:'failed',path:state.path,meetingId:state.meetingId});
  expect(readFileSync(state.path)).toEqual(retainedAudio);expect(readFileSync(checkpoint,'utf8')).toBe('Retained synthetic capture checkpoint');
  expect((await request('/api/storage')).body.reservedBytes).toBe(reserved);
 });
},15000);
