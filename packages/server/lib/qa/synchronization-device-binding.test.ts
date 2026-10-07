import * as fs from 'node:fs';
import {ManagedQuota} from '../managed-quota';
import {test,expect,spyOn} from 'bun:test';
import {realpathSync,mkdtempSync,mkdirSync,writeFileSync,readFileSync,renameSync,symlinkSync,linkSync,rmSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {localIdentity,withResolvedLocalBinding,parseAcceptanceSpec} from './synchronization-device-binding';
function fixture(){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'heed-qa-binding-')));chmodSync(root,0o700);
 const app=join(root,'app');mkdirSync(app,{mode:0o700});
 const connection={id:randomUUID(),name:'Synthetic',enabled:true,binding:{bookmark:'YQ==',account:'Yg==',identity:'1:2'},destinationId:randomUUID(),destinationVersion:2};
 const path=join(app,'icloud-folder.json');writeFileSync(path,JSON.stringify({version:1,connection}),{mode:0o600});
 const {name,enabled,...generationParts}=connection;
 const descriptor={version:1 as const,provider:'icloud' as const,appPath:app,appIdentity:localIdentity(app),configIdentity:localIdentity(path),connectionId:connection.id,generation:createHash('sha256').update(JSON.stringify(generationParts)).digest('hex')};
 return {root,app,path,descriptor,close:()=>rmSync(root,{recursive:true})};
}
test('read-only selected binding is pinned across native observation without changing installed bytes',async()=>{
 const f=fixture();try{const before=readFileSync(f.path);let called=0;const result=await withResolvedLocalBinding(f.descriptor,async binding=>{called++;expect(binding.provider).toBe('icloud');return 'observed';});expect(result).toBe('observed');expect(called).toBe(1);expect(readFileSync(f.path)).toEqual(before);}finally{f.close();}
});
test('transition, duplicate keys, hardlink and changed generation refuse before native effects',async()=>{
 for(const kind of ['transition','duplicate','hardlink','generation']){const f=fixture();try{
  if(kind==='transition')writeFileSync(f.path+'.transition.json','private transition',{mode:0o600});
  if(kind==='duplicate'){const original=readFileSync(f.path,'utf8');writeFileSync(f.path,original.replace('"version":1','"version":1,"version":1'));}
  if(kind==='hardlink')linkSync(f.path,join(f.root,'copy'));
  if(kind==='generation')f.descriptor.generation='0'.repeat(64);
  const before=readFileSync(f.path);let calls=0;await expect(withResolvedLocalBinding(f.descriptor,async()=>{calls++;})).rejects.toThrow();expect(calls).toBe(0);expect(readFileSync(f.path)).toEqual(before);
 }finally{f.close();}}
});
test('retained ancestor and config substitution during callback cannot return usable authority',async()=>{
 for(const kind of ['ancestor','config','symlink']){const f=fixture();try{await expect(withResolvedLocalBinding(f.descriptor,async()=>{
  if(kind==='ancestor'){renameSync(f.app,f.app+'-old');mkdirSync(f.app,{mode:0o700});}
  else {renameSync(f.path,f.path+'-old');if(kind==='symlink')symlinkSync(f.path+'-old',f.path);else writeFileSync(f.path,readFileSync(f.path+'-old'),{mode:0o600});}
  return 'must not return';
 })).rejects.toThrow();}finally{f.close();}}
});
test('public spec names exactly one synthetic child and fixed provider version',()=>{
 const runId=randomUUID();const spec={version:1,runId,destinationId:randomUUID(),provider:'icloud',destinationVersion:2,child:'heed-qa-'+runId,aliases:['a','b'],locales:['en','pt'],fixtureSchema:1,fixtureHash:'a'.repeat(64)};
 expect(parseAcceptanceSpec(spec).child).toBe(spec.child);
 for(const value of [{...spec,child:'existing'},{...spec,destinationVersion:3},{...spec,locales:['en']},{...spec,privateBookmark:'secret'}])expect(()=>parseAcceptanceSpec(value)).toThrow();
});

