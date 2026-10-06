import {cpSync,lstatSync,mkdirSync,mkdtempSync,realpathSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename,dirname,join,resolve,sep} from 'node:path';

export interface QuotaFixture {
 root:string; source:string; temporary:string; base:()=>string;
 request:(path:string,body?:unknown)=>Promise<{status:number;body:any}>;
 restart:()=>Promise<void>; finalizeCount:()=>number;
 releaseFinalize:()=>void;
 probe:(path:string)=>any;
}

export class QuotaCleanupError extends Error{
 constructor(){super('Owned quota services did not all stop; fixture retained');this.name='QuotaCleanupError';}
}
export async function finishOwnedQuotaServices(shutdowns:Array<()=>void|Promise<void>>){
 const results=await Promise.allSettled(shutdowns.map(shutdown=>Promise.resolve().then(shutdown)));
 if(results.some(result=>result.status==='rejected'))throw new QuotaCleanupError();
}

export function removeOwnedQuotaFixture(path:string,receipt:{dev:number;ino:number},options:{keep:boolean;servicesVerified:boolean}){
 const current=lstatSync(path);
 if(!current.isDirectory()||current.dev!==receipt.dev||current.ino!==receipt.ino)throw Error('Fixture cleanup authority changed; directory retained');
 if(options.keep)return 'retained-by-request';
 if(!options.servicesVerified)return 'retained-unverified';
 rmSync(path,{recursive:true});return 'removed';
}

