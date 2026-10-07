import {test,expect,afterEach,spyOn} from 'bun:test';
import * as fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,relative} from 'node:path';
import {randomUUID} from 'node:crypto';
import * as binding from './synchronization-device-binding';
import {ManagedQuota} from '../managed-quota';
import {SessionTags} from '../session-tags';
import {PortableLibrary} from '../portable-library';
import {setAtomicWriteBudget} from '../atomic-json';
import {encode,makeBundle,portableMeeting,revisionPath,sha256} from '../portable-schema';
import type {LibraryProvider} from '../portable-provider';
import type {Session,PortableCommit} from '@heed/shared';
const roots:string[]=[];afterEach(()=>{setAtomicWriteBudget(undefined);for(const root of roots.splice(0))fs.rmSync(root,{recursive:true,force:true});});
async function api(){const adapter=await import('./synchronization-device-local-io').catch(()=>({}));expect(typeof (adapter as any).createSynchronizationLocalIo).toBe('function');return adapter as typeof import('./synchronization-device-local-io');}
const meeting:Session={id:'a-en',title:'Synthetic planning',createdAt:'2026-01-01T00:00:00Z',duration:1,language:'en',transcript:'Ana owns the review.',speakers:['Ana'],tags:['Review'],segments:[],aiNotes:'Synthetic notes',summary:'Synthetic summary',pinned:false,transcriptFinalized:true};
class Provider implements LibraryProvider {
 id='local-io-fixture';name='Synthetic';transport='os-managed-folder' as const;objects=new Map<string,Uint8Array>();commits:PortableCommit[]=[];
 async list(){return {commits:this.commits,next:null,complete:true};}
 async read(path:string,maximum:number){const data=this.objects.get(path);if(!data||data.length>maximum)throw new Error('Invalid synthetic object');return data;}
 async *stream(path:string,maximum:number){const data=await this.read(path,maximum);for(let i=0;i<data.length;i+=7)yield data.subarray(i,i+7);}
 async writeImmutable(path:string,data:Uint8Array){this.objects.set(path,data);}
 async writeObjectImmutable(path:string,bytes:number,hash:string,source:AsyncIterable<Uint8Array>){const chunks:Buffer[]=[];for await(const chunk of source)chunks.push(Buffer.from(chunk));const data=Buffer.concat(chunks);expect(data.length).toBe(bytes);expect(sha256(data)).toBe(hash);this.objects.set(path,data);}
 async confirm(){return 'remote-confirmed' as const;}
 add(bundle:ReturnType<typeof makeBundle>){this.commits.push(bundle.marker);this.objects.set(bundle.marker.manifestPath,encode(bundle.manifest));this.objects.set(`${revisionPath(bundle.manifest.meetingId,bundle.manifest.revisionId)}/meeting.json`,encode(bundle.payload));}
}
/** Finite synthetic original intents, made durable only by actual quota saves/entry records. */
async function fixture(run:(f:any)=>Promise<void>){
 const mod=await api();const root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'heed-local-io-')));roots.push(root);fs.chmodSync(root,0o700);const rootIdentity=binding.localIdentity(root),operation=randomUUID();
 const entries=new Map<string,any>(),intents=new Map<string,any>(),durable=new Map<string,any>(),events:any[]=[];let stored:any=null,fail='';
 const allow=(path:string,claim:string,maximum=1_048_576)=>{const local=relative(root,path);if(!local||local.startsWith('..'))throw new Error('Invalid synthetic grant');const parts=local.split('/');if(parts.length>16)throw new Error('Invalid synthetic depth');for(let i=1;i<=parts.length;i++){const name=parts.slice(0,i).join('/');const file=/\.(json|wav|tmp)$/.test(name)||name.endsWith('/.tag-transaction');intents.set(name,{id:randomUUID(),path:name,rootIdentity,operation,phase:'synthetic-en',claim,kind:file?'file':'directory',mode:file?0o600:0o700,maximum:file?maximum:0,role:name.includes('.tmp')?'temporary':name.includes('/staging/')?'staging':'retained'});}};
 const save=()=>{if(fail==='save')throw new Error('Synthetic durable save failed');for(const [path,intent] of intents)durable.set(path,structuredClone(intent));events.push({kind:'save',value:structuredClone(stored)});};
 for(const name of ['library/catalog/state.json','library/media','library/indexes','library/staging','sessions','sessions/.tag-transaction','sessions/a-en.json'])allow(join(root,name),'bootstrap');save();
 const namespace={operation,entry:(path:string)=>entries.get(path),intent:(path:string)=>intents.get(path),grant:(path:string,parentIdentity:binding.LocalIdentity)=>{const intent=durable.get(path);if(!intent)throw new Error('Missing original durable intent');const grant={...intent,parentIdentity};events.push({kind:'grant',grant});return grant;},issued:(grant:any,identity:any)=>{if(fail==='issued')throw new Error('Synthetic issue persistence failed');const entry={...grant,identity,policy:'private'};entries.set(entry.path,entry);save();return structuredClone(entry);},promoted:(source:any,grant:any,identity:any)=>{if(fail==='promoted')throw new Error('Synthetic promotion persistence failed');const entry={...grant,identity,policy:'private'};entries.delete(source.path);entries.set(entry.path,entry);save();return structuredClone(entry);},removed:(entry:any)=>{if(fail==='removed')throw new Error('Synthetic removal persistence failed');entries.delete(entry.path);save();}};
 await binding.withPinnedQaTree(root,rootIdentity,async tree=>{
  const io=mod.createSynchronizationLocalIo(tree,namespace);const quota=new ManagedQuota({ledgerPath:join(root,'quota.json'),roots:{text:[join(root,'sessions'),join(root,'library/catalog')],media:[join(root,'library/media')],staging:[join(root,'library/staging')],indexes:[join(root,'library/indexes')]},getLimit:()=>8_000_000,setLimit(){throw new Error('Synthetic limit immutable');},protectedPaths:()=>[root],localIo:io,ledgerStorage:{load:()=>stored,save(value){io.owns(root);stored=structuredClone(value);save();}}});
  const reserve=quota.reserve.bind(quota);quota.reserve=(id,bytes,paths=[])=>{for(const path of paths){allow(path,id,Math.max(bytes,65_536));if(/\/staging\/[a-f0-9-]{36}$/.test(path))for(const child of ['job.json','meeting.json','verified.wav'])allow(join(path,child),id,Math.max(bytes,65_536));if(/\/revisions\/[a-f0-9-]{36}\/[a-f0-9-]{36}\/[a-f0-9-]{36}$/.test(path))for(const child of ['meeting.json','manifest.json'])allow(join(path,child),id,Math.max(bytes,65_536));}reserve(id,bytes,paths);};
  setAtomicWriteBudget((path,bytes,temp)=>{if(temp)allow(temp,'atomic-copy',bytes);return quota.atomicWriteBudget(path,bytes,temp);});
  io.mkdir(join(root,'sessions'));const sessions=new SessionTags(join(root,'sessions'),{writeAtomic:io.writeAtomic},io),provider=new Provider();const libraryOptions={root:join(root,'library'),sessions,sessionsDir:join(root,'sessions'),quota,provider,localIo:io,write:(path:string,value:unknown)=>io.writeAtomic(path,JSON.stringify(value,null,2))};const library=new PortableLibrary(libraryOptions);
  await run({root,rootIdentity,operation,io,tree,namespace,entries,intents,durable,events,quota,sessions,provider,library,libraryOptions,allow,save,fail:(value:string)=>{fail=value;}});
 });
}
test('actual descriptor adapter routes production session, revision, job, media and quota operations',async()=>{
 await fixture(async f=>{f.sessions.create(meeting);const local=await f.library.queueLocal(meeting.id);await f.library.publish(local.revisionId);expect(f.provider.objects.size).toBe(3);expect(f.quota.snapshot().usedBytes).toBeGreaterThan(0);expect(f.quota.snapshot().reservedBytes).toBe(0);
 const audio=Buffer.from('RIFF....WAVEsynthetic audio bytes');const hash=sha256(audio),payload=portableMeeting({...meeting,id:'remote'},randomUUID(),{sha256:hash,bytes:audio.length,format:'wav',mode:'archived',objectPath:`objects/${hash}`});const bundle=makeBundle(randomUUID(),randomUUID(),payload,[]);f.allow(join(f.root,'sessions',bundle.manifest.meetingId+'.json'),'synthetic-discovery');f.allow(join(f.root,'library/media',hash+'.wav'),'synthetic-audio');f.save();f.provider.add(bundle);f.provider.objects.set(payload.audio!.objectPath,audio);await f.library.discover();await f.library.importSelected();const session=f.sessions.snapshot().sessions.find((s:Session)=>s.id!==meeting.id)!;const path=await f.library.requestAudio(session.id);expect(fs.readFileSync(path)).toEqual(audio);expect(f.io.list(join(f.root,'library/staging'),512)).toEqual([]);expect(f.quota.snapshot().reservedBytes).toBe(0);expect(f.events.some((e:any)=>e.kind==='grant'&&e.grant.claim.startsWith('library-'))).toBe(true);const audioLocal=await f.library.queueLocal(session.id);await f.library.publish(audioLocal.revisionId);expect(f.provider.objects.get(payload.audio!.objectPath)).toEqual(audio);
 });
});