test('quota persistence cannot modify a substituted directory or permit native effects',async()=>{
 const {createAcceptanceWorkspace,openAcceptanceQuota}=await import('./synchronization-device-binding');
 const f=fixture();try{
  const runId=randomUUID(),workspace=join(f.root,'qa');const descriptor=createAcceptanceWorkspace(workspace);
  let effects=0;const quota=openAcceptanceQuota(descriptor,runId,1_048_576);
  renameSync(workspace,workspace+'-original');mkdirSync(workspace,{mode:0o700});mkdirSync(join(workspace,'quota'),{mode:0o700});writeFileSync(join(workspace,'quota','ledger'),'foreign sentinel',{mode:0o600});
  expect(()=>{quota.verify();effects++;}).toThrow();expect(effects).toBe(0);expect(readFileSync(join(workspace,'quota','ledger'),'utf8')).toBe('foreign sentinel');quota.close();
 }finally{f.close();}
});

test('disabled reviewed local connection remains observable without any private QA state',async()=>{
 const {observeSelectedBinding}=await import('./synchronization-device-binding');const f=fixture();try{
  const value=JSON.parse(readFileSync(f.path,'utf8'));value.connection.enabled=false;writeFileSync(f.path,JSON.stringify(value));let calls=0;
  const result=await observeSelectedBinding(f.descriptor,{cloud:{acceptance:async request=>{calls++;expect(request.action).toBe('qa-observe-parent');return {identity:'1:2',ancestors:['1:2:3:4'],accountMatched:true,ubiquitous:true};}}});
  expect(result.category).toBe('observation-complete');expect(calls).toBe(1);expect(JSON.stringify(result)).not.toContain('YQ==');
 }finally{f.close();}
});

test('checkpoint ancestor substitution preserves foreign bytes and refuses native success',async()=>{
 const {createAcceptanceWorkspace,openAcceptanceQuota}=await import('./synchronization-device-binding');
 const f=fixture();let hook:ReturnType<typeof spyOn>|undefined;try{
  const workspace=createAcceptanceWorkspace(join(f.root,'qa')),directory=join(workspace.path,'quota'),ledger=join(directory,'ledger');
  const original=fs.fsyncSync;let injected=false,effects=0;
  hook=spyOn(fs,'fsyncSync').mockImplementation(fd=>{original(fd);if(injected||!fs.fstatSync(fd).isFile())return;injected=true;const names=fs.readdirSync(directory);renameSync(directory,directory+'-original');mkdirSync(directory,{mode:0o700});writeFileSync(ledger,'foreign sentinel',{mode:0o600});for(const name of names)if(name!=='ledger')writeFileSync(join(directory,name),'foreign checkpoint',{mode:0o600});});
  expect(()=>{const quota=openAcceptanceQuota(workspace,randomUUID(),1048576);try{quota.verify();effects++;}finally{quota.close();}}).toThrow();
  expect(injected).toBe(true);expect(readFileSync(ledger,'utf8')).toBe('foreign sentinel');expect(effects).toBe(0);expect(fs.existsSync(join(directory+'-original','ledger'))).toBe(true);
 }finally{hook?.mockRestore();f.close();}
});

test('retained private descriptor authority is close-on-exec across helper launch',async()=>{
 const f=fixture();try{const inherited=await withResolvedLocalBinding(f.descriptor,async()=>{
  const child=Bun.spawn([process.execPath,'-e',`import{fstatSync}from'node:fs';let input='';for await(const chunk of Bun.stdin.stream())input+=Buffer.from(chunk);const target=JSON.parse(input);let found=false;for(let fd=3;fd<256;fd++){try{const info=fstatSync(fd,{bigint:true});if(String(info.dev)===target.device&&String(info.ino)===target.inode)found=true;}catch{}}console.log(JSON.stringify({inherited:found}));`],{stdin:'pipe',stdout:'pipe',stderr:'pipe'});
  child.stdin.write(JSON.stringify(f.descriptor.appIdentity));child.stdin.end();const [text,exit]=await Promise.all([new Response(child.stdout).text(),child.exited]);expect(exit).toBe(0);return JSON.parse(text).inherited;
 });expect(inherited).toBe(false);}finally{f.close();}
});

