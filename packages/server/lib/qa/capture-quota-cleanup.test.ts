import {expect,test} from 'bun:test';
import {existsSync,lstatSync,mkdtempSync,readFileSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {finishOwnedQuotaServices,QuotaCleanupError,removeOwnedQuotaFixture,withCaptureQuotaFixture} from './capture-quota-fixture';

test('failed API shutdown still closes its independent sidecar and retains the owned fixture',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'heed-quota-cleanup-'));
 const file=join(directory,'public-diagnostic.txt');writeFileSync(file,'Retained synthetic diagnostic');
 const sidecar=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response('synthetic')});
 const port=sidecar.port;
 try{
  let cleaned=false;
  try{
   await finishOwnedQuotaServices([()=>{throw Error('Owned API exit was not verified');},()=>{sidecar.stop(true);}]);
   cleaned=true;removeOwnedQuotaFixture(directory,lstatSync(directory),{keep:false,servicesVerified:true});
  }catch{}
  expect(cleaned).toBe(false);expect(readFileSync(file,'utf8')).toBe('Retained synthetic diagnostic');
  const lease=Bun.serve({hostname:'127.0.0.1',port,fetch:()=>new Response()});lease.stop(true);
 }finally{sidecar.stop(true);rmSync(directory,{recursive:true,force:true});}
});

test('a parent fixture is retained when browser or any owned service exit is unverified',()=>{
 const directory=mkdtempSync(join(tmpdir(),'heed-quota-parent-'));
 const file=join(directory,'public.txt');writeFileSync(file,'Public fixture');
 try{
  expect(removeOwnedQuotaFixture(directory,lstatSync(directory),{keep:false,servicesVerified:false})).toBe('retained-unverified');
  expect(existsSync(file)).toBe(true);expect(readFileSync(file,'utf8')).toBe('Public fixture');
 }finally{rmSync(directory,{recursive:true,force:true});}
});

test('successful independent shutdowns allow receipt-checked fixture cleanup',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'heed-quota-clean-'));const receipt=lstatSync(directory);
 let browserClosed=false,uiStopped=false;
 await finishOwnedQuotaServices([async()=>{browserClosed=true;},async()=>{uiStopped=true;}]);
 expect(browserClosed&&uiStopped).toBe(true);
 expect(removeOwnedQuotaFixture(directory,receipt,{keep:false,servicesVerified:true})).toBe('removed');
 expect(existsSync(directory)).toBe(false);
});

test('a caller browser cleanup failure retains the child fixture after its API and sidecar stop',async()=>{
 const parent=realpathSync(mkdtempSync(join(tmpdir(),'heed-quota-external-cleanup-'))),fixtureRoot=join(parent,'child');
 let apiPort=0,sidecarPort=0;
 try{
  await expect(withCaptureQuotaFixture({sourceRoot:resolve(import.meta.dir,'../../../..'),limit:4_000_000,fixtureRoot},async fixture=>{
   apiPort=Number(new URL(fixture.base()).port);
   const services=(await fixture.request('/.well-known/heed-services')).body;
   sidecarPort=services.find((service:any)=>service.service==='transcription').port;
   writeFileSync(join(fixture.temporary,'public-diagnostic.txt'),'Retained browser cleanup diagnostic');
   throw new QuotaCleanupError();
  })).rejects.toThrow('fixture retained');
  expect(readFileSync(join(fixtureRoot,'public-diagnostic.txt'),'utf8')).toBe('Retained browser cleanup diagnostic');
  for(const port of [apiPort,sidecarPort]){const lease=Bun.serve({hostname:'127.0.0.1',port,fetch:()=>new Response()});lease.stop(true);}
 }finally{rmSync(parent,{recursive:true,force:true});}
},10000);
