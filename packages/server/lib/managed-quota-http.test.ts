import {afterAll,beforeAll,expect,test} from 'bun:test';
import {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';

let root:string,base:string,app:ReturnType<typeof Bun.spawn>;
async function start(){
 const port=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response()});base=`http://127.0.0.1:${port.port}`;port.stop(true);
 app=Bun.spawn([process.execPath,resolve(import.meta.dir,'../server.ts')],{cwd:resolve(import.meta.dir,'../../..'),env:{...process.env,PORT:base.split(':').at(-1)!,HEED_APP_DIR:root,HEED_RECORDINGS_DIR:join(root,'media')},stdout:'ignore',stderr:'pipe'});
 const deadline=Date.now()+8000;
 while(Date.now()<deadline){try{if((await fetch(`${base}/api/sessions`)).status===200)return;}catch{}await Bun.sleep(30);}
 throw new Error('Isolated quota server did not become ready');
}
async function request(path:string,body?:unknown,origin?:string){const response=await fetch(`${base}/api/storage${path}`,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...(origin?{Origin:origin}:{})},body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,body:response.status===403?null:await response.json().catch(()=>({}))};}
beforeAll(async()=>{root=mkdtempSync(join(tmpdir(),'heed-quota-http-'));mkdirSync(join(root,'media'));await start();},10000);
afterAll(async()=>{app?.kill();if(app)await app.exited;rmSync(root,{recursive:true,force:true});});
test('settings persist the decimal default, preserve changes after restart, and reject hostile origins/invalid limits',async()=>{
 expect((await request('')).status).toBe(200);expect((await request('')).body.limitBytes).toBe(2_000_000_000);
 expect(JSON.parse(readFileSync(join(root,'config.json'),'utf8')).storage_limit_bytes).toBe(2_000_000_000);
 expect((await request('/preview',{limitBytes:3_000_000_000},'https://outside.example')).status).toBe(403);
 for(const limitBytes of [0,-1,1.5,'3000000000',Number.MAX_SAFE_INTEGER])expect((await request('/preview',{limitBytes})).status).toBe(400);
 const preview=await request('/preview',{limitBytes:3_000_000_000});expect(preview.status).toBe(200);
 expect((await request('/settings',{limitBytes:3_000_000_000,token:preview.body.token})).status).toBe(200);
 app.kill();await app.exited;await start();expect((await request('')).body.limitBytes).toBe(3_000_000_000);
});
test('reductions review eligible local media and protect transcripts; changed previews fail closed',async()=>{
 writeFileSync(join(root,'media','old.wav'),'x'.repeat(1_100_000));
 const created=await fetch(`${base}/api/sessions`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:'quota-text',transcript:'x'.repeat(1_100_000),transcriptFinalized:true,files:{wav:join(root,'media','old.wav')}})});expect(created.status).toBe(200);
 expect((await request('/preview',{limitBytes:1_048_576})).status).toBe(409);
 const preview=await request('/preview',{limitBytes:1_500_000});expect(preview.body.removals).toHaveLength(1);
 writeFileSync(join(root,'media','later.wav'),'x');expect((await request('/settings',{limitBytes:1_500_000,token:preview.body.token})).status).toBe(409);
 expect((await request('')).body.limitBytes).toBe(3_000_000_000);
 const reviewed=await request('/preview',{limitBytes:1_500_000});expect((await request('/settings',{limitBytes:1_500_000,token:reviewed.body.token})).status).toBe(200);
 const sessions=await (await fetch(`${base}/api/sessions`)).json();expect(sessions.find((s:any)=>s.id==='quota-text')).toMatchObject({transcript:'x'.repeat(1_100_000),audioExpired:true,files:{wav:''}});

});

test('quota-blocked uploads reject before disk staging and hostile origins cannot prepare local media',async()=>{const form=new FormData();form.set('file',new File([Buffer.alloc(16000)],'synthetic.wav'));const response=await fetch(`${base}/api/transcribe`,{method:'POST',body:form});expect(response.status).toBe(409);expect((await response.json()).error).toContain('quota');expect((await request('')).body.reservedBytes).toBe(0);const external=await fetch(`${base}/api/transcribe`,{method:'POST',headers:{Origin:'https://outside.example','Content-Type':'application/json'},body:JSON.stringify({input:'synthetic.wav'})});expect(external.status).toBe(403);});

test('low-rate recovery is rejected before ASR while retained bytes remain within the chosen quota',async()=>{const file=join(root,'media','low-rate.wav'),data=49*4000*2,bytes=Buffer.alloc(44+data);bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(2,22);bytes.writeUInt32LE(4000,24);bytes.writeUInt32LE(8000,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(8,34);bytes.write('data',36);bytes.writeUInt32LE(data,40);writeFileSync(file,bytes);const before=(await request('')).body;const response=await fetch(`${base}/api/transcribe`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({input:file,recording_finalize:true})});expect(response.status).toBe(409);expect((await response.json()).error).toContain('working copies');const after=(await request('')).body;expect(after.usedBytes).toBe(before.usedBytes);expect(after.usedBytes+after.reservedBytes).toBeLessThanOrEqual(after.limitBytes);});