test('fixed-arity native creation sets actual 0600 permissions and FD_CLOEXEC',async()=>{
 const {cc,dlopen,FFIType,ptr}=await import('bun:ffi');const native=cc({source:new URL('./synchronization-device-files.c',import.meta.url),symbols:{qa_openat:{args:[FFIType.i32,FFIType.ptr,FFIType.i32,FFIType.i32],returns:FFIType.i32}}});const libc=dlopen('/usr/lib/libSystem.B.dylib',{fcntl:{args:[FFIType.i32,FFIType.i32],returns:FFIType.i32}});
 const f=fixture(),root=fs.openSync(f.root,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY);let fd=-1;
 try{const name=Buffer.from('exclusive-native\0');fd=native.symbols.qa_openat(root,ptr(name),fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);expect(fd).toBeGreaterThanOrEqual(0);expect(fs.fstatSync(fd).mode&0o777).toBe(0o600);expect(libc.symbols.fcntl(fd,1)&1).toBe(1);}finally{if(fd>=0)fs.closeSync(fd);fs.closeSync(root);native.close();libc.close();f.close();}
});
test('installed app directory permits owned 0755 but rejects group-writable 0775',async()=>{
 const f=fixture();try{chmodSync(f.app,0o755);expect(await withResolvedLocalBinding(f.descriptor,async()=>true)).toBe(true);chmodSync(f.app,0o775);let called=false;await expect(withResolvedLocalBinding(f.descriptor,async()=>{called=true;})).rejects.toThrow();expect(called).toBe(false);}finally{f.close();}
});


test('local bootstrap crosses actual guardian framing and durable native receipt boundaries',async()=>{
 const {createAcceptanceWorkspace,createOwnedChild,joinOwnedChild}=await import('./synchronization-device-binding');
 const {PythonDirectSmbNative}=await import('../smb-direct-native');
 const {fileURLToPath}=await import('node:url');
 const f=fixture();const children:ReturnType<typeof Bun.spawn>[]=[];
 try{
  const source=fileURLToPath(new URL('../../native/smb-direct/',import.meta.url)),remote=join(f.root,'remote');mkdirSync(remote,{mode:0o700});
  const script=`import sys,json
sys.path.insert(0,sys.argv[1])
from test_acceptance import PhysicalFixtureServer,ENDPOINT,CREDS,DirectTransport
from guardian import serve
import acceptance
acceptance.physical_uuid=lambda:'11111111-1111-4111-8111-111111111111'
server=PhysicalFixtureServer(sys.argv[2])
try:
 if sys.argv[3]=='setup':
  transport=DirectTransport(ENDPOINT,CREDS,backend=server);transport.connect();print(json.dumps(dict(endpoint=ENDPOINT,identity=transport.identity)));transport.close()
 else:serve(sys.stdin.buffer,sys.stdout.buffer,backend_factory=lambda:server)
finally:server.close()
`;
  const scriptPath=join(f.root,'synthetic-guardian.py');writeFileSync(scriptPath,script,{mode:0o600});
  const spawn=(mode:string)=>{const child=Bun.spawn(['/usr/bin/python3',scriptPath,source,remote,mode],{stdin:'pipe',stdout:'pipe',stderr:'pipe'});children.push(child);return child;};
  const setup=spawn('setup');setup.stdin.end();const initial=JSON.parse(await new Response(setup.stdout).text());expect(await setup.exited).toBe(0);
  const native=new PythonDirectSmbNative({runner:()=>spawn('serve')});
  const parent={id:randomUUID(),name:'Synthetic parent',endpoint:initial.endpoint,identity:initial.identity,destinationId:randomUUID(),destinationVersion:3 as const,connectionGeneration:randomUUID(),credentialRef:randomUUID(),readOnly:false,security:'signed' as const};
  function selected(binding:typeof parent){const path=join(f.app,'direct-smb-connections.json');writeFileSync(path,JSON.stringify({version:1,connections:[{binding,dialect:'3.1.1',enabled:false,uncertainty:null,jobs:{},acknowledged:[],retryAt:0,failures:0,lastSync:null,imported:0,skipped:0,error:null}],cleanup:[]}),{mode:0o600});return {version:1 as const,provider:'smb-direct' as const,appPath:f.app,appIdentity:localIdentity(f.app),configIdentity:localIdentity(path),connectionId:binding.id,generation:binding.connectionGeneration};}
  const runId=randomUUID(),spec=parseAcceptanceSpec({version:1,runId,destinationId:randomUUID(),provider:'smb-direct',destinationVersion:3,child:'heed-qa-'+runId,aliases:['a','b'],locales:['en','pt'],fixtureSchema:1,fixtureHash:'a'.repeat(64)});
  const vault={get:async<T>()=>({username:'fixture',password:'synthetic-not-a-secret',domain:''} as T)},workspace=createAcceptanceWorkspace(join(f.root,'creator'));
  const input={descriptor:selected(parent),workspace,spec,limitBytes:1048576};
  const created=await createOwnedChild(input,{smb:native,vault});expect(created.public.role).toBe('creator');
  const resumed=await createOwnedChild(input,{smb:native,vault});expect(resumed.private.binding).toEqual(created.private.binding);
  const participantBinding={...created.private.binding,id:randomUUID(),connectionGeneration:randomUUID(),credentialRef:randomUUID()} as typeof parent;
  const joined=await joinOwnedChild({descriptor:selected(participantBinding),workspace:createAcceptanceWorkspace(join(f.root,'participant')),spec,limitBytes:1048576},{runId,destinationId:spec.destinationId,provider:'smb-direct',destinationVersion:3,child:spec.child,initialized:true},{smb:native,vault});
  expect(joined.public.role).toBe('participant');expect(JSON.stringify(joined.public)).not.toContain(remote);
  expect(JSON.parse(readFileSync(join(workspace.path,'acceptance','receipt'),'utf8').trimEnd().split('\n').at(-1)!).phase).toBe('initialized');
  expect(JSON.parse(readFileSync(join(remote,'Heed','library',spec.child,'heed-library.json'),'utf8')).destinationId).toBe(spec.destinationId);
 }finally{for(const child of children){if(child.exitCode===null)child.kill();await child.exited;}f.close();}
},15000);

