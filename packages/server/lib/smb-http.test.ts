import {expect,test} from 'bun:test';import {mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {SmbConnections} from './smb-connections';import {smbResponse} from './smb-http';
test('real isolated SMB HTTP controls enforce origin, strict payloads and correlated native requests',async()=>{
 const root=mkdtempSync(join(tmpdir(),'heed-smb-http-'));const library:ConstructorParameters<typeof SmbConnections>[0]['library']={selectProvider:()=>{},withProvider:async(_provider,run)=>run(library),snapshot:()=>({previews:[],imported:0,skipped:0,complete:true}),discover:async()=>{},importSelected:async()=>{},queueLocal:async()=>({revisionId:'x',state:'pending'}),publish:async()=>{}};const service=new SmbConnections({path:join(root,'smb.json'),busy:()=>false,library,native:{json:async()=>{throw new Error('private password=secret');},read:async()=>Buffer.alloc(0),stream:async function*(){},write:async()=>{}}});
 const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:req=>smbResponse(req,service)});const endpoint=`http://127.0.0.1:${server.port}/api/smb`;
 const post=(body:unknown,origin?:string)=>fetch(endpoint,{method:'POST',headers:{'content-type':'application/json',...(origin?{origin}:{})},body:JSON.stringify(body)});
 try{
  expect((await post({action:'folder'},'https://evil.example')).status).toBe(403);
  expect((await post({action:'mount',address:'smb://user:secret@server/share'})).status).toBe(400);
  expect((await post({action:'folder',password:'secret'})).status).toBe(400);
  expect((await post({action:'connect',name:'Office',receipt:'expired',create:false})).status).toBe(409);
  const request=await post({action:'folder'});expect(request.status).toBe(200);const command=service.desktopCommand()!;expect(command.action).toBe('folder');
  expect((await post({action:'desktop-report',id:'stale',folder:'/fixture/share',failed:false})).status).toBe(409);
  expect((await post({action:'desktop-report',id:command.id,folder:'/fixture/share',failed:false})).status).toBe(200);
  expect((await (await fetch(endpoint)).json()).selectedFolder).toBe('/fixture/share');
  const failure=await post({action:'test',folder:'/fixture/share'});expect(failure.status).toBe(503);expect(await failure.text()).not.toContain('secret');
 }finally{server.stop(true);service.close();rmSync(root,{recursive:true,force:true});}
});
