import {afterAll, beforeAll, expect, test} from 'bun:test';
import {mkdtempSync, mkdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';

let directory:string;
let app:ReturnType<typeof Bun.spawn>;
let transport:ReturnType<typeof Bun.serve>;
let base:string;
const permissions={microphone:'authorized',screenCapture:false,slackLogs:null,slackAutoRecord:false};
const build={version:'1.0.0',commit:null,instanceId:'synthetic-menu'};
async function request(path:string,body?:unknown) {
 const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
 return {status:response.status,body:await response.json()};
}
beforeAll(async()=>{
 directory=mkdtempSync(join(tmpdir(),'heed-permission-http-'));mkdirSync(join(directory,'media'));
 transport=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>Response.json({whisper:true,models:[]})});
 const reservation=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response()});
 base=`http://127.0.0.1:${reservation.port}`;reservation.stop(true);
 app=Bun.spawn([process.execPath,resolve(import.meta.dir,'../server.ts')],{cwd:resolve(import.meta.dir,'../../..'),env:{...process.env,PORT:base.split(':').at(-1)!,HEED_APP_DIR:directory,HEED_RECORDINGS_DIR:join(directory,'media'),HEED_TRANSCRIPTION_URL:`http://127.0.0.1:${transport.port}`,OLLAMA_HOST:`http://127.0.0.1:${transport.port}`},stdout:'ignore',stderr:'ignore'});
 const deadline=Date.now()+8000;
 while(Date.now()<deadline){try{if((await request('/api/desktop/permissions')).status===200)return;}catch{}await Bun.sleep(30);}
 throw Error('Isolated permission server did not start');
},10000);
afterAll(async()=>{app?.kill();if(app)await app.exited;transport?.stop(true);if(directory)rmSync(directory,{recursive:true,force:true});});

test('HTTP recovery rejects legacy and maintenance, queues one supported request, and preserves actual denied access',async()=>{
 expect((await request('/api/desktop/permissions',{action:'recoverScreenCapture'})).status).toBe(409);
 await request('/api/desktop/permissions/report',{permissions,build});
 expect((await request('/api/desktop/permissions',{action:'recoverScreenCapture'})).status).toBe(409);
 await request('/api/desktop/permissions/report',{permissions,build,recoverySupported:true});
 expect((await request('/api/desktop/permissions')).body.recoveryAvailable).toBe(true);
 const maintenance=await request('/api/recording/maintenance?summary=1',{acquire:true,owner:'synthetic-recovery-test'});
 expect(maintenance.body).toEqual({maintenance:true,maintenanceProtocol:2,updateTransactionId:null});
 expect((await request('/api/desktop/permissions',{action:'recoverScreenCapture'})).status).toBe(409);
 expect((await request('/api/recording/maintenance?summary=1',{acquire:false,owner:'another-owner'})).status).toBe(409);
 expect((await request('/api/desktop/permissions')).body.recoveryAvailable).toBe(false);
 await request('/api/recording/maintenance?summary=1',{acquire:false,owner:'synthetic-recovery-test'});
 const queued=await request('/api/desktop/permissions',{action:'recoverScreenCapture'});
 expect(queued.status).toBe(200);
 expect((await request('/api/desktop/permissions',{action:'recoverScreenCapture'})).status).toBe(409);
 const summary=(await request('/api/desktop/control/status?summary=1')).body;
 expect(Object.keys(summary).sort()).toEqual(['recording','processing','starting','pending','audioWork','maintenance','maintenanceProtocol','processingKinds','updateTransactionId','permissionRequest'].sort());
 expect(summary.permissionRequest).toEqual({id:queued.body.id,action:'recoverScreenCapture'});
 await request('/api/desktop/permissions/report',{permissions,build:{...build,instanceId:'replacement-menu'},recoverySupported:true,commandId:queued.body.id});
 const result=(await request('/api/desktop/permissions')).body;
 expect(result.pending).toBe(false);expect(result.permissions.screenCapture).toBe(false);expect(result.recoveryAvailable).toBe(true);
});
