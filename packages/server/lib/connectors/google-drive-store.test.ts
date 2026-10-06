import {test,expect} from 'bun:test';import {createHash,randomUUID} from 'node:crypto';import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {GoogleDriveStore} from './google-drive-store';import type {SecretVault} from './keychain-vault';
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
import {driveFixture as fixture} from './google-drive-fixtures';

async function* source(bytes:Uint8Array){yield bytes;}
test('paginates selected-library metadata without downloading remote audio and stages checkpoints until acknowledgment',async()=>{const f=fixture();try{
 f.add('objects/'+'a'.repeat(64),Buffer.from('remote-audio'));f.add('commits/device/revision.json',Buffer.from('{"synthetic":true}'));f.add('commits/outside/revision.json',Buffer.from('EXCLUDED_REMOTE_MARKER'),'unselected-folder');
 const p=f.store();const listing=await p.discover();expect(listing.map(entry=>entry.path)).toContain('commits/device/revision.json');expect(JSON.stringify(listing)).not.toContain('outside');expect(f.requests.filter(u=>u.searchParams.get('alt')==='media').every(u=>u.pathname.endsWith('/header'))).toBe(true);
 expect(JSON.parse(readFileSync(f.path,'utf8')).checkpoint).toBeUndefined();expect(JSON.parse(readFileSync(f.path,'utf8')).candidate.checkpoint).toBe('START');await p.acknowledgeDiscovery();expect(JSON.parse(readFileSync(f.path,'utf8')).checkpoint).toBe('START');
 f.unchanged();await f.store().discover();expect(JSON.parse(readFileSync(f.path,'utf8')).checkpoint).toBe('START');await f.store().acknowledgeDiscovery();expect(JSON.parse(readFileSync(f.path,'utf8')).checkpoint).toBe('NEXT');
}finally{f.cleanup();}});
test('durable resumable jobs recover provider progress after restart without duplicating objects or exposing session URLs',async()=>{const f=fixture();try{
 const bytes=Buffer.alloc(600000,7),path=`objects/${hash(bytes)}`;f.setFail();await expect(f.store().write(path,bytes.length,hash(bytes),source(bytes))).rejects.toThrow();expect(readFileSync(f.path,'utf8')).not.toContain('SECRET_SESSION');expect(f.secrets.size).toBe(1);
 await f.store().write(path,bytes.length,hash(bytes),source(bytes));expect([...f.files.values()].filter(file=>file.properties?.heedPath===path)).toHaveLength(1);expect(f.requests.filter(u=>u.pathname.endsWith('/generateIds'))).toHaveLength(1);expect(f.secrets.size).toBe(0);
 const before=f.requests.filter(u=>u.pathname.startsWith('/upload')).length;await f.store().write(path,bytes.length,hash(bytes),source(bytes));expect(f.requests.filter(u=>u.pathname.startsWith('/upload'))).toHaveLength(before);
}finally{f.cleanup();}});
test('expired upload sessions restart on the reserved file ID and hash mismatch cannot complete publication',async()=>{const f=fixture();try{
 const bytes=Buffer.alloc(600000,8),path=`objects/${hash(bytes)}`;f.setFail();await expect(f.store().write(path,bytes.length,hash(bytes),source(bytes))).rejects.toThrow();f.expire();await f.store().write(path,bytes.length,hash(bytes),source(bytes));expect(f.requests.filter(u=>u.pathname.endsWith('/generateIds'))).toHaveLength(1);
 const bad=Buffer.from('mismatched');await expect(f.store().write('objects/'+'b'.repeat(64),bad.length,'b'.repeat(64),source(bad))).rejects.toThrow('integrity');expect([...f.files.values()].some(file=>file.properties?.heedPath==='objects/'+'b'.repeat(64))).toBe(false);
}finally{f.cleanup();}});
test('quota failure, changed identity, unsafe paths and immutable collisions preserve pending state',async()=>{const f=fixture();try{
 const bytes=Buffer.from('correct'),path=`objects/${hash(bytes)}`;f.quota();await expect(f.store().write(path,bytes.length,hash(bytes),source(bytes))).rejects.toThrow('quota');expect(Object.keys(JSON.parse(readFileSync(f.path,'utf8')).jobs)).toHaveLength(1);
 await expect(f.store().read('../outside',10)).rejects.toThrow();f.files.get('header')!.bytes=Buffer.from(JSON.stringify({format:'heed-portable-library',schemaVersion:1,destinationId:randomUUID()}));await expect(f.store().discover()).rejects.toThrow('identity');
}finally{f.cleanup();}});
test('missing SHA-256 performs bounded readback instead of treating MD5 as verified SHA-256',async()=>{const f=fixture();try{
 const bytes=Buffer.from('content'),path=`objects/${hash(bytes)}`,file=f.add(path,bytes);delete file.sha256Checksum;file.md5Checksum='unrelated-md5';await f.store().verify(path,bytes.length,hash(bytes));expect(f.requests.some(u=>u.pathname.endsWith(`/${file.id}`)&&u.searchParams.get('alt')==='media')).toBe(true);
 file.bytes=Buffer.from('altered');await expect(f.store().verify(path,bytes.length,hash(bytes))).rejects.toThrow('integrity');
}finally{f.cleanup();}});