function foreignCensus(path:string):string {return JSON.stringify(fs.readdirSync(path).sort().map(name=>{const file=join(path,name),stat=fs.lstatSync(file);return [name,stat.dev,stat.ino,stat.mode,stat.size,stat.isFile()?fs.readFileSync(file).toString('hex'):foreignCensus(file)];}));}
function swap(path:string){fs.renameSync(path,path+'-original');fs.mkdirSync(path,{mode:0o700});fs.writeFileSync(join(path,'foreign.json'),'foreign sentinel',{mode:0o600});return foreignCensus(path);}
function grantFile(f:any,path:string,cap=1024){const id='fixture-'+randomUUID();f.quota.reserve(id,cap,[path]);return id;}

test('directory identity is retained during the synchronous issuance persistence window',async()=>{
 await fixture(async f=>{const path=join(f.root,'library/staging',randomUUID());f.quota.reserve('library-'+randomUUID(),100_000,[path]);const issued=f.namespace.issued;let found=false;
 f.namespace.issued=(grant:any,identity:any)=>{if(grant.path===relative(f.root,path)){for(let fd=3;fd<256;fd++){try{const stat=fs.fstatSync(fd,{bigint:true});if(String(stat.dev)===identity.device&&String(stat.ino)===identity.inode)found=true;}catch{}}}return issued(grant,identity);};
 f.io.mkdir(path);expect(found).toBe(true);
 });
});

