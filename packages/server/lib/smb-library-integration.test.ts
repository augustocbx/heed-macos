import {afterEach,expect,test} from 'bun:test';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import type {Session} from '@heed/shared';
import {PortableLibrary} from './portable-library';import {SessionTags} from './session-tags';
import {SmbConnections} from './smb-connections';import {SmbProvider,type SmbNative,type SmbRequest,type SmbIdentity} from './smb-provider';
import {ManagedQuota} from './managed-quota';
import type {QuotaBudget} from './portable-provider';
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
class Share {id=randomUUID();files=new Map<string,Uint8Array>();writes:string[]=[];}
/** Two synthetic mounts share bytes, but each device has its own mount identity and private catalog. */
class Mount implements SmbNative {
 readonly identity:SmbIdentity={type:'smbfs',fsid:randomUUID(),sourceHash:'a'.repeat(64),mountPath:'/fixture/share',readOnly:false};
 reads:string[]=[];online=true;readOnly=false;interrupt=false;
 constructor(readonly share:Share){}
 async json(r:SmbRequest){if(!this.online)throw new Error('Offline');if(r.action==='probe')return {identity:{...this.identity,readOnly:this.readOnly},security:'encrypted',dialect:'SMB_3.1.1',authentication:'macOS-session'};if(['header','library'].includes(r.action))return {format:'heed-portable-library',schemaVersion:1,destinationId:this.share.id};if(r.action==='test-write'){if(this.readOnly)throw new Error('Read only');return {}; }if(r.action==='list')return [...this.share.files.keys()].filter(p=>p.startsWith('commits/'));throw new Error('Unexpected fixture operation');}
 async read(r:SmbRequest,max:number){if(!this.online)throw new Error('Offline');const file=r.path!;this.reads.push(file);const bytes=this.share.files.get(file);if(!bytes||bytes.length>max)throw new Error('Unavailable artifact');return bytes;}
 async *stream(r:SmbRequest,max:number){yield await this.read(r,max);}
 async write(r:SmbRequest,source:AsyncIterable<Uint8Array>){if(!this.online||this.readOnly)throw new Error('Unavailable mount');const chunks=[];for await(const chunk of source)chunks.push(Buffer.from(chunk));const bytes=Buffer.concat(chunks);if(bytes.length!==r.bytes||hash(bytes)!==r.sha256)throw new Error('Invalid object');if(this.interrupt){this.interrupt=false;throw new Error('Interrupted before immutable publication');}const old=this.share.files.get(r.path!);if(old&&hash(old)!==hash(bytes))throw new Error('Immutable collision');this.share.writes.push(r.path!);this.share.files.set(r.path!,bytes);}
}
const cleanups:(()=>void)[]=[];afterEach(()=>{for(const clean of cleanups.splice(0))clean();});
function device(share:Share,quota?:QuotaBudget|((root:string)=>QuotaBudget)){
 const root=mkdtempSync(join(tmpdir(),'heed-smb-two-device-')),sessionsDir=join(root,'sessions'),recordingsDir=join(root,'recordings');mkdirSync(sessionsDir);mkdirSync(recordingsDir);
 const sessions=new SessionTags(sessionsDir),native=new Mount(share);const library=new PortableLibrary({root:join(root,'library'),sessions,sessionsDir,recordingsDir,quota:(typeof quota==='function'?quota(root):quota)||{reserve(){},release(){}}});
 const service=new SmbConnections({path:join(root,'library/catalog/smb.json'),catalogPath:join(root,'library/catalog/state.json'),sessions:()=>sessions.snapshot().sessions,native,library,busy:()=>false});cleanups.push(()=>{service.close();rmSync(root,{recursive:true,force:true});});
 const connect=async()=>{const test=await service.test('/fixture/share');return service.connect({name:'Synthetic SMB',receipt:test.receipt,create:false});};
 const provider=()=>{const c=service.snapshot().connections[0]!;return new SmbProvider({...c,identity:native.identity},native);};
 return {root,recordingsDir,sessions,native,library,service,connect,provider};
}
function meeting(title='Planning',createdAt='2026-10-05T10:00:00Z'):Session{return {id:randomUUID(),title,createdAt,duration:12,language:'en',transcript:'Ana delivers review',speakers:['Ana'],segments:[{speaker:'Ana',start:0,end:12,text:'delivers review'}],aiNotes:'Review is due Friday.',summary:'Review',tags:['Product'],pinned:false,transcriptFinalized:true,transcriptionModel:'synthetic-local-model'};}
test('deleted source hidden by provider scoping retires its SMB job before newer publication',async()=>{
 const first=new Share(),second=new Share(),a=device(first),old=meeting('Old source');a.sessions.create(old);await a.connect();await a.service.tick();await a.service.tick(true);
 (a.native as {share:Share}).share=second;await a.connect();a.native.interrupt=true;await a.service.tick(true);expect(a.service.snapshot().connections.find(c=>c.enabled)?.pending).toBe(1);
 a.library.markDeleted(old.id);a.sessions.remove(old.id);const newer=meeting('New source');a.sessions.create(newer);expect(a.library.snapshot().previews.some(p=>p.meetingId===old.id)).toBe(false);
 await a.service.tick(true);expect(a.service.snapshot().connections.find(c=>c.enabled)?.pending).toBe(0);expect([...second.files.keys()].filter(p=>p.startsWith('commits/'))).toHaveLength(1);expect([...first.files.keys()].filter(p=>p.startsWith('commits/'))).toHaveLength(1);expect(a.sessions.read(newer.id)?.title).toBe('New source');
});
test('two-device SMB publication is marker-last; read-only import stays usable offline without audio download',async()=>{
 const share=new Share(),a=device(share),b=device(share);const source=meeting();const wav=Buffer.alloc(48);wav.write('RIFF');wav.write('WAVE',8);const path=join(a.recordingsDir,'synthetic.wav');writeFileSync(path,wav);a.sessions.create({...source,files:{wav:path},embeddings:{Ana:[1,2]}});
 await a.connect();await a.service.tick();expect(a.service.snapshot().connections[0]!.pending).toBe(0);expect(share.writes.at(-1)).toMatch(/^commits\//);
 b.native.readOnly=true;await b.connect();await b.service.tick();const imported=b.sessions.snapshot().sessions[0]!;expect(imported.transcript).toBe(source.segments.map(segment=>segment.text).join("\n"));expect(imported.aiNotes).toBe(source.aiNotes);expect(imported.tags).toEqual(['Product']);expect(imported.files?.wav).toBeUndefined();expect(imported.embeddings).toBeUndefined();expect(b.native.reads.some(p=>p.startsWith('objects/'))).toBe(false);
 b.native.online=false;await b.service.tick(true);expect(b.sessions.read(imported.id)?.transcript).toBe(source.segments.map(segment=>segment.text).join("\n"));b.native.online=true;const audio=await b.library.withProvider(b.provider(),library=>library.requestAudio(imported.id));expect(readFileSync(audio)).toEqual(wav);expect(b.native.reads.filter(p=>p.startsWith('objects/'))).toHaveLength(1);
});
test('interrupted SMB publication exposes no committed meeting; retry verifies immutable artifacts',async()=>{
 const share=new Share(),a=device(share),b=device(share);a.sessions.create(meeting());await a.connect();a.native.interrupt=true;await a.service.tick();expect(a.service.snapshot().connections[0]!.pending).toBe(1);expect([...share.files.keys()].some(p=>p.startsWith('commits/'))).toBe(false);await b.connect();await b.service.tick();expect(b.sessions.snapshot().sessions).toHaveLength(0);await a.service.tick(true);expect(a.service.snapshot().connections[0]!.pending).toBe(0);await b.service.tick(true);expect(b.sessions.snapshot().sessions).toHaveLength(1);
});
test('two-device divergent edits keep both revisions and never overwrite the local correction',async()=>{
 const share=new Share(),a=device(share),b=device(share);const original=meeting();a.sessions.create(original);await a.connect();await a.service.tick();await b.connect();await b.service.tick();const second=b.sessions.snapshot().sessions[0]!;a.sessions.save({...a.sessions.read(original.id)!,title:'Device A correction'});b.sessions.save({...second,title:'Device B correction'});await a.service.tick(true);await b.service.tick(true);await a.service.tick(true);expect(a.sessions.read(original.id)?.title).toBe('Device A correction');expect(b.sessions.read(second.id)?.title).toBe('Device B correction');expect(a.library.snapshot().previews.some(p=>p.state==='conflict')).toBe(true);expect(b.library.snapshot().previews.some(p=>p.state==='conflict')).toBe(true);expect([...share.files.keys()].filter(p=>p.startsWith('commits/'))).toHaveLength(3);
});
test('SMB metadata import obeys newest-first quota reservations and retains completed offline transcripts',async()=>{
 const share=new Share(),a=device(share);a.sessions.create(meeting('Older','2025-01-01T00:00:00Z'));a.sessions.create(meeting('Newer','2026-01-01T00:00:00Z'));await a.connect();await a.service.tick();let reservations=0,releases=0;const b=device(share,{reserve(){if(++reservations>1)throw new Error('Managed meeting quota has insufficient available space');},release(){releases++;}});b.native.readOnly=true;await b.connect();await b.service.tick();expect(b.sessions.snapshot().sessions.map(s=>s.title)).toEqual(['Newer']);expect(b.service.snapshot().connections[0]!.skipped).toBe(1);expect(releases).toBe(1);b.native.online=false;await b.service.tick(true);expect(b.sessions.snapshot().sessions[0]!.title).toBe('Newer');
});

test('real managed quota rejects oversized second SMB import and keeps unrelated completed text',async()=>{
 const share=new Share(),a=device(share);const large=(title:string,date:string)=>{const value=meeting(title,date);value.transcript='x'.repeat(80000);value.segments[0]!.text=value.transcript;return value;};a.sessions.create(large('Older','2025-01-01T00:00:00Z'));a.sessions.create(large('Newer','2026-01-01T00:00:00Z'));await a.connect();await a.service.tick();let quota!:ManagedQuota;const b=device(share,root=>quota=new ManagedQuota({ledgerPath:join(root,'quota.json'),roots:{text:[join(root,'sessions'),join(root,'library/catalog')],media:[join(root,'recordings'),join(root,'library/media')],staging:[join(root,'library/staging')]},getLimit:()=>1048576,setLimit(){},protectedPaths:()=>[]}));const existing=meeting('Already complete');existing.transcript='u'.repeat(150000);b.sessions.create(existing);b.native.readOnly=true;await b.connect();await b.service.tick();expect(b.sessions.snapshot().sessions.map(s=>s.title).sort()).toEqual(['Already complete','Newer']);expect(b.service.snapshot().connections[0]!.skipped).toBe(1);expect(quota.snapshot().reservedBytes).toBe(0);expect(quota.snapshot().usedBytes).toBeLessThanOrEqual(1048576);expect(b.sessions.read(existing.id)?.transcript).toBe(existing.segments.map(segment=>segment.text).join("\n"));
});
test('offline mount and retry backoff still journal new local meetings and protect prequeue audio',async()=>{
 const share=new Share(),a=device(share);await a.connect();const add=()=>{const source=meeting();const wav=Buffer.alloc(48);wav.write('RIFF');wav.write('WAVE',8);const path=join(a.recordingsDir,`${source.id}.wav`);writeFileSync(path,wav);a.sessions.create({...source,files:{wav:path}});return path;};const first=add();a.native.online=false;expect(a.service.protectedLocalPaths()).toContain(first);await a.service.tick();expect(a.service.snapshot().connections[0]!.pending).toBe(1);const second=add();expect(a.service.protectedLocalPaths()).toContain(second);await a.service.tick();expect(a.service.snapshot().connections[0]!.pending).toBe(2);a.native.online=true;await a.service.tick(true);expect(a.service.snapshot().connections[0]!.pending).toBe(0);expect(a.service.protectedLocalPaths()).toEqual([]);
});