test('expired checkpoints reconcile bounded metadata and replay candidates until durable acknowledgment',async()=>{const f=fixture();try{
 const p=f.store();await p.discover();await p.acknowledgeDiscovery();const state=JSON.parse(readFileSync(f.path,'utf8'));state.checkpoint='EXPIRED';writeFileSync(f.path,JSON.stringify(state));
 const reconciled=f.store();await reconciled.discover();expect(JSON.parse(readFileSync(f.path,'utf8')).checkpoint).toBe('EXPIRED');const calls=f.requests.length;await f.store().discover();expect(f.requests.slice(calls).some(u=>u.pathname==='/drive/v3/changes/startPageToken')).toBe(false);await f.store().acknowledgeDiscovery();expect(JSON.parse(readFileSync(f.path,'utf8')).checkpoint).toBe('START');
}finally{f.cleanup();}});
test('multi-page changes advance only after the final page and reject moved immutable objects',async()=>{const f=fixture();try{
 for(let i=0;i<5;i++)f.add(`commits/device/revision-${i}.json`,Buffer.from('marker'));const p=f.store();await p.discover();await p.acknowledgeDiscovery();await p.discover();expect(f.requests.filter(u=>u.pathname==='/drive/v3/changes')).toHaveLength(3);expect(JSON.parse(readFileSync(f.path,'utf8')).checkpoint).toBe('START');await p.acknowledgeDiscovery();expect(JSON.parse(readFileSync(f.path,'utf8')).checkpoint).toBe('NEXT');
 const first=[...f.files.values()].find(file=>file.properties)!;first.parents=['outside-library'];await expect(p.read(first.properties!.heedPath,100)).rejects.toThrow();
}finally{f.cleanup();}});
test('cached hierarchical IDs cannot read a directory moved outside the selected library',async()=>{const f=fixture();try{
 f.files.set('commits-dir',{id:'commits-dir',name:'commits',mimeType:'application/vnd.google-apps.folder',parents:[f.folder.id],capabilities:{canDownload:true,canAddChildren:true}});f.files.set('device-dir',{id:'device-dir',name:'device',mimeType:'application/vnd.google-apps.folder',parents:['commits-dir'],capabilities:{canDownload:true,canAddChildren:true}});const entry=f.add('ignored',Buffer.from('OUTSIDE_MARKER'),'device-dir');entry.name='revision.json';delete entry.properties;
 const p=f.store();await p.discover();expect(await p.read('commits/device/revision.json',100)).toEqual(Buffer.from('OUTSIDE_MARKER'));f.files.get('commits-dir')!.parents=['outside-library'];await expect(p.read('commits/device/revision.json',100)).rejects.toThrow('outside');
}finally{f.cleanup();}});
test('publishing an existing hierarchical object reuses its stable ID without duplicating it flat',async()=>{const f=fixture();try{
 const bytes=Buffer.from('existing audio'),path=`objects/${hash(bytes)}`;f.files.set('objects-dir',{id:'objects-dir',name:'objects',mimeType:'application/vnd.google-apps.folder',parents:[f.folder.id],capabilities:{canDownload:true,canAddChildren:true}});const entry=f.add('ignored',bytes,'objects-dir');entry.name=hash(bytes);delete entry.properties;await f.store().write(path,bytes.length,hash(bytes),source(bytes));expect(f.requests.some(u=>u.pathname.endsWith('/generateIds'))).toBe(false);expect([...f.files.values()].filter(file=>file.bytes&&Buffer.from(file.bytes).equals(bytes))).toHaveLength(1);
}finally{f.cleanup();}});