test('failed creation issuance retains the exclusive name and refuses restart adoption',async()=>{
 let root='',path='',entry:any,namespace:any,rootIdentity:any;
 await fixture(async f=>{root=f.root;rootIdentity=f.rootIdentity;namespace=f.namespace;path=join(root,'library/staging',randomUUID());f.quota.reserve('library-'+randomUUID(),100_000,[path]);f.fail('issued');expect(()=>f.io.mkdir(path)).toThrow('issue persistence');expect(fs.statSync(path).isDirectory()).toBe(true);expect(f.entries.has(relative(root,path))).toBe(false);entry=f.entries;f.fail('');expect(()=>f.io.exists(path)).toThrow();});
 await binding.withPinnedQaTree(root,rootIdentity,async tree=>{const {createSynchronizationLocalIo}=await api();const io=createSynchronizationLocalIo(tree,namespace);expect(()=>io.mkdir(path)).toThrow();expect(entry.has(relative(root,path))).toBe(false);expect(fs.statSync(path).isDirectory()).toBe(true);});
});

test('a durable root intent cannot create without the exact original-parent creation grant',async()=>{
 await fixture(async f=>{const path=join(f.root,'library/staging',randomUUID());f.quota.reserve('library-'+randomUUID(),100_000,[path]);f.namespace.grant=(name:string,parentIdentity:any)=>({...f.durable.get(name),parentIdentity:{...parentIdentity,inode:'0'}});expect(()=>f.io.mkdir(path)).toThrow();expect(fs.existsSync(path)).toBe(false);});
});

test('exclusive UUID directories and files refuse pre-existing names without adoption',async()=>{
 await fixture(async f=>{const path=join(f.root,'library/staging',randomUUID());f.quota.reserve('library-'+randomUUID(),100_000,[path]);const file=join(f.root,'sessions','raced.json');grantFile(f,file);fs.mkdirSync(path,{mode:0o700});expect(()=>f.io.mkdir(path)).toThrow();expect(f.entries.has(relative(f.root,path))).toBe(false);
 fs.writeFileSync(file,'same bytes',{mode:0o600});expect(()=>f.io.createFile(file,10)).toThrow();expect(fs.readFileSync(file,'utf8')).toBe('same bytes');expect(f.entries.has(relative(f.root,file))).toBe(false);
 });
});

test('identical replacement leaves refuse ordinary session read, stream and atomic write',async()=>{
 await fixture(async f=>{f.sessions.create(meeting);const path=join(f.root,'sessions/a-en.json'),bytes=fs.readFileSync(path);fs.renameSync(path,path+'-original');fs.writeFileSync(path,bytes,{mode:0o600});const census=foreignCensus(dirname(path));expect(()=>f.sessions.read(meeting.id)).toThrow();await expect((async()=>{for await(const chunk of f.io.stream(path,65_536))void chunk;})()).rejects.toThrow();expect(()=>f.sessions.save({...meeting,title:'Changed'})).toThrow();expect(foreignCensus(dirname(path))).toBe(census);});
});

test('original write FD confines bytes after a leaf replacement at the write syscall barrier',async()=>{
 await fixture(async f=>{const path=join(f.root,'sessions','chunk.json');grantFile(f,path);const handle=f.io.createFile(path,32),write=fs.writeSync;let injected=false;const hook=spyOn(fs,'writeSync').mockImplementation((...args:any[])=>{if(!injected){injected=true;fs.renameSync(path,path+'-original');fs.writeFileSync(path,'foreign sentinel',{mode:0o600});}return (write as any)(...args);});try{expect(()=>handle.append(Buffer.from('original bytes'))).toThrow();expect(injected).toBe(true);expect(fs.readFileSync(path,'utf8')).toBe('foreign sentinel');expect(fs.readFileSync(path+'-original','utf8')).toBe('original bytes');}finally{hook.mockRestore();handle.close();}
 });
});

test('original parent FDs confine chunk writes across absolute ancestor substitution',async()=>{
 await expect(fixture(async f=>{const path=join(f.root,'sessions','chunk.json');grantFile(f,path);const handle=f.io.createFile(path,32),write=fs.writeSync;let census='';const hook=spyOn(fs,'writeSync').mockImplementation((...args:any[])=>{if(!census)census=swap(dirname(path));return (write as any)(...args);});try{expect(()=>handle.append(Buffer.from('original bytes'))).toThrow();expect(census).not.toBe('');expect(foreignCensus(dirname(path))).toBe(census);expect(fs.readFileSync(join(dirname(path)+'-original','chunk.json'),'utf8')).toBe('original bytes');}finally{hook.mockRestore();handle.close();}})).rejects.toBeInstanceOf(binding.AcceptanceError);
});

test('short descriptor writes loop and enforce a fixed cap; close is idempotent and cannot be reused',async()=>{
 await fixture(async f=>{const path=join(f.root,'sessions','short.json');grantFile(f,path);const handle=f.io.createFile(path,10),write=fs.writeSync;const hook=spyOn(fs,'writeSync').mockImplementation((fd:any,data:any,offset:any,length:any)=>write(fd,data,offset,Math.min(length,2)));try{handle.append(Buffer.from('0123456789'));expect(()=>handle.append(Buffer.from('x'))).toThrow();handle.sync();expect(fs.readFileSync(path,'utf8')).toBe('0123456789');}finally{hook.mockRestore();handle.close();handle.close();}expect(()=>handle.append(Buffer.from('x'))).toThrow();expect(()=>handle.sync()).toThrow();});
});

