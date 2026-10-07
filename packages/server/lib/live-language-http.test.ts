import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
let directory:string,base:string,app:Bun.Subprocess,sidecar:ReturnType<typeof Bun.serve>;
let capabilities:any=null;const configured:any[]=[];
const request=async(path:string,body?:unknown)=>{const response=await fetch(base+path,{method:body===undefined?"GET":"POST",headers:{"content-type":"application/json"},body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,body:await response.json()};};
async function start(){
 app=Bun.spawn([process.execPath,resolve(import.meta.dir,"../server.ts")],{cwd:resolve(import.meta.dir,"../../.."),env:{...process.env,PORT:base.split(":").at(-1)!,HEED_APP_DIR:directory,HEED_RECORDINGS_DIR:join(directory,"recordings"),HEED_TRANSCRIPTION_URL:"http://127.0.0.1:"+sidecar.port,OLLAMA_HOST:"http://127.0.0.1:"+sidecar.port},stdout:"ignore",stderr:"ignore"});
 const until=Date.now()+8000;while(Date.now()<until){try{if((await fetch(base+"/api/sessions")).ok)return;}catch{}await Bun.sleep(25);}throw Error("Isolated language API did not start");
}
beforeAll(async()=>{
 directory=mkdtempSync(join(tmpdir(),"heed-language-http-"));writeFileSync(join(directory,"config.json"),JSON.stringify({ui_locale:"pt-BR",futureConfig:{keep:true},real_time_transcription:false}));
 sidecar=Bun.serve({hostname:"127.0.0.1",port:0,async fetch(req){if(new URL(req.url).pathname==="/preview/configure"){configured.push(await req.json());return Response.json({ok:true});}return Response.json({service:"heed-transcription",protocolVersion:1,checkoutRoot:resolve(import.meta.dir,"../../.."),pid:process.pid,ready:true,whisper:true,pyannote:true,warm:true,languageCapabilities:capabilities});}});
 const reserve=Bun.serve({hostname:"127.0.0.1",port:0,fetch:()=>new Response()});base="http://127.0.0.1:"+reserve.port;reserve.stop(true);await start();
});
afterAll(async()=>{app?.kill();if(app)await app.exited;sidecar?.stop(true);if(directory)rmSync(directory,{recursive:true,force:true});});
test("settings persist speech independently from interface locale across restart and reject malformed fields",async()=>{
 expect((await request("/api/recording/settings")).body.liveLanguage).toBe("en");
 const saved=await request("/api/recording/settings",{enabled:false,liveLanguage:"pt"});expect(saved.status).toBe(200);expect(saved.body).toMatchObject({enabled:false,liveLanguage:"pt",activeLiveLanguage:null,appliesTo:"next-recording"});
 expect(JSON.parse(readFileSync(join(directory,"config.json"),"utf8"))).toMatchObject({ui_locale:"pt-BR",live_speech_language:"pt",real_time_transcription:false,futureConfig:{keep:true}});
 for(const body of [{},{enabled:true,language:"pt"},{liveLanguage:"auto"},{liveLanguage:"pt-BR"},{liveLanguage:2}])expect((await request("/api/recording/settings",body)).status).toBe(400);
 app.kill();await app.exited;await start();expect((await request("/api/recording/settings")).body.liveLanguage).toBe("pt");
});
test("native and browser starts reject preference overrides before capture and unsupported PT is actionable",async()=>{
 for(const field of ["language","liveLanguage","liveSpeechLanguage","realTimeTranscription","enabled"]){
  const body={requestId:"override-"+field,mode:"mic",[field]:field.includes("ranscription")||field==="enabled"?true:"en"};
  expect((await request("/api/sysrecord/start",body)).status).toBe(400);
  expect((await request("/api/desktop/control/commands",{...body,action:"start"})).status).toBe(400);
 }
 await request("/api/recording/settings",{enabled:true});const unsupported=await request("/api/sysrecord/start",{requestId:"missing-capabilities",mode:"mic"});expect(unsupported.status).toBe(409);expect(unsupported.body.code).toBe("live-capabilities-unavailable");
 expect((await request("/api/recording/status")).body.state).toBe("idle");
 const status=(await request("/api/recording/settings")).body;expect(status).toMatchObject({liveLanguage:"pt",liveLanguageState:"unavailable"});
 const path={engine:"ctranslate2",model:"base.en",modelIdentity:"ctranslate2:Systran/faster-whisper-base.en",modelRevision:null,state:"loaded",supportedLanguages:["en"],automatic:{modelSupported:false,pipelineAvailable:false,offered:false},mixedLanguage:"unverified",mode:"chunk",adaptiveModels:[]};
 capabilities={schemaVersion:1,capabilityKey:"a".repeat(64),live:path,final:{...path,model:"base",modelIdentity:"ctranslate2:Systran/faster-whisper-base",supportedLanguages:["en","pt"]}};
 const denied=await request("/api/desktop/control/commands",{requestId:"native-unsupported",action:"start",mode:"mic"});
 expect(denied).toMatchObject({status:409,body:{code:"live-language-unsupported"}});
 expect((await request("/api/recording/settings")).body).toMatchObject({enabled:true,liveLanguage:"pt",liveLanguageState:"unsupported"});
 expect((await request("/api/recording/status")).body.state).toBe("idle");
});
test("SSE observers cannot supply inference language",async()=>{
 expect((await fetch(base+"/api/sysrecord/live?lang=en")).status).toBe(400);
});
