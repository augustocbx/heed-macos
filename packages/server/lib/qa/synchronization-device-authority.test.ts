import {test,expect} from 'bun:test';
import * as api from './synchronization-device-authority';
import {randomUUID} from 'node:crypto';
const binding={bookmark:'YQ==',account:'Yg==',identity:'1:2'};
function helper(mode:string){return Bun.spawn([process.execPath,'-e',`const mode=${JSON.stringify(mode)};let seq=0;for await(const chunk of Bun.stdin.stream()){for(const line of Buffer.from(chunk).toString().trim().split('\\n')){const req=JSON.parse(line);if(!seq++){console.log(JSON.stringify({ok:true,value:{role:'creator',binding:${JSON.stringify(binding)},generation:'${randomUUID()}'}}));if(mode==='die')process.exit(0);}else if(mode==='bad')console.log('private-helper-secret');else if(mode==='wait')await new Promise(()=>{});else{console.log(JSON.stringify({ok:true,sequence:req.sequence}));if(req.action==='close')process.exit(0);}}}`],{stdin:'pipe',stdout:'pipe',stderr:'pipe'});}
test('optional authority session checks closes and proves actual owned child exit',async()=>{
 expect(typeof api.openNativeAuthoritySession).toBe('function');const child=helper('ok');let session:any;
 try{session=await api.openNativeAuthoritySession(()=>Promise.resolve(child),{action:'qa-open-owned-authority'},undefined);await session.check();await session.close();expect(child.exitCode).toBe(0);expect(()=>process.kill(child.pid,0)).toThrow();await expect(session.check()).rejects.toThrow();}finally{if(child.exitCode===null)child.kill();await child.exited;}
});
test('helper loss aborts live proof and malformed private output is sanitized after reaping',async()=>{
 for(const mode of ['die','bad']){const child=helper(mode);try{const session=await api.openNativeAuthoritySession(()=>Promise.resolve(child),{action:'qa-open-owned-authority'},undefined);if(mode==='die'){await child.exited;await new Promise(r=>setTimeout(r,5));expect(session.signal.aborted).toBe(true);}else{let failure:any;try{await session.check();}catch(error){failure=error;}expect(failure.message).not.toContain('private-helper-secret');expect(Object.getOwnPropertyDescriptor(failure,'guardianStopped')?.value).toBe(true);}await expect(session.close()).rejects.toThrow();await child.exited;expect(()=>process.kill(child.pid,0)).toThrow();}finally{if(child.exitCode===null)child.kill();await child.exited;}}
});

test('abort waits for actual helper exit and 512 checks are a strict lifetime bound',async()=>{
 const child=helper('wait'),abort=new AbortController();try{const session=await api.openNativeAuthoritySession(()=>child,{action:'qa-open-owned-authority'},abort.signal);const checking=session.check();abort.abort();await expect(checking).rejects.toThrow();await expect(session.close()).rejects.toThrow();expect(()=>process.kill(child.pid,0)).toThrow();}finally{if(child.exitCode===null)child.kill();await child.exited;}
 const bounded=helper('ok');try{const session=await api.openNativeAuthoritySession(()=>bounded,{action:'qa-open-owned-authority'});for(let index=0;index<512;index++)await session.check();await expect(session.check()).rejects.toThrow();await expect(session.close()).rejects.toThrow();expect(()=>process.kill(bounded.pid,0)).toThrow();}finally{if(bounded.exitCode===null)bounded.kill();await bounded.exited;}
});
test('production provider byte streams and borrowed controls retain checks without raw transport',async()=>{
 const {ICloudFolderProvider}=await import('../connectors/icloud-folder');const destination=randomUUID(),generation=randomUUID(),bytes=(await import('./synchronization-integrity')).publicSynchronizationFixture('en').audio;let live=true,checks=0,writes=0;
 const handle={child:{role:'creator' as const,binding,generation},signal:new AbortController().signal,check:async()=>{checks++;if(!live)throw new Error('Original proof lost');}};
 const provider=new ICloudFolderProvider('qa','Synthetic',binding,destination,{json:async request=>request.action==='probe'?{header:{format:'heed-portable-library',schemaVersion:2,destinationId:destination},remoteChecksumVerified:false}:{},stream:async function*(){yield bytes.subarray(0,7);yield bytes.subarray(7);},write:async(_,source)=>{for await(const chunk of source)expect(chunk.length).toBeGreaterThan(0);writes++;}},undefined,2,generation);
 const guarded=api.guardedAuthorityProvider(provider,handle);
 await expect(guarded.withTransaction!({operationId:randomUUID(),deviceId:randomUUID(),kind:'publish'},async tx=>{expect(Buffer.from(await guarded.read('objects/'+'a'.repeat(64),bytes.length))).toEqual(bytes);await tx.checkpoint();live=false;await expect(tx.writePending({version:1,id:randomUUID(),deviceId:randomUUID(),revision:{libraryId:randomUUID(),meetingId:randomUUID(),revisionId:randomUUID()}})).rejects.toThrow();})).rejects.toThrow();
 expect(writes).toBe(0);expect(checks).toBeGreaterThan(4);
});