test('stream growth probes refuse overrun and abort or early return closes the actual pinned FD',async()=>{
 await fixture(async f=>{const path=join(f.root,'sessions','stream.json');grantFile(f,path,200_000);const h=f.io.createFile(path,200_000);h.append(Buffer.alloc(70_000,65));h.close();const closes=spyOn(fs,'closeSync');try{
 const stream=f.io.stream(path,70_000)[Symbol.asyncIterator]();expect((await stream.next()).value.length).toBe(65_536);fs.appendFileSync(path,'growth');await expect((async()=>{while(!(await stream.next()).done){}})()).rejects.toThrow();
 const early=f.io.stream(path,70_001)[Symbol.asyncIterator]();await early.next();const count=closes.mock.calls.length;await early.return?.();expect(closes.mock.calls.length).toBeGreaterThan(count);
 const controller=new AbortController(),aborted=f.io.stream(path,70_001,controller.signal)[Symbol.asyncIterator]();await aborted.next();const before=closes.mock.calls.length;controller.abort();await expect(aborted.next()).rejects.toThrow();expect(closes.mock.calls.length).toBeGreaterThan(before);
 const read=f.io.openRead(path,10);expect(read.readAt(0,10).length).toBe(10);expect(()=>read.readAt(1,10)).toThrow();read.close();expect(()=>read.readAt(0,1)).toThrow();
 }finally{closes.mockRestore();}
 });
});

test('unknown staging content refuses cleanup and quota census without unlinking originals',async()=>{
 await fixture(async f=>{const path=join(f.root,'library/staging',randomUUID());f.quota.reserve('library-'+randomUUID(),100_000,[path]);f.io.mkdir(path);fs.writeFileSync(join(path,'unknown'),'retained unknown',{mode:0o600});const census=foreignCensus(path);expect(()=>f.io.removeStaging(path)).toThrow();expect(()=>f.quota.snapshot()).toThrow();expect(foreignCensus(path)).toBe(census);});
});

test('quota release persistence failure retains the production claim and refuses subsequent effects',async()=>{
 await fixture(async f=>{const path=join(f.root,'sessions','release.json');f.allow(path,'phase');f.save();const budget=f.quota.atomicWriteBudget.bind(f.quota);setAtomicWriteBudget((target,bytes,temp)=>{if(temp)f.allow(temp,'atomic-copy',bytes);const release=budget(target,bytes,temp);return ()=>{f.fail('save');release();};});expect(()=>f.io.writeAtomic(path,'complete')).toThrow('durable save');expect(fs.readFileSync(path,'utf8')).toBe('complete');expect(f.quota.allocation(Object.keys(f.events.filter((e:any)=>e.value?.reservations).at(-1).value.reservations)[0])).not.toBe(null);f.fail('');expect(()=>f.io.exists(path)).toThrow();});
});

test('stat timestamps retain actual finite fractional milliseconds independently of decimal identity',async()=>{
 await fixture(async f=>{const path=join(f.root,'sessions','stat.json');grantFile(f,path);const h=f.io.createFile(path,32);h.append(Buffer.from('time'));h.close();fs.utimesSync(path,Math.floor(Date.now()/1000)+100.125375,Math.floor(Date.now()/1000)+100.375625);const actual=fs.statSync(path),stat=f.io.stat(path);expect(stat.mtimeMs).toBe(actual.mtimeMs);expect(stat.birthtimeMs).toBe(actual.birthtimeMs);expect(Number.isInteger(stat.mtimeMs)).toBe(false);expect(f.entries.get(relative(f.root,path)).identity).toEqual(binding.localIdentity(path));});
});

test('strict dedicated namespace parser refuses entry 513 and depth 17 without widening native receipt parsing',()=>{
 const rootIdentity={device:'1',inode:'2',birth:'3'},operation=randomUUID(),base={id:randomUUID(),path:'known',rootIdentity,operation,phase:'synthetic-en',claim:'phase',kind:'file',mode:0o600,maximum:100,role:'retained',parentIdentity:rootIdentity};const frame={format:'heed-qa-runtime-namespace',version:1,rootIdentity,operation,entries:[],grants:[base],limitation:'same-uid-leaf-namespace-race-unprotected'};
 expect(binding.parseQaNamespaceFrame(frame).limitation).toBe('same-uid-leaf-namespace-race-unprotected');expect(()=>binding.parseQaNamespaceFrame({...frame,grants:Array.from({length:513},(_,i)=>({...base,path:'file-'+i}))})).toThrow();expect(()=>binding.parseQaNamespaceFrame({...frame,grants:[{...base,path:Array(17).fill('deep').join('/')}]})).toThrow();expect(()=>binding.parseQaNamespaceFrame({...frame,format:'heed-qa-receipt'})).toThrow();expect(()=>binding.parseQaNamespaceFrame({...frame,limitation:'protected'})).toThrow();
});

test('a failed create verification retains an unissued temporary and its actual atomic reservation',async()=>{
 await fixture(async f=>{const path=join(f.root,'sessions','unissued.json');f.allow(path,'phase');f.save();let temporary='',released=0,injected=false;const budget=f.quota.atomicWriteBudget.bind(f.quota);setAtomicWriteBudget((target,bytes,temp)=>{temporary=temp!;f.allow(temp!,'atomic-copy',bytes);const release=budget(target,bytes,temp);return ()=>{released++;release();};});
 const original=fs.fstatSync,hook=spyOn(fs,'fstatSync').mockImplementation((fd:any,options:any)=>{const stat=(original as any)(fd,options);if(!injected&&temporary&&fs.existsSync(temporary)&&stat.isFile()){const expected=fs.statSync(temporary,{bigint:true});if(String(stat.ino)===String(expected.ino)){injected=true;fs.chmodSync(temporary,0o666);}}return stat;});
 try{expect(()=>f.io.writeAtomic(path,'retained')).toThrow();expect(injected).toBe(true);expect(fs.existsSync(temporary)).toBe(true);expect(f.entries.has(relative(f.root,temporary))).toBe(false);expect(released).toBe(0);}finally{hook.mockRestore();}
 });
});