/** Owned, synthetic source only; the production writer and server are unchanged. */
export async function withCaptureQuotaFixture(options:{sourceRoot:string;limit:number;fixtureRoot?:string;keepFixture?:boolean;includeClient?:boolean;holdFinalization?:boolean},run:(fixture:QuotaFixture)=>Promise<void>){
 const repository=realpathSync(options.sourceRoot);
 let temporary:string;
 if(options.fixtureRoot){
  const target=resolve(options.fixtureRoot),parent=realpathSync(dirname(target));
  if(parent!==dirname(target))throw Error('Fixture parent must be a physical path');
  temporary=join(parent,basename(target));mkdirSync(temporary,{mode:0o700});
 }else temporary=realpathSync(mkdtempSync(join(tmpdir(),'heed-quota-pressure-')));
 const owned=lstatSync(temporary);
 const root=join(temporary,'app'),source=join(temporary,'source');
 mkdirSync(root);mkdirSync(join(source,'packages'),{recursive:true});
 writeFileSync(join(temporary,'ownership.json'),JSON.stringify({version:1,kind:'synthetic-quota',pid:process.pid,source:repository}));
 let app:Bun.Subprocess|undefined,base='',diagnostics:Promise<string>|undefined,finalizeCount=0;
 let externallyUnverified=false;
 let releaseFinalize!:()=>void;const finalGate=new Promise<void>(done=>{releaseFinalize=done;});
 if(!options.holdFinalization)releaseFinalize();
 const probe=(path:string)=>{
  if(!realpathSync(path).startsWith(root+sep))throw Error('Fixture WAV escaped its owned root');
  const result=Bun.spawnSync(['ffprobe','-v','error','-show_streams','-show_format','-of','json',path]);
  if(result.exitCode!==0)throw Error('Real FFprobe could not decode the synthetic WAV');
  return JSON.parse(new TextDecoder().decode(result.stdout));
 };
 let sidecar:ReturnType<typeof Bun.serve>|undefined;
 const stop=async()=>{if(app){app.kill();await Promise.race([app.exited,Bun.sleep(5000).then(()=>{throw Error('Owned quota server did not stop')})]);app=undefined;await diagnostics;}};
 try{
  for(const tool of ['ffmpeg','ffprobe'])if(Bun.spawnSync([tool,'-version']).exitCode!==0)throw Error(`Required real ${tool} is unavailable`);
  writeFileSync(join(root,'config.json'),JSON.stringify({storage_limit_bytes:options.limit}));
  const inventory=Bun.spawnSync(['git','ls-files','-z','--','packages/server','packages/shared',...(options.includeClient?['packages/client']:[]),'config','package.json','VERSION'],{cwd:repository});
  if(inventory.exitCode!==0||inventory.stdout.length>2_000_000)throw Error('Public fixture source inventory unavailable');
  for(const file of new TextDecoder().decode(inventory.stdout).split('\0').filter(Boolean)){
   if(file.endsWith('.test.ts')||file.endsWith('.test.tsx'))continue;
   const original=join(repository,file),target=join(source,file);
   if(!lstatSync(original).isFile())throw Error('Public source must contain regular files');
   mkdirSync(dirname(target),{recursive:true});cpSync(original,target);
  }
  if(options.includeClient){
   symlinkSync(join(repository,'node_modules'),join(source,'node_modules'));
   symlinkSync(join(repository,'packages/client/node_modules'),join(source,'packages/client/node_modules'));
  }
  const binary=join(source,'packages/transcription/native/heed-parakeet/.build/release/heed-syscap');
  mkdirSync(dirname(binary),{recursive:true});
  writeFileSync(binary,`#!${process.execPath}
import {writeFileSync} from 'node:fs';
const receipt=${JSON.stringify(join(temporary,'pcm-source.json'))};let chunks=0,frame=0;
process.on('SIGTERM',()=>{writeFileSync(receipt,JSON.stringify({pid:process.pid,chunks,stopped:true}));process.exit(0)});
console.error(JSON.stringify({ready:true,sample_rate:16000,channels:2,mode:'both'}));
writeFileSync(receipt,JSON.stringify({pid:process.pid,chunks,stopped:false}));
for(;;){const pcm=Buffer.alloc(6400);for(let i=0;i<1600;i++,frame++){pcm.writeInt16LE(Math.round(6000*Math.sin(2*Math.PI*440*frame/16000)),i*4);pcm.writeInt16LE(Math.round(4000*Math.sin(2*Math.PI*660*frame/16000)),i*4+2)}
await Bun.write(Bun.stdout,pcm);chunks++;await Bun.sleep(100);}
`,{mode:0o700});
  sidecar=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){
   const path=new URL(request.url).pathname;
   if(path==='/finalize'){
    const body=await request.json();
    if(typeof body.work_directory!=='string'||!realpathSync(body.work_directory).startsWith(root+sep))throw Error('Finalization work escaped fixture');
    probe(body.wav_path);finalizeCount++;
    await finalGate;
    return Response.json({finalized:true,language:'en',model:'synthetic-quota-control',turns:[{speaker:'Fixture',channel:'mic',text:'Public synthetic quota acceptance.',start:0,end:1}]});
   }
   if(path==='/health')return Response.json({service:'heed-transcription',whisper:true,warm:true,models:[],live_tuning:{chunk_s:60,interval_ms:60000,mode:'chunk',model:'synthetic-quota-control'}});
   return Response.json({turns:[],text:'',models:[]});
  }});
  const start=async()=>{
   if(!base){const lease=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response()});base=`http://127.0.0.1:${lease.port}`;lease.stop(true);}
   const env:Record<string,string|undefined>={...process.env,PORT:base.split(':').at(-1)!,HEED_APP_DIR:root,HEED_RECORDINGS_DIR:join(root,'media'),HEED_TRANSCRIPTION_URL:`http://127.0.0.1:${sidecar!.port}`,OLLAMA_HOST:`http://127.0.0.1:${sidecar!.port}`};
   for(const name of ['HEED_API_PORT','HEED_UI_PORT','HEED_TRANSCRIPTION_PORT','HEED_SERVICE_CONFIG_ROOT'])delete env[name];
   app=Bun.spawn([process.execPath,join(source,'packages/server/server.ts')],{cwd:source,env,stdout:'ignore',stderr:'pipe'});
   diagnostics=new Response(app.stderr as ReadableStream<Uint8Array>).text();
   const deadline=Date.now()+8000;
   while(Date.now()<deadline&&app.exitCode===null){try{if((await fetch(`${base}/api/sessions`)).ok)return;}catch{}await Bun.sleep(25);}
   await stop();throw Error(`Isolated quota server did not start: ${await diagnostics}`);
  };
  const request=async(path:string,body?:unknown)=>{
   const response=await fetch(`${base}${path}`,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
   return {status:response.status,body:await response.json()};
  };
  await start();await run({root,source,temporary,base:()=>base,request,restart:async()=>{await stop();await start();},finalizeCount:()=>finalizeCount,releaseFinalize,probe});
 }catch(error){
  externallyUnverified=error instanceof QuotaCleanupError;throw error;
 }finally{
  releaseFinalize();
  await finishOwnedQuotaServices([stop,()=>{sidecar?.stop(true);}]);
  for(const port of [base?Number(new URL(base).port):undefined,sidecar?.port])if(port){
   try{const lease=Bun.serve({hostname:'127.0.0.1',port,fetch:()=>new Response()});lease.stop(true);}
   catch{throw new QuotaCleanupError();}
  }
  // Only the receipt-created temporary directory is removed.
  removeOwnedQuotaFixture(temporary,owned,{keep:!!options.keepFixture,servicesVerified:!externallyUnverified});
 }
}