test('native optional authority rejects malformed startup before launching any helper',async()=>{
 const {PythonDirectSmbNative}=await import('../smb-direct-native');let launches=0;const native=new PythonDirectSmbNative({runner:()=>{launches++;throw new Error('private-native-sentinel');}});
 await expect(native.openAcceptanceAuthority({action:'qa-open-owned-authority',binding,spec:{},workspace:{},selectedScope:'parent',role:'participant'} as any)).rejects.toThrow();expect(launches).toBe(0);
});

test('runner rejection cannot invent a guardian stop witness',async()=>{
 let failure:any;try{await api.openNativeAuthoritySession(async()=>{throw new Error('private-startup-sentinel');},{action:'qa-open-owned-authority'});}catch(error){failure=error;}expect(failure.message).not.toContain('private-startup-sentinel');expect(Object.getOwnPropertyDescriptor(failure,'guardianStopped')).toBeUndefined();
});

test('unproven process exit cannot claim success or a stop receipt',async()=>{
 const child=helper('ok');const fake={pid:child.pid,kill:(s:any)=>child.kill(s),stdin:child.stdin,stdout:child.stdout,stderr:child.stderr,exited:new Promise<number>(()=>{})};
 try{const session=await api.openNativeAuthoritySession(()=>fake,{action:'qa-open-owned-authority'});let failure:any;try{await session.close();}catch(error){failure=error;}expect(failure).toBeDefined();expect(Object.getOwnPropertyDescriptor(failure,'guardianStopped')).toBeUndefined();}finally{if(child.exitCode===null)child.kill();await child.exited;(await import('../process')).untrack(fake);expect(()=>process.kill(child.pid,0)).toThrow();}
},10000);


test('oversized startup output reaps only its owned helper and preserves an unrelated process',async()=>{
 const unrelated=Bun.spawn([process.execPath,'-e','await new Promise(()=>{});'],{stdin:'ignore',stdout:'ignore',stderr:'ignore'});
 const owned=Bun.spawn([process.execPath,'-e',"for await(const chunk of Bun.stdin.stream()){console.log('x'.repeat(150001));await new Promise(()=>{});}"],{stdin:'pipe',stdout:'pipe',stderr:'pipe'});
 try{let failure:any;try{await api.openNativeAuthoritySession(()=>owned,{action:'qa-open-owned-authority'});}catch(error){failure=error;}expect(failure).toBeDefined();expect(Object.getOwnPropertyDescriptor(failure,'guardianStopped')?.value).toBe(true);expect(()=>process.kill(owned.pid,0)).toThrow();expect(unrelated.exitCode).toBeNull();expect(()=>process.kill(unrelated.pid,0)).not.toThrow();}finally{for(const child of [owned,unrelated]){if(child.exitCode===null)child.kill();await child.exited;}expect(()=>process.kill(unrelated.pid,0)).toThrow();}
});