for(const target of ['session','payload','manifest','job'] as const)test('production '+target+' JSON writes preserve foreign ancestors at the actual write barrier',async()=>{
 let fired=false,census='',foreign='';
 await expect(fixture(async f=>{
  if(target!=='session')f.sessions.create(meeting);
  if(target==='job'){const bundle=makeBundle(randomUUID(),randomUUID(),portableMeeting({...meeting,id:'remote'},randomUUID()),[]);f.allow(join(f.root,'sessions',bundle.manifest.meetingId+'.json'),'synthetic-discovery');f.save();f.provider.add(bundle);await f.library.discover();}
  const write=fs.writeSync,hook=spyOn(fs,'writeSync').mockImplementation((...args:any[])=>{const text=Buffer.from(args[1]).toString('utf8');const matches=target==='session'?text.includes('"id": "a-en"'):target==='payload'?text.includes('"schemaVersion":1'):target==='manifest'?text.includes('"artifacts"'):text.includes('"id": "library-')&&text.includes('"revisionId"');
   if(!fired&&matches){const stat=fs.fstatSync(args[0],{bigint:true}),own=[...f.entries.values()].find((e:any)=>e.identity.inode===String(stat.ino));expect(own).toBeDefined();foreign=dirname(join(f.root,own.path));census=swap(foreign);fired=true;}return (write as any)(...args);});
  try{if(target==='session')expect(()=>f.sessions.create(meeting)).toThrow();else if(target==='job')await expect(f.library.importSelected()).rejects.toThrow();else await expect(f.library.queueLocal(meeting.id)).rejects.toThrow();expect(fired).toBe(true);expect(foreignCensus(foreign)).toBe(census);}finally{hook.mockRestore();}
 })).rejects.toBeInstanceOf(binding.AcceptanceError);expect(fired).toBe(true);
});

test('production media promotion uses the original parent after the final leaf precheck barrier',async()=>{
 let fired=false;
 await expect(fixture(async f=>{const hash='a'.repeat(64),source=join(f.root,'library/staging',randomUUID(),'verified.wav'),destination=join(f.root,'library/media',hash+'.wav');f.quota.reserve('library-'+randomUUID(),100_000,[dirname(source),destination]);f.io.mkdir(dirname(source));const handle=f.io.createFile(source,7);handle.append(Buffer.from('content'));handle.close();
  // Existing issued target supplies the final original leaf precheck just before renameat.
  f.io.writeAtomic(destination,'initial');const expected=f.entries.get(relative(f.root,destination)).identity;const close=fs.closeSync;let census='';const hook=spyOn(fs,'closeSync').mockImplementation(fd=>{const stat=fs.fstatSync(fd,{bigint:true});if(!fired&&String(stat.ino)===expected.inode){census=swap(dirname(destination));fired=true;}return close(fd);});
  try{expect(()=>f.io.promote(source,destination)).toThrow();expect(fired).toBe(true);expect(foreignCensus(dirname(destination))).toBe(census);expect(fs.readFileSync(join(dirname(destination)+'-original',basenameLocal(destination)),'utf8')).toBe('content');}finally{hook.mockRestore();}
 })).rejects.toBeInstanceOf(binding.AcceptanceError);expect(fired).toBe(true);
});
function basenameLocal(path:string){return path.slice(path.lastIndexOf('/')+1);}

test('current staging unlink addresses only the original parent at the final identity precheck barrier',async()=>{
 let fired=false;
 await expect(fixture(async f=>{const directory=join(f.root,'library/staging',randomUUID()),path=join(directory,'job.json');f.quota.reserve('library-'+randomUUID(),100_000,[directory]);f.io.mkdir(directory);f.io.writeAtomic(path,'retained staging');const expected=f.entries.get(relative(f.root,path)).identity,stat=fs.fstatSync;let census='',checks=0;
  const hook=spyOn(fs,'fstatSync').mockImplementation((fd:any,options:any)=>{const result=(stat as any)(fd,options);if(!fired&&options?.bigint&&String(result.ino)===expected.inode&&++checks===2){census=swap(directory);fired=true;}return result;});
  try{expect(()=>f.io.unlink(path)).toThrow();expect(fired).toBe(true);expect(foreignCensus(directory)).toBe(census);expect(fs.existsSync(join(directory+'-original','job.json'))).toBe(false);}finally{hook.mockRestore();}
 })).rejects.toBeInstanceOf(binding.AcceptanceError);expect(fired).toBe(true);
});