test('bootstrap refuses enabled selected iCloud connection before quota and native effects',async()=>{
 const {createAcceptanceWorkspace,createOwnedChild,joinOwnedChild,provisioningEvidence}=await import('./synchronization-device-binding');const f=fixture();
 try{const runId=randomUUID(),spec=parseAcceptanceSpec({version:1,runId,destinationId:randomUUID(),provider:'icloud',destinationVersion:2,child:'heed-qa-'+runId,aliases:['a','b'],locales:['en','pt'],fixtureSchema:1,fixtureHash:'a'.repeat(64)}),workspace=createAcceptanceWorkspace(join(f.root,'active'));let calls=0;
  await expect(createOwnedChild({descriptor:f.descriptor,workspace,spec,limitBytes:1048576},{cloud:{acceptance:async()=>{calls++;throw Error('Synthetic native boundary');}}})).rejects.toThrow();
  expect(calls).toBe(0);expect(fs.existsSync(join(workspace.path,'quota','ledger'))).toBe(false);
  await expect(joinOwnedChild({descriptor:f.descriptor,workspace,spec,limitBytes:1048576},provisioningEvidence(spec),{cloud:{acceptance:async()=>{calls++;throw Error('Synthetic participant boundary');}}})).rejects.toThrow();expect(calls).toBe(0);expect(fs.existsSync(join(workspace.path,'quota','ledger'))).toBe(false);
 }finally{f.close();}
});

test('SMB bootstrap requires disabled selected connection and no pending selected jobs',async()=>{
 const {createAcceptanceWorkspace,createOwnedChild}=await import('./synchronization-device-binding');
 for(const state of ['enabled','pending','drained']){const f=fixture();try{
  const binding={id:randomUUID(),name:'Synthetic',endpoint:{server:'nas.local',port:445,share:'meetings',folder:'Heed/library',requireEncryption:false},identity:{serverGuid:'0123456789abcdef0123456789abcdef',volumeSerial:'00000001',volumeCreated:'01db000000000001',rootId:'0000000000000010',rootCreated:'01db000000000002'},destinationId:randomUUID(),destinationVersion:3,connectionGeneration:randomUUID(),credentialRef:randomUUID(),readOnly:false,security:'signed'};
  const path=join(f.app,'direct-smb-connections.json');writeFileSync(path,JSON.stringify({version:1,connections:[{binding,dialect:'3.1.1',enabled:state==='enabled',uncertainty:null,jobs:state==='pending'?{[randomUUID()]:{attempts:0,next:0}}:{},acknowledged:[],retryAt:0,failures:0,lastSync:null,imported:0,skipped:0,error:null}],cleanup:[]}),{mode:0o600});
  const descriptor={version:1 as const,provider:'smb-direct' as const,appPath:f.app,appIdentity:localIdentity(f.app),configIdentity:localIdentity(path),connectionId:binding.id,generation:binding.connectionGeneration};
  const runId=randomUUID(),spec=parseAcceptanceSpec({version:1,runId,destinationId:randomUUID(),provider:'smb-direct',destinationVersion:3,child:'heed-qa-'+runId,aliases:['a','b'],locales:['en','pt'],fixtureSchema:1,fixtureHash:'a'.repeat(64)}),workspace=createAcceptanceWorkspace(join(f.root,'preparation'));let calls=0;
  await expect(createOwnedChild({descriptor,workspace,spec,limitBytes:1048576},{smb:{acceptance:async()=>{calls++;throw Error('Synthetic native boundary');}},vault:{get:async<T>()=>({username:'fixture',password:'synthetic',domain:''} as T)}})).rejects.toThrow();
  expect(calls).toBe(state==='drained'?1:0);expect(fs.existsSync(join(workspace.path,'quota','ledger'))).toBe(state==='drained');
 }finally{f.close();}}
});

