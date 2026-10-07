import {afterEach, expect, test} from 'bun:test';
import {lstatSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {AiConnections} from './connections';

import {fixture, cleanupFixtures} from './connection-fixtures';
afterEach(cleanupFixtures);
const openai={provider:'openai' as const,model:'gpt-6-luna',key:'SECRET_KEY'};
const caps={features:['notes','tasks','chat','library-chat'],structuredOutput:'schema',streaming:false,contextTokens:8192,maxOutputTokens:1024,usageCategories:['inputTokens','outputTokens'],billableOutputBound:'max-output'};
const custom={provider:'compatible' as const,model:'declared-model',key:'CUSTOM_KEY',endpoint:'https://model.lan/v1/chat/completions',validationEndpoint:'https://model.lan/v1/models',trusted:true as const,capabilities:caps};

test('local defaults and selection resolve without network or Keychain',async()=>{
 const f=fixture(async()=>{throw Error('network forbidden');});f.lock(true);
 expect(Object.values(f.manager.snapshot().selections).every(s=>s.provider==='ollama')).toBe(true);
 f.manager.saveSelection('notes',{provider:'ollama',connectionId:null,model:'local-model'});
 const result=await f.manager.resolve(f.manager.snapshot().selections.notes);
 expect(result.endpoint).toBe('http://127.0.0.1:11435');expect(result.key).toBeUndefined();expect(f.values.size).toBe(0);
});
test('registration and selection never generate; validation uses content-free fixed models GET',async()=>{
 const calls:{url:string;init?:RequestInit}[]=[];const f=fixture(async(url,init)=>{calls.push({url:String(url),init});return Response.json({data:[]});});
 const c=await f.manager.register(openai);f.manager.saveSelection('chat',{provider:'openai',connectionId:c.id,model:c.model});expect(c.validation).toBe('unvalidated');expect(calls).toHaveLength(0);
 await expect(f.manager.resolve(f.manager.snapshot().selections.chat)).rejects.toThrow('connection-unvalidated');
 expect((await f.manager.validate(c.id)).validation).toBe('validated');expect(calls).toHaveLength(1);expect(calls[0].url).toBe('https://api.openai.com/v1/models');expect(calls[0].init?.method).toBe('GET');expect(calls[0].init?.body).toBeUndefined();expect(calls[0].init?.redirect).toBe('error');
 const resolved=await f.manager.resolve(f.manager.snapshot().selections.chat);expect(resolved.key).toBe(openai.key);expect(resolved.capabilities?.streaming).toBe(false);
 const serialized=JSON.stringify(f.manager.snapshot());expect(serialized).not.toContain(openai.key);expect(serialized).not.toContain('credentialReference');
 const file=join(f.root,'ai','connections.json');expect(readFileSync(file,'utf8')).not.toContain(openai.key);expect(statSync(file).mode&0o777).toBe(0o600);expect(statSync(join(f.root,'ai')).mode&0o777).toBe(0o700);
});
test('all named providers validate through content-free model discovery, never generation endpoints',async()=>{
 const calls:string[]=[];const f=fixture(async(url,init)=>{expect(init?.body).toBeUndefined();expect(init?.method).toBe('GET');calls.push(String(url));return Response.json({data:[]});});
 for(const provider of ['openai','anthropic','deepseek','xai'] as const){const c=await f.manager.register({provider,model:'unknown-model',key:'KEY'});await f.manager.validate(c.id);expect(f.manager.snapshot().connections.find(item=>item.id===c.id)?.capabilities).toBeNull();await expect(f.manager.resolve({provider,connectionId:c.id,model:c.model})).rejects.toThrow('unsupported-capability');}
 expect(calls).toEqual(['https://api.openai.com/v1/models','https://api.anthropic.com/v1/models','https://api.deepseek.com/models','https://api.x.ai/v1/models']);
});
test('custom configuration requires deliberate exact same-origin HTTPS trust including LAN',async()=>{
 const f=fixture();for(const patch of [{trusted:false},{endpoint:'http://model.lan/v1/chat/completions'},{endpoint:'https://key@model.lan/v1/chat/completions'},{endpoint:'https://model.lan/v1/chat/completions?key=x'},{validationEndpoint:'https://other.lan/models'},{validationEndpoint:undefined},{capabilities:undefined}])await expect(f.manager.register({...custom,...patch} as any)).rejects.toThrow();
 const c=await f.manager.register(custom as any);expect(c.endpoint).toBe(custom.endpoint);expect(c.validationEndpoint).toBe(custom.validationEndpoint);expect(c.trustVersion).toBe(1);
 await f.manager.validate(c.id);const r=await f.manager.resolve({provider:'compatible',connectionId:c.id,model:c.model});
 const updated=await f.manager.replace(c.id,{...custom,endpoint:'https://model.lan/new/chat/completions'} as any);expect(updated.validation).toBe('unvalidated');expect(updated.trustVersion).toBe(2);expect(()=>f.manager.assertCurrent(r.checkpoint)).toThrow('stale-connection');
});
test('replacement and removal invalidate checkpoints and recover durable pending cleanup after restart',async()=>{
 const f=fixture();let changed=0;f.manager.subscribe(()=>changed++);
 const c=await f.manager.register(openai);await f.manager.validate(c.id);const r=await f.manager.resolve({provider:'openai',connectionId:c.id,model:c.model});const oldRefs=[...f.values.keys()];
 await f.manager.replace(c.id,{...openai,key:'NEW_KEY'});expect(()=>f.manager.assertCurrent(r.checkpoint)).toThrow('stale-connection');expect(oldRefs.some(ref=>f.values.has(ref))).toBe(false);expect(changed).toBeGreaterThan(0);
 f.lock(true);await f.manager.remove(c.id);expect(f.manager.snapshot().pendingCleanup).toBe(true);expect(f.manager.snapshot().connections).toHaveLength(0);
 f.lock(false);const restarted=new AiConnections(f.options);await restarted.recover();expect(f.values.size).toBe(0);expect(restarted.snapshot().pendingCleanup).toBe(false);
});
test('replacement and removal preserve explicitly selected provider/model as unavailable',async()=>{
 const f=fixture();const c=await f.manager.register(openai);const selected={provider:'openai' as const,connectionId:c.id,model:c.model};f.manager.saveSelection('chat',selected);
 await f.manager.replace(c.id,{provider:'anthropic',model:'claude-haiku-4-5-20251001',key:'REPLACEMENT'});expect(f.manager.snapshot().selections.chat).toEqual(selected);await expect(f.manager.resolve(selected)).rejects.toThrow('invalid-request');
 await f.manager.remove(c.id);expect(f.manager.snapshot().selections.chat).toEqual(selected);await expect(f.manager.resolve(selected)).rejects.toThrow('not-found');const restarted=new AiConnections(f.options);expect(restarted.snapshot().unavailable).toBe(false);expect(restarted.snapshot().selections.chat).toEqual(selected);
});
test('late validation after removal cannot recreate a connection',async()=>{
 let release!:(r:Response)=>void;const f=fixture(()=>new Promise(resolve=>release=resolve));const c=await f.manager.register(openai);const validation=f.manager.validate(c.id);while(!release)await Bun.sleep(1);await f.manager.remove(c.id);release(Response.json({data:[]}));await expect(validation).rejects.toThrow('stale-connection');expect(f.manager.snapshot().connections).toHaveLength(0);
});
test('locked storage and provider errors never leak secrets or fall back to local',async()=>{
 const f=fixture(async()=>{throw Error('SECRET_KEY provider body');});const c=await f.manager.register(openai);expect((await f.manager.validate(c.id)).validation).toBe('failed');expect(JSON.stringify(f.manager.snapshot())).not.toContain(openai.key);
 f.lock(true);expect((await f.manager.validate(c.id)).validation).toBe('credential-unavailable');await expect(f.manager.resolve({provider:'openai',connectionId:c.id,model:c.model})).rejects.toThrow('connection-unvalidated');await expect(f.manager.register(openai)).rejects.toThrow('credential-unavailable');expect(readFileSync(join(f.root,'ai','connections.json'),'utf8')).not.toContain(openai.key);
});
test('obsolete in-flight validation cannot restore replaced connection validation',async()=>{
 let release!:(r:Response)=>void;const f=fixture(()=>new Promise(resolve=>release=resolve));const c=await f.manager.register(openai);const validation=f.manager.validate(c.id);while(!release)await Bun.sleep(1);
 await f.manager.replace(c.id,{...openai,key:'REPLACED_KEY'});release(Response.json({data:[]}));await expect(validation).rejects.toThrow('stale-connection');expect(f.manager.snapshot().connections[0].validation).toBe('unvalidated');
});
test('resolve checks credential generation after asynchronous protected lookup and feature changes',async()=>{
 const f=fixture();const c=await f.manager.register(openai);await f.manager.validate(c.id);const selection={provider:'openai' as const,connectionId:c.id,model:c.model};const resolved=await f.manager.resolve(selection);f.manager.saveSelection('notes',selection);expect(()=>f.manager.assertCurrent(resolved.checkpoint)).toThrow('stale-connection');
 let release!:(value:unknown)=>void;const oldGet=f.vault.get;f.vault.get=()=>new Promise(resolve=>release=resolve) as any;const resolving=f.manager.resolve(selection);await f.manager.replace(c.id,{...openai,key:'NEW_KEY'});release('SECRET_KEY');await expect(resolving).rejects.toThrow('stale-connection');f.vault.get=oldGet;
});
test('validation revocation permanently invalidates an earlier resolution checkpoint',async()=>{
 let rejectValidation=false;const f=fixture(async()=>rejectValidation?new Response('PRIVATE_PROVIDER_BODY',{status:401}):Response.json({data:[]}));const c=await f.manager.register(openai);await f.manager.validate(c.id);const selection={provider:'openai' as const,connectionId:c.id,model:c.model};const r=await f.manager.resolve(selection);
 rejectValidation=true;await f.manager.validate(c.id);expect(()=>f.manager.assertCurrent(r.checkpoint)).toThrow('stale-connection');rejectValidation=false;await f.manager.validate(c.id);expect(()=>f.manager.assertCurrent(r.checkpoint)).toThrow('stale-connection');
});
test('a partial vault put leaves a recoverable reference without publishing a connection or key',async()=>{
 const f=fixture();const put=f.vault.put;f.vault.put=async(value,reference)=>{await put(value,reference);f.lock(true);throw Error('SECRET_KEY interrupted after put');};await expect(f.manager.register(openai)).rejects.toThrow('credential-unavailable');expect(f.manager.snapshot().connections).toHaveLength(0);expect(f.manager.snapshot().pendingCleanup).toBe(true);expect(f.values.size).toBe(1);expect(readFileSync(join(f.root,'ai','connections.json'),'utf8')).not.toContain(openai.key);
 f.lock(false);const restarted=new AiConnections(f.options);await restarted.recover();expect(f.values.size).toBe(0);expect(restarted.snapshot().pendingCleanup).toBe(false);
});
test('verified exact-model metadata exposes bounded adapter contracts and unknown billable reasoning',async()=>{
 const f=fixture();const cases=[['openai','gpt-6-luna',1_050_000,128_000,'schema','max-output'],['anthropic','claude-haiku-4-5-20251001',200_000,64_000,'validated-json','max-output'],['deepseek','deepseek-flash',1_000_000,393_216,'validated-json','max-output'],['xai','grok-4.3',1_000_000,128_000,'schema','unknown']] as const;
 for(const [provider,model,contextTokens,maxOutputTokens,structuredOutput,billableOutputBound] of cases){const c=await f.manager.register({provider,model,key:'KEY'});expect(c.capabilities).toMatchObject({contextTokens,maxOutputTokens,structuredOutput,billableOutputBound,streaming:false});expect(c.capabilitySource).toBe('verified-metadata');expect(c.capabilityVerifiedAt).toBe('2026-10-07');}
});
test('crash journal recovers a put that never became a connection; malformed state fails closed',async()=>{
 const f=fixture();await f.manager.register(openai);const path=join(f.root,'ai','connections.json'),record=JSON.parse(readFileSync(path,'utf8')),orphan='12345678-1234-1234-1234-123456789abc';record.pendingCleanup.push(orphan);f.values.set(orphan,'ORPHAN_KEY');writeFileSync(path,JSON.stringify(record));const restarted=new AiConnections(f.options);await restarted.recover();expect(f.values.has(orphan)).toBe(false);record.connections[0].credentialReference='invalid-reference';writeFileSync(path,JSON.stringify(record));const invalid=new AiConnections(f.options);expect(invalid.snapshot().unavailable).toBe(true);await expect(invalid.register(openai)).rejects.toThrow('settings-recovery');
});
test('private settings reject symlinks, directories and oversized files while retaining recovery data',async()=>{
 for(const kind of ['symlink','dangling-symlink','directory','oversized']){const f=fixture();await f.manager.register(openai);const path=join(f.root,'ai','connections.json');if(kind==='oversized')truncateSync(path,1_000_001);else {rmSync(path);if(kind==='directory')mkdirSync(path);else {const target=join(f.root,'untouched.json');if(kind==='symlink')writeFileSync(target,'{}');symlinkSync(target,path);}}
  const inode=lstatSync(path).ino;expect(new AiConnections(f.options).snapshot().unavailable).toBe(true);expect(lstatSync(path).ino).toBe(inode);
 }
});
test('FIFO settings fail closed promptly instead of blocking server startup',async()=>{
 const f=fixture();const path=join(f.root,'ai','connections.json');expect(Bun.spawnSync(['mkfifo',path]).exitCode).toBe(0);
 const source=`import {AiConnections} from ${JSON.stringify(join(import.meta.dir,'connections.ts'))};import {readPrivateJson} from ${JSON.stringify(join(import.meta.dir,'../connectors/private-json.ts'))};const manager=new AiConnections({appDir:${JSON.stringify(f.root)},vault:{put:async()=>'',get:async()=>null,remove:async()=>{}}});let readerRejected=false;try{readPrivateJson(${JSON.stringify(path)},1000000);}catch{readerRejected=true;}console.log(manager.snapshot().unavailable&&readerRejected);`;
 const child=Bun.spawn([process.execPath,'-e',source],{stdout:'pipe',stderr:'pipe'});let timer:ReturnType<typeof setTimeout>|undefined;
 try{const completed=await Promise.race([child.exited.then(()=>true),new Promise<boolean>(resolve=>{timer=setTimeout(()=>resolve(false),1500);})]);expect(completed).toBe(true);expect(await new Response(child.stdout).text()).toBe('true\n');}
 finally{clearTimeout(timer);child.kill('SIGKILL');await child.exited;}
});