test('same-uid-leaf-namespace-race-unprotected is observed for unlink; postchecks cannot undo namespace effects',async()=>{
 await fixture(async f=>{const directory=join(f.root,'library/staging',randomUUID()),path=join(directory,'job.json');f.quota.reserve('library-'+randomUUID(),100_000,[directory]);f.io.mkdir(directory);f.io.writeAtomic(path,'original staging');const expected=f.entries.get(relative(f.root,path)).identity,stat=fs.fstatSync;let fired=false,checks=0;
  const hook=spyOn(fs,'fstatSync').mockImplementation((fd:any,options:any)=>{const result=(stat as any)(fd,options);if(!fired&&options?.bigint&&String(result.ino)===expected.inode&&++checks===2){fs.renameSync(path,path+'-original');fs.writeFileSync(path,'foreign raced leaf',{mode:0o600});fired=true;}return result;});
  try{f.io.unlink(path);expect(fired).toBe(true);expect(fs.existsSync(path)).toBe(false);expect(fs.readFileSync(path+'-original','utf8')).toBe('original staging');}finally{hook.mockRestore();}
 });
});

test('actual bounded tree enumeration rejects the 513th entry and handles invalidate at callback close',async()=>{
 const root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'heed-tree-bound-')));roots.push(root);fs.chmodSync(root,0o700);for(let i=0;i<513;i++)fs.writeFileSync(join(root,'entry-'+i),'fixture',{mode:0o600});let escaped:any;
 await binding.withPinnedQaTree(root,binding.localIdentity(root),async tree=>{escaped=tree;expect(()=>tree.list([],512)).toThrow();expect(()=>tree.stat(Array.from({length:17},(_,i)=>({path:Array(i+1).fill('depth').join('/'),identity:tree.identity,kind:'directory' as const,policy:'private' as const})))).toThrow();});expect(()=>escaped.verify()).toThrow();
});

test('deep unknown staging content is censused before any original cleanup unlink',async()=>{
 await fixture(async f=>{const directory=join(f.root,'library/staging',randomUUID()),nested=join(directory,'nested');f.quota.reserve('library-'+randomUUID(),100_000,[directory]);f.allow(nested,'phase');f.save();f.io.mkdir(nested);f.io.writeAtomic(join(directory,'job.json'),'known original');fs.writeFileSync(join(nested,'unknown'),'retained unknown',{mode:0o600});const census=foreignCensus(directory);expect(()=>f.io.removeStaging(directory)).toThrow();expect(foreignCensus(directory)).toBe(census);});
});

for(const action of ['mkdir','exclusive-open','read-open'] as const)test('original directory descriptor confines '+action+' after its final ancestor precheck',async()=>{
 const root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'heed-tree-barrier-')));roots.push(root);fs.chmodSync(root,0o700);const parent=join(root,'parent'),file=join(parent,'original.json');fs.mkdirSync(parent,{mode:0o700});fs.writeFileSync(file,'original',{mode:0o600});const parentProof={path:'parent',identity:binding.localIdentity(parent),kind:'directory' as const,policy:'private' as const},fileProof={path:'parent/original.json',identity:binding.localIdentity(file),kind:'file' as const,policy:'private' as const};let fired=false;
 await expect(binding.withPinnedQaTree(root,binding.localIdentity(root),async tree=>{tree.list([parentProof],512);const close=fs.closeSync;let checks=0,census='';const hook=spyOn(fs,'closeSync').mockImplementation(fd=>{const stat=fs.fstatSync(fd,{bigint:true});if(!fired&&String(stat.ino)===parentProof.identity.inode&&++checks===2){census=swap(parent);fired=true;}return close(fd);});
  try{if(action==='mkdir')expect(()=>tree.createDirectory([parentProof],'issued')).toThrow();else if(action==='exclusive-open')expect(()=>tree.createFile([parentProof],'issued.json',32)).toThrow();else{const read=tree.openRead([parentProof,fileProof],32);try{expect(()=>read.readAt(0,8)).toThrow();}finally{read.close();}}expect(fired).toBe(true);expect(foreignCensus(parent)).toBe(census);if(action==='mkdir')expect(fs.statSync(join(parent+'-original','issued')).isDirectory()).toBe(true);if(action==='exclusive-open')expect(fs.readFileSync(join(parent+'-original','issued.json')).length).toBe(0);}finally{hook.mockRestore();}
 })).rejects.toBeInstanceOf(binding.AcceptanceError);expect(fired).toBe(true);
});

test('actual descriptor constructor and quota census refuse a substituted category without changing foreign census',async()=>{
 await expect(fixture(async f=>{const path=join(f.root,'library/catalog'),census=swap(path);expect(()=>new PortableLibrary(f.libraryOptions)).toThrow();expect(()=>f.quota.snapshot()).toThrow();expect(foreignCensus(path)).toBe(census);})).rejects.toBeInstanceOf(binding.AcceptanceError);
});

test('bounded adapter cleanup refuses retained originals and issued handles invalidate when the callback closes',async()=>{
 let read:any,write:any;
 await fixture(async f=>{f.sessions.create(meeting);expect(()=>f.io.unlink(join(f.root,'sessions/a-en.json'))).toThrow();read=f.io.openRead(join(f.root,'sessions/a-en.json'),65_536);const path=join(f.root,'sessions','held.json');grantFile(f,path);write=f.io.createFile(path,32);write.append(Buffer.from('held'));});expect(()=>read.readAt(0,1)).toThrow();expect(()=>write.append(Buffer.from('more'))).toThrow();write.close();read.close();
});

test('production quotaJob exception release retains the actual claim when original issuance is uncertain',async()=>{
 await fixture(async f=>{f.sessions.create(meeting);f.fail('issued');await expect(f.library.queueLocal(meeting.id)).rejects.toThrow();const save=f.events.filter((e:any)=>e.value?.reservations).at(-1);const id=Object.keys(save.value.reservations).find(id=>id.startsWith('library-'))!;expect(id).toBeDefined();expect(f.quota.allocation(id)).not.toBe(null);const staging=f.quota.allocation(id).paths.find((path:string)=>/\/staging\/[a-f0-9-]{36}$/.test(path));expect(fs.statSync(staging).isDirectory()).toBe(true);expect(f.entries.has(relative(f.root,staging))).toBe(false);});
});