for(const boundary of ['source','destination'])test(`ledger ${boundary} entry substitution retains foreign bytes without success`,async()=>{
 const {createAcceptanceWorkspace,openAcceptanceQuota}=await import('./synchronization-device-binding');
 const f=fixture();let hook:ReturnType<typeof spyOn>|undefined;try{
  const workspace=createAcceptanceWorkspace(join(f.root,'ledger-swap')),directory=join(workspace.path,'quota');let injected=false,effects=0,entry='';
  const substitute=(fd:number)=>{if(injected||!fs.fstatSync(fd).isFile())return;entry=fs.existsSync(join(directory,'checkpoint'))?'checkpoint':'ledger';const path=join(directory,entry);if(!fs.existsSync(path)||fs.statSync(path).ino!==fs.fstatSync(fd).ino)return;injected=true;renameSync(path,join(workspace.path,'original-'+boundary));writeFileSync(path,'foreign entry sentinel',{mode:0o600});};
  if(boundary==='source'){const original=fs.writeSync;hook=spyOn(fs,'writeSync').mockImplementation(((fd:number,...args:unknown[])=>{substitute(fd);return (original as any)(fd,...args);}) as any);}
  else{const original=fs.fsyncSync;hook=spyOn(fs,'fsyncSync').mockImplementation(fd=>{original(fd);substitute(fd);});}
  expect(()=>{const quota=openAcceptanceQuota(workspace,randomUUID(),1048576);try{quota.verify();effects++;}finally{quota.close();}}).toThrow();
  expect(injected).toBe(true);expect(effects).toBe(0);expect(readFileSync(join(directory,entry),'utf8')).toBe('foreign entry sentinel');
 }finally{hook?.mockRestore();f.close();}
});

test('byte-identical ledger replacement and torn append refuse on restart',async()=>{
 const {createAcceptanceWorkspace,openAcceptanceQuota}=await import('./synchronization-device-binding');
 for(const kind of ['inode','torn']){const f=fixture();try{const workspace=createAcceptanceWorkspace(join(f.root,'ledger-resume')),run=randomUUID(),quota=openAcceptanceQuota(workspace,run,1048576);quota.close();const path=join(workspace.path,'quota','ledger'),bytes=readFileSync(path);
  if(kind==='inode'){renameSync(path,join(workspace.path,'original-ledger'));writeFileSync(path,bytes,{mode:0o600});}else fs.appendFileSync(path,'{"partial":');
  expect(()=>{const unexpected=openAcceptanceQuota(workspace,run,1048576);unexpected.close();}).toThrow();expect(readFileSync(path)).toEqual(kind==='inode'?bytes:Buffer.concat([bytes,Buffer.from('{"partial":')]));
 }finally{f.close();}}
});

test('original ledger allows only one active bootstrap writer',async()=>{
 const {createAcceptanceWorkspace,openAcceptanceQuota}=await import('./synchronization-device-binding');const f=fixture();let first:ReturnType<typeof openAcceptanceQuota>|undefined,second:ReturnType<typeof openAcceptanceQuota>|undefined;
 try{const workspace=createAcceptanceWorkspace(join(f.root,'ledger-lock')),run=randomUUID();first=openAcceptanceQuota(workspace,run,1048576);expect(()=>{second=openAcceptanceQuota(workspace,run,1048576);}).toThrow();first.close();first=undefined;second=openAcceptanceQuota(workspace,run,1048576);second.verify();}
 finally{second?.close();first?.close();f.close();}
});
