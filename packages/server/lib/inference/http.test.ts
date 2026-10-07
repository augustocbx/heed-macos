import {afterEach,expect,test} from 'bun:test';
import {fixture,cleanupFixtures} from './connection-fixtures';
import {aiResponse} from './http';
afterEach(cleanupFixtures);
const url='http://127.0.0.1:48100/api/ai/connections';
const command=(body:unknown,origin='http://localhost:48101')=>new Request(url,{method:'POST',headers:{origin,'Content-Type':'application/json'},body:JSON.stringify(body)});
test('HTTP denies nonloopback and hostile Origin even when caller passes allowed=true',async()=>{
 const f=fixture();for(const req of [new Request('http://remote.example/api/ai/settings'),new Request('http://localhost:48100/api/ai/settings',{headers:{origin:'https://evil.example'}})]){const response=await aiResponse(req,f.manager,true);expect(response?.status).toBe(403);expect(response?.headers.get('cache-control')).toBe('no-store');}expect((await aiResponse(new Request(url),f.manager,false))?.status).toBe(403);expect(await aiResponse(new Request('http://localhost:48100/other'),f.manager,true)).toBeNull();
});
test('HTTP settings and connection commands expose only safe no-store snapshots',async()=>{
 const f=fixture();const response=await aiResponse(command({action:'register',provider:'openai',model:'gpt-6-luna',key:'HTTP_SECRET'}),f.manager,true);expect(response?.status).toBe(200);const text=await response!.text();expect(text).not.toContain('HTTP_SECRET');expect(text).not.toContain('credentialReference');const c=JSON.parse(text);expect(response?.headers.get('cache-control')).toBe('no-store');
 const settings=await aiResponse(new Request('http://localhost:48100/api/ai/settings',{method:'POST',body:JSON.stringify({feature:'chat',selection:{provider:'openai',connectionId:c.id,model:c.model}})}),f.manager,true);expect(settings?.status).toBe(200);
 expect((await aiResponse(command({action:'validate',id:c.id}),f.manager,true))?.status).toBe(200);expect((await aiResponse(command({action:'replace',id:c.id,provider:'openai',model:c.model,key:'REPLACED_SECRET'}),f.manager,true))?.status).toBe(200);expect((await aiResponse(command({action:'remove',id:c.id}),f.manager,true))?.status).toBe(200);
});
test('HTTP streams body cap and rejects unknown/runtime capability assertion fields',async()=>{
 const f=fixture();for(const body of [{action:'register',provider:'openai',model:'gpt-6-luna',key:'x'.repeat(66000)},{action:'register',provider:'openai',model:'gpt-6-luna',key:'KEY',capabilities:{}},{action:'remove',id:'invalid',meetingContent:'private'}])expect((await aiResponse(command(body),f.manager,true))?.status).toBe(400);
 let emitted=false;const req=new Request(url,{method:'POST',body:new ReadableStream({pull(controller){if(emitted)controller.close();else {emitted=true;controller.enqueue(new TextEncoder().encode(' '.repeat(65537)));}}}),duplex:'half'} as any);expect((await aiResponse(req,f.manager,true))?.status).toBe(400);
});
test('HTTP vault failure is redacted',async()=>{
 const f=fixture();f.lock(true);const response=await aiResponse(command({action:'register',provider:'openai',model:'gpt-6-luna',key:'HTTP_SECRET'}),f.manager,true);expect(response?.status).toBe(503);const text=await response!.text();expect(text).not.toContain('SECRET');expect(text).not.toContain('locked');
});
test('production client API submits write-only keys without accessing browser storage',async()=>{
 const f=fixture(),previousFetch=globalThis.fetch;const names=['localStorage','sessionStorage','indexedDB'];const descriptors=names.map(name=>Object.getOwnPropertyDescriptor(globalThis,name));let reads=0;
 try{
  for(const name of names)Object.defineProperty(globalThis,name,{configurable:true,get(){reads++;throw Error('Browser persistence is forbidden');}});
  globalThis.fetch=(async(input:Parameters<typeof fetch>[0],init?:Parameters<typeof fetch>[1])=>{const response=await aiResponse(new Request(new URL(String(input),'http://localhost:48100'),init),f.manager,true);return response??new Response(null,{status:404});}) as typeof fetch;
  const {aiApi}=await import('../../../client/src/api/ai');const c=await aiApi.register({provider:'openai',model:'gpt-6-luna',key:'BROWSER_SECRET'});expect(JSON.stringify(c)).not.toContain('BROWSER_SECRET');expect(JSON.stringify(await aiApi.settings())).not.toContain('BROWSER_SECRET');await aiApi.validate(c.id);await aiApi.replace(c.id,{provider:'openai',model:c.model,key:'NEW_BROWSER_SECRET'});await aiApi.remove(c.id);expect(reads).toBe(0);expect(f.values.size).toBe(0);
 }finally{globalThis.fetch=previousFetch;for(let i=0;i<names.length;i++){const descriptor=descriptors[i];if(descriptor)Object.defineProperty(globalThis,names[i]!,descriptor);else Reflect.deleteProperty(globalThis,names[i]!);}}
});