test('promotion/removal record persistence loss retains ambiguous originals and refuses subsequent effects',async()=>{
 for(const failure of ['promoted','removed'])await fixture(async f=>{const directory=join(f.root,'library/staging',randomUUID()),source=join(directory,'job.json'),destination=join(f.root,'sessions','promoted.json');f.quota.reserve('library-'+randomUUID(),100_000,[directory,destination]);f.io.mkdir(directory);f.io.writeAtomic(source,'original');f.fail(failure);if(failure==='promoted'){expect(()=>f.io.promote(source,destination)).toThrow('promotion persistence');expect(fs.readFileSync(destination,'utf8')).toBe('original');expect(f.entries.has(relative(f.root,source))).toBe(true);}else{expect(()=>f.io.unlink(source)).toThrow('removal persistence');expect(fs.existsSync(source)).toBe(false);expect(f.entries.has(relative(f.root,source))).toBe(true);}f.fail('');expect(()=>f.io.exists(destination)).toThrow();});
});

test('original bounded quota rows preserve media category, overlap dedup and singleton/excluded-ledger rules',async()=>{
 await fixture(async f=>{const media=join(f.root,'library/media'),wav=join(media,'a.wav'),metadata=join(media,'meta.json'),excluded=join(f.root,'sessions','excluded.json'),temporary=metadata+'.'+randomUUID()+'.tmp';for(const path of [wav,metadata,excluded,temporary])grantFile(f,path,100);for(const [path,text] of [[wav,'audio'],[metadata,'text'],[excluded,'ledger'],[temporary,'copy']]){const h=f.io.createFile(path,100);h.append(Buffer.from(text));h.close();}
 const rows=f.io.inventory({media:[media,media],text:[excluded]},excluded);expect(rows).toHaveLength(3);expect(rows.find((row:any)=>row.path===wav)).toMatchObject({bytes:5,category:'media'});expect(rows.find((row:any)=>row.path===metadata)).toMatchObject({bytes:4,category:'text'});expect(rows.some((row:any)=>row.path===excluded)).toBe(false);const singleton=f.io.inventory({text:[metadata]},excluded);expect(singleton.map((row:any)=>row.path).sort()).toEqual([metadata,temporary].sort());expect(singleton.every((row:any)=>row.modified===fs.statSync(row.path).mtimeMs)).toBe(true);
 });
});

test('same-uid-leaf-namespace-race-unprotected includes mkdir-to-first-open issuance and conditional descendant confinement',async()=>{
 await fixture(async f=>{const directory=join(f.root,'library/staging',randomUUID()),path=join(directory,'job.json');f.quota.reserve('library-'+randomUUID(),100_000,[directory]);const parentIdentity=binding.localIdentity(dirname(directory)),sync=fs.fsyncSync;let substituted:binding.LocalIdentity|undefined;
 const hook=spyOn(fs,'fsyncSync').mockImplementation(fd=>{sync(fd);const stat=fs.fstatSync(fd,{bigint:true});if(!substituted&&String(stat.ino)===parentIdentity.inode&&fs.existsSync(directory)){fs.renameSync(directory,directory+'-helper-created');fs.mkdirSync(directory,{mode:0o700});substituted=binding.localIdentity(directory);}});
 try{f.io.mkdir(directory);expect(substituted).toBeDefined();expect(f.entries.get(relative(f.root,directory)).identity).toEqual(substituted);expect(binding.localIdentity(directory+'-helper-created')).not.toEqual(substituted);const handle=f.io.createFile(path,100);handle.append(Buffer.from('unsupported first-issuance descendant'));handle.sync();handle.close();expect(fs.readFileSync(path,'utf8')).toBe('unsupported first-issuance descendant');expect(fs.readdirSync(directory+'-helper-created')).toEqual([]);}finally{hook.mockRestore();}
 });
});

test('tree primitives refuse depth 17 creation, entry 513 pins and malformed leaf policy',async()=>{
 const root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'heed-tree-proof-')));roots.push(root);fs.chmodSync(root,0o700);const proofs:binding.QaTreeProof[]=[];let directory=root;
 for(let i=0;i<16;i++){directory=join(directory,'depth');fs.mkdirSync(directory,{mode:0o700});proofs.push({path:relative(root,directory),identity:binding.localIdentity(directory),kind:'directory',policy:'private'});}
 await binding.withPinnedQaTree(root,binding.localIdentity(root),async tree=>{expect(()=>tree.createDirectory(proofs,'depth')).toThrow();expect(()=>tree.createFile(proofs,'depth.json',10)).toThrow();});expect(fs.existsSync(join(directory,'depth'))).toBe(false);
 const file=join(root,'file.json');fs.writeFileSync(file,'proof',{mode:0o644});const proof={path:'file.json',identity:binding.localIdentity(file),kind:'file' as const,policy:'installed' as const};
 await binding.withPinnedQaTree(root,binding.localIdentity(root),async tree=>{expect(()=>tree.stat([{...proof,policy:'unknown' as any}])).toThrow();expect(tree.stat([proof]).size).toBe(5);});
 fs.chmodSync(file,0o600);const files=Array.from({length:513},(_,i)=>{const path=join(root,'pin-'+i);fs.writeFileSync(path,'pin',{mode:0o600});return {path:'pin-'+i,identity:binding.localIdentity(path),kind:'file' as const,policy:'private' as const};});
 await binding.withPinnedQaTree(root,binding.localIdentity(root),async tree=>{for(const proof of files.slice(0,512)){const read=tree.openRead([proof],3);read.close();}expect(()=>tree.openRead([files[512]!],3)).toThrow();});
});

test('concrete original namespace callback records accept canonical durable property order',async()=>{
 await fixture(async f=>{const canonical=(value:any):any=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;const issued=f.namespace.issued,promoted=f.namespace.promoted,entry=f.namespace.entry;
 f.namespace.issued=(g:any,identity:any)=>canonical(issued(g,identity));f.namespace.promoted=(source:any,g:any,identity:any)=>canonical(promoted(source,g,identity));f.namespace.entry=(path:string)=>{const value=entry(path);return value&&canonical(value);};
 f.sessions.create(meeting);expect(f.sessions.read(meeting.id)?.title).toBe(meeting.title);const local=await f.library.queueLocal(meeting.id);expect(local.local).toBe(true);expect(f.quota.snapshot().reservedBytes).toBe(0);
 });
});


test('held adapter read/write handles refuse after issuance persistence uncertainty and still close',async()=>{
 await fixture(async f=>{const path=join(f.root,'sessions','held-poison.json'),second=join(f.root,'sessions','uncertain.json');grantFile(f,path,100);grantFile(f,second,100);const write=f.io.createFile(path,100);write.append(Buffer.from('original'));write.sync();const read=f.io.openRead(path,100);
 try{f.fail('issued');expect(()=>f.io.createFile(second,100)).toThrow('issue persistence');f.fail('');const refuses=(run:()=>unknown)=>{try{run();return false;}catch{return true;}};
 expect([refuses(()=>read.readAt(0,1)),refuses(()=>read.verify()),refuses(()=>write.append(Buffer.from(' forbidden'))),refuses(()=>write.sync()),refuses(()=>write.verify())]).toEqual([true,true,true,true,true]);expect(fs.readFileSync(path,'utf8')).toBe('original');expect(fs.existsSync(second)).toBe(true);expect(f.entries.has(relative(f.root,second))).toBe(false);
 }finally{write.close();write.close();read.close();read.close();}
 });
});

test('paused adapter stream refuses its next chunk after issuance persistence uncertainty and closes',async()=>{
 await fixture(async f=>{const path=join(f.root,'sessions','paused-poison.json'),second=join(f.root,'sessions','uncertain-stream.json');grantFile(f,path,70_000);grantFile(f,second,100);const write=f.io.createFile(path,70_000);write.append(Buffer.alloc(70_000,65));write.close();const stream=f.io.stream(path,70_000)[Symbol.asyncIterator]();expect((await stream.next()).value.length).toBe(65_536);const close=spyOn(fs,'closeSync');
 try{f.fail('issued');expect(()=>f.io.createFile(second,100)).toThrow('issue persistence');f.fail('');const count=close.mock.calls.length;await expect(stream.next()).rejects.toThrow();expect(close.mock.calls.length).toBeGreaterThan(count);expect(fs.readFileSync(path).length).toBe(70_000);}finally{await stream.return?.();close.mockRestore();}
 });
});

for(const phase of ['file','parent'] as const)test('required atomic '+phase+' fsync failure poisons authority and retains the production quota claim',async()=>{
 await fixture(async f=>{const path=join(f.root,'sessions','sync-uncertain.json');f.allow(path,'phase');f.save();const parent=binding.localIdentity(dirname(path)),budget=f.quota.atomicWriteBudget.bind(f.quota);let temporary='',claim='',injected=false;
 setAtomicWriteBudget((target,bytes,temp)=>{temporary=temp!;f.allow(temporary,'atomic-copy',bytes);const release=budget(target,bytes,temp);const reservations=f.events.filter((e:any)=>e.value?.reservations).at(-1).value.reservations;claim=Object.keys(reservations).find(id=>reservations[id].paths.includes(temporary))!;return release;});
 const sync=fs.fsyncSync,hook=spyOn(fs,'fsyncSync').mockImplementation(fd=>{const stat=fs.fstatSync(fd,{bigint:true});const matches=phase==='file'?stat.isFile()&&temporary&&fs.existsSync(temporary)&&String(stat.ino)===binding.localIdentity(temporary).inode:stat.isDirectory()&&String(stat.ino)===parent.inode;
 if(!injected&&matches){injected=true;if(phase==='parent')expect(fs.readFileSync(path,'utf8')).toBe('committed but uncertain');throw new Error('Synthetic required '+phase+' fsync failure');}sync(fd);});
 try{expect(()=>f.io.writeAtomic(path,'committed but uncertain')).toThrow('required '+phase+' fsync');expect(injected).toBe(true);expect(claim).not.toBe('');expect(f.quota.allocation(claim)).not.toBe(null);expect(()=>f.io.exists(path)).toThrow();expect(()=>f.io.syncDirectory(dirname(path))).toThrow();if(phase==='parent'){expect(fs.readFileSync(path,'utf8')).toBe('committed but uncertain');expect(fs.existsSync(temporary)).toBe(false);}else{expect(fs.existsSync(path)).toBe(false);expect(fs.readFileSync(temporary,'utf8')).toBe('committed but uncertain');}
 }finally{hook.mockRestore();}
 });
});
