/** Opt-in local acceptance preparation. No installed connection controller is constructed. */
import {dlopen,cc,FFIType,ptr,read} from 'bun:ffi';
import {constants,openSync,closeSync,fstatSync,statSync,readSync,writeSync,fsyncSync} from 'node:fs';
import {basename,dirname,join} from 'node:path';
import {ManagedQuota,type QuotaLedgerStorage} from '../managed-quota';
import {createHash} from 'node:crypto';
import {decodeFrame,PythonDirectSmbNative} from '../smb-direct-native';
import {MacCloudNative,cloudBinding,type CloudBinding,type CloudAcceptanceNative} from '../connectors/icloud-folder';
import {validateDirectBinding,type DirectSmbBinding,validateDirectCredentials,type DirectSmbCredentials,type DirectSmbAcceptanceNative,validateDirectIdentity,sameDirectIdentity} from '../smb-direct-types';
import {createKeychainVault,type SecretVault} from '../connectors/keychain-vault';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HASH=/^[a-f0-9]{64}$/;
export type AcceptanceCategory='invalid-input'|'binding-unavailable'|'recovery-required'|'identity-changed'|'ownership-unavailable'|'allocation-ambiguous'|'destination-exists'|'provider-unavailable'|'retained-pending'|'observation-complete';
export class AcceptanceError extends Error {constructor(readonly category:AcceptanceCategory){super('Acceptance preparation unavailable.');}}
const refuse=(category:AcceptanceCategory='invalid-input'):never=>{throw new AcceptanceError(category);};
function exact(value:unknown,keys:string[]):Record<string,any>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!==keys.sort().join(','))refuse();return value as Record<string,any>;}
export interface AcceptanceSpec {version:1;runId:string;destinationId:string;provider:'icloud'|'smb-direct';destinationVersion:2|3;child:string;aliases:['a','b'];locales:['en','pt'];fixtureSchema:1;fixtureHash:string}
export function parseAcceptanceSpec(input:unknown):AcceptanceSpec {
 const v=exact(input,['version','runId','destinationId','provider','destinationVersion','child','aliases','locales','fixtureSchema','fixtureHash']);
 if(Buffer.byteLength(JSON.stringify(v))>1_000_000||v.version!==1||!UUID.test(v.runId)||!UUID.test(v.destinationId)||!['icloud','smb-direct'].includes(v.provider)||v.destinationVersion!==(v.provider==='icloud'?2:3)||v.child!=='heed-qa-'+v.runId||JSON.stringify(v.aliases)!=='["a","b"]'||JSON.stringify(v.locales)!=='["en","pt"]'||v.fixtureSchema!==1||!HASH.test(v.fixtureHash))refuse();
 return structuredClone(v) as AcceptanceSpec;
}
export interface LocalIdentity {device:string;inode:string;birth:string}
function identity(info:ReturnType<typeof fstatSync>):LocalIdentity {const s=info as any;return {device:String(s.dev),inode:String(s.ino),birth:String(s.birthtimeMs)};}
function same(a:LocalIdentity,b:LocalIdentity){return a.device===b.device&&a.inode===b.inode&&a.birth===b.birth;}
function identityInput(v:unknown):LocalIdentity {const x=exact(v,['device','inode','birth']);if(Object.values(x).some(n=>typeof n!=='string'||!/^\d{1,30}$/.test(n)))refuse();return x as LocalIdentity;}
export function localIdentity(path:string):LocalIdentity {return identity(statSync(path,{bigint:true}) as any);}
let libc:ReturnType<typeof openLibrary>|undefined;let shim:ReturnType<typeof openShim>|undefined;let lastErrno=0;
function openShim(){return cc({source:new URL('./synchronization-device-files.c',import.meta.url),symbols:{qa_openat:{args:[FFIType.i32,FFIType.ptr,FFIType.i32,FFIType.i32],returns:FFIType.i32},qa_directory_name:{args:[FFIType.ptr,FFIType.ptr,FFIType.i32],returns:FFIType.i32}}});}
function openLibrary(){return dlopen('/usr/lib/libSystem.B.dylib',{
 mkdirat:{args:[FFIType.i32,FFIType.ptr,FFIType.i32],returns:FFIType.i32},
 renameat:{args:[FFIType.i32,FFIType.ptr,FFIType.i32,FFIType.ptr],returns:FFIType.i32},
 unlinkat:{args:[FFIType.i32,FFIType.ptr,FFIType.i32],returns:FFIType.i32},
 flock:{args:[FFIType.i32,FFIType.i32],returns:FFIType.i32},
 fdopendir:{args:[FFIType.i32],returns:FFIType.ptr},
 closedir:{args:[FFIType.ptr],returns:FFIType.i32},
 __error:{args:[],returns:FFIType.ptr}});}
function relativeOpen(parent:number,name:string,flags:number,mode=0):number {
 if(process.platform!=='darwin')refuse('binding-unavailable');
 libc??=openLibrary();shim??=openShim();
 const bytes=Buffer.from(name+'\0');const fd=shim.symbols.qa_openat(parent,ptr(bytes),flags,mode);lastErrno=fd<0?read.i32(libc.symbols.__error()!):0;return fd;
}
const directoryFlags=constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW;
const fileFlags=constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK;
/** Retain every ancestor, then prove each name still refers to the retained inode. */
class LocalChain {
 readonly descriptors:number[]=[];readonly components:string[];readonly identities:LocalIdentity[]=[];
 constructor(readonly path:string){
  if(!path.startsWith('/')||path.includes('\0')||path.endsWith('/')||path.length>4096)refuse();
  this.components=path.slice(1).split('/');if(this.components.length>63||this.components.some(p=>!p||p==='.'||p==='..'))refuse();
  try{this.descriptors.push(openSync('/',directoryFlags));for(const part of this.components){const fd=relativeOpen(this.last,part,directoryFlags);if(fd<0)refuse('binding-unavailable');this.descriptors.push(fd);}for(const fd of this.descriptors)this.identities.push(identity(fstatSync(fd,{bigint:true}) as any));this.check();}catch(error){this.close();throw error;}
 }
 get last(){return this.descriptors[this.descriptors.length-1]!;}
 check(){for(let i=0;i<this.descriptors.length;i++){if(!same(identity(fstatSync(this.descriptors[i]!,{bigint:true}) as any),this.identities[i]!))refuse('identity-changed');if(i){const reopened=relativeOpen(this.descriptors[i-1]!,this.components[i-1]!,directoryFlags);if(reopened<0)refuse('identity-changed');try{if(!same(identity(fstatSync(reopened,{bigint:true}) as any),this.identities[i]!))refuse('identity-changed');}finally{closeSync(reopened);}}}}
 installed(){const s=fstatSync(this.last);if(s.uid!==process.getuid?.()||(s.mode&0o022)!==0)refuse('ownership-unavailable');}
 private(){const s=fstatSync(this.last);if(s.uid!==process.getuid?.()||(s.mode&0o777)!==0o700)refuse('ownership-unavailable');}
 close(){for(const fd of this.descriptors.splice(0).reverse())closeSync(fd);}
}
function privateFile(fd:number,max:number){const s=fstatSync(fd);if(!s.isFile()||s.nlink!==1||s.uid!==process.getuid?.()||(s.mode&0o777)!==0o600||s.size>max||s.size<1)refuse('recovery-required');const out=Buffer.alloc(s.size+1);const read=readSync(fd,out,0,out.length,0);if(read!==s.size)refuse('identity-changed');return out.subarray(0,read);}
export interface LocalBindingDescriptor {version:1;provider:'icloud'|'smb-direct';appPath:string;appIdentity:LocalIdentity;configIdentity:LocalIdentity;connectionId:string;generation:string}
interface SelectedPreparation {disabled:boolean;drained:boolean}
export type ResolvedLocalBinding={provider:'icloud';binding:CloudBinding;connectionId:string;generation:string;preparation:SelectedPreparation}|{provider:'smb-direct';binding:DirectSmbBinding;credentials:DirectSmbCredentials;connectionId:string;generation:string;preparation:SelectedPreparation};
function selected(value:Record<string,unknown>,d:LocalBindingDescriptor):Omit<Extract<ResolvedLocalBinding,{provider:'icloud'}>,'provider'>|{binding:DirectSmbBinding;preparation:SelectedPreparation} {
 if(d.provider==='icloud'){
  const v=exact(value,['version','connection']);if(v.version!==1)refuse('recovery-required');const c=exact(v.connection,['id','name','enabled','binding','destinationId','destinationVersion']);
  if(c.id!==d.connectionId||!UUID.test(c.id)||!UUID.test(c.destinationId)||c.destinationVersion!==2||typeof c.enabled!=='boolean'||typeof c.name!=='string'||c.name!==c.name.trim()||c.name.length<1||c.name.length>80||/[\x00-\x1f\x7f]/.test(c.name))refuse('binding-unavailable');
  const binding=cloudBinding(c.binding);const {name,enabled,...parts}=c;const generation=createHash('sha256').update(JSON.stringify(parts)).digest('hex');if(generation!==d.generation)refuse('identity-changed');return {binding,connectionId:c.id,generation,preparation:{disabled:!c.enabled,drained:!c.enabled}};
 }
 if(Object.hasOwn(value,'transition'))refuse('recovery-required');const v=exact(value,['version','connections','cleanup']);if(v.version!==1||!Array.isArray(v.connections)||v.connections.length>8||!Array.isArray(v.cleanup)||v.cleanup.length)refuse('recovery-required');
 const ids=new Set(),refs=new Set();let found:{binding:DirectSmbBinding;preparation:SelectedPreparation}|undefined;
 for(const raw of v.connections){const c=exact(raw,['uncertainty','binding','dialect','enabled','jobs','acknowledged','retryAt','failures','lastSync','imported','skipped','error']);const b=validateDirectBinding(c.binding);
  if(ids.has(b.id)||refs.has(b.credentialRef)||c.uncertainty!==null||typeof c.enabled!=='boolean'||!['3.0','3.0.2','3.1.1'].includes(c.dialect)||!c.jobs||typeof c.jobs!=='object'||Array.isArray(c.jobs)||Object.keys(c.jobs).length>10000||!Array.isArray(c.acknowledged)||c.acknowledged.length>10000||c.acknowledged.some((id:unknown)=>typeof id!=='string'||!UUID.test(id)))refuse('recovery-required');
  for(const [id,rawJob] of Object.entries(c.jobs)){const j=exact(rawJob,['attempts','next']);if(!UUID.test(id)||!Number.isInteger(j.attempts)||j.attempts<0||j.attempts>30||typeof j.next!=='number'||!Number.isFinite(j.next)||j.next<0)refuse('recovery-required');}
  if(['retryAt','failures','imported','skipped'].some(k=>!Number.isSafeInteger(c[k])||c[k]<0)||c.failures>30||(c.lastSync!==null&&(!Number.isSafeInteger(c.lastSync)||c.lastSync<0))||(c.error!==null&&typeof c.error!=='string'))refuse('recovery-required');
  ids.add(b.id);refs.add(b.credentialRef);if(b.id===d.connectionId){if(b.readOnly||b.connectionGeneration!==d.generation)refuse('binding-unavailable');found={binding:b,preparation:{disabled:!c.enabled,drained:!c.enabled&&Object.keys(c.jobs).length===0}};}
 }
 return found??refuse('binding-unavailable');
}
/** Pin only the exact scalar queue name and its absent/present ancestors. No inventory. */
class CloudScalarJobs {
 readonly directories:Array<{parent:number;name:string;fd:number;identity:LocalIdentity}>=[];private missing:{parent:number;name:string;flags:number}|undefined;private file:number|undefined;private bytes:Buffer|undefined;readonly drained:boolean;
 constructor(root:number){
  let parent=root;
  try{for(const name of ['library','catalog']){const fd=relativeOpen(parent,name,directoryFlags);if(fd<0){if(lastErrno!==2)refuse('recovery-required');this.missing={parent,name,flags:directoryFlags};this.drained=true;return;}const info=fstatSync(fd);if(info.uid!==process.getuid?.()||(info.mode&0o022)!==0){closeSync(fd);refuse('ownership-unavailable');}const own=identity(fstatSync(fd,{bigint:true}) as any);this.directories.push({parent,name,fd,identity:own});parent=fd;}
   const name='icloud-jobs.json';this.file=relativeOpen(parent,name,fileFlags);if(this.file<0){this.file=undefined;if(lastErrno!==2)refuse('recovery-required');this.missing={parent,name,flags:fileFlags};this.drained=true;return;}
   this.bytes=privateFile(this.file,4000000);const v=decodeFrame(this.bytes);if(Object.keys(v).some(key=>!['version','jobs','observeCursor'].includes(key))||v.version!==1||!Array.isArray(v.jobs)||v.jobs.length>10000||(v.observeCursor!==undefined&&(typeof v.observeCursor!=='string'||!UUID.test(v.observeCursor))))refuse('recovery-required');
   for(const raw of v.jobs as unknown[]){const j=exact(raw,['revisionId','attempts','next','state']);if(typeof j.revisionId!=='string'||!UUID.test(j.revisionId)||!Number.isInteger(j.attempts)||j.attempts<0||j.attempts>30||typeof j.next!=='number'||!Number.isFinite(j.next)||j.next<0||!['pending-upload','system-reported-uploaded','cloud-full','provider-offline','provider-error'].includes(j.state))refuse('recovery-required');}this.drained=(v.jobs as unknown[]).length===0;this.check();
  }catch(error){this.close();throw error;}
 }
 check(){for(const d of this.directories){const info=fstatSync(d.fd);if(info.uid!==process.getuid?.()||(info.mode&0o022)!==0)refuse('ownership-unavailable');const current=relativeOpen(d.parent,d.name,directoryFlags);if(current<0)refuse('identity-changed');try{if(!same(identity(fstatSync(current,{bigint:true}) as any),d.identity)||!same(identity(fstatSync(d.fd,{bigint:true}) as any),d.identity))refuse('identity-changed');}finally{closeSync(current);}}
  if(this.missing){const fd=relativeOpen(this.missing.parent,this.missing.name,this.missing.flags);if(fd>=0){closeSync(fd);refuse('identity-changed');}if(lastErrno!==2)refuse('identity-changed');}
  if(this.file!==undefined){const current=relativeOpen(this.directories.at(-1)!.fd,'icloud-jobs.json',fileFlags);if(current<0)refuse('identity-changed');try{if(!same(identity(fstatSync(current,{bigint:true}) as any),identity(fstatSync(this.file,{bigint:true}) as any))||!privateFile(current,4000000).equals(this.bytes!)||!privateFile(this.file,4000000).equals(this.bytes!))refuse('identity-changed');}finally{closeSync(current);}}
 }
 close(){if(this.file!==undefined)closeSync(this.file);this.file=undefined;for(const d of this.directories.splice(0).reverse())closeSync(d.fd);}
}
export async function withResolvedLocalBinding<T>(input:LocalBindingDescriptor,run:(binding:ResolvedLocalBinding,verify:()=>void)=>Promise<T>,vault?:Pick<SecretVault,'get'>):Promise<T>{
 let chain:LocalChain|undefined,fd:number|undefined,jobs:CloudScalarJobs|undefined;
 try{
  const raw=exact(input,['version','provider','appPath','appIdentity','configIdentity','connectionId','generation']);
  if(raw.version!==1||!['icloud','smb-direct'].includes(raw.provider)||typeof raw.appPath!=='string'||!UUID.test(raw.connectionId)||typeof raw.generation!=='string'||!(raw.provider==='icloud'?HASH:UUID).test(raw.generation))refuse();
  const d=raw as LocalBindingDescriptor;identityInput(d.appIdentity);identityInput(d.configIdentity);chain=new LocalChain(d.appPath);chain.installed();if(!same(chain.identities.at(-1)!,d.appIdentity))refuse('identity-changed');
  const name=d.provider==='icloud'?'icloud-folder.json':'direct-smb-connections.json';
  const transition=()=>{if(d.provider==='icloud'){const t=relativeOpen(chain!.last,name+'.transition.json',fileFlags);if(t>=0){closeSync(t);refuse('recovery-required');}if(lastErrno!==2)refuse('recovery-required');}};
  transition();fd=relativeOpen(chain.last,name,fileFlags);if(fd<0)refuse('binding-unavailable');if(!same(identity(fstatSync(fd,{bigint:true}) as any),d.configIdentity))refuse('identity-changed');
  const max=d.provider==='icloud'?150000:16_000_000;const bytes=privateFile(fd,max);const parsed=decodeFrame(bytes);const local=selected(parsed,d);if(d.provider==='icloud'){jobs=new CloudScalarJobs(chain.last);(local as any).preparation.drained=(local as any).preparation.disabled&&jobs.drained;}
  const check=()=>{jobs?.check();chain!.check();chain!.installed();transition();const current=relativeOpen(chain!.last,name,fileFlags);if(current<0)refuse('identity-changed');try{if(!same(identity(fstatSync(current,{bigint:true}) as any),d.configIdentity)||!privateFile(current,max).equals(bytes)||!privateFile(fd!,max).equals(bytes))refuse('identity-changed');}finally{closeSync(current);}};
  let binding:ResolvedLocalBinding;
  if(d.provider==='icloud')binding={provider:'icloud',...(local as Omit<Extract<ResolvedLocalBinding,{provider:'icloud'}>,'provider'>)};
  else{if(!vault)refuse('binding-unavailable');const {binding:b,preparation}=local as {binding:DirectSmbBinding;preparation:SelectedPreparation};check();const credentials=validateDirectCredentials(await vault!.get(b.credentialRef));binding={provider:'smb-direct',binding:b,credentials,connectionId:b.id,generation:b.connectionGeneration,preparation};}
  check();const result=await run(binding,check);check();return result;
 }catch(error){if(error instanceof AcceptanceError)throw error;const safe=new AcceptanceError('binding-unavailable');if(error instanceof Error&&Object.getOwnPropertyDescriptor(error,'guardianStopped')?.value===true)Object.defineProperty(safe,'guardianStopped',{value:true,enumerable:false});throw safe;}
 finally{jobs?.close();if(fd!==undefined&&fd>=0)closeSync(fd);chain?.close();}
}

export interface AcceptanceWorkspace {path:string;identity:LocalIdentity;receipts:LocalIdentity;quota:LocalIdentity}
export const ACCEPTANCE_RECEIPT_BYTES=332768;
export const ACCEPTANCE_LEDGER_BYTES=8192;
const RECEIPT_NAMES=['guard','receipt','checkpoint','parent-binding','child-binding'] as const;
function makeDirectory(fd:number,name:string){const value=Buffer.from(name+'\0');if(libc!.symbols.mkdirat(fd,ptr(value),0o700)!==0)refuse('ownership-unavailable');fsyncSync(fd);}
/** The caller supplies a new local directory, never an installed application directory. */
export function createAcceptanceWorkspace(path:string):AcceptanceWorkspace {
 const parent=new LocalChain(dirname(path));let workspace:LocalChain|undefined,receipts:LocalChain|undefined,quota:LocalChain|undefined;
 try{const name=basename(path);if(name==='.'||name==='..'||name.includes('\0'))refuse();parent.check();makeDirectory(parent.last,name);workspace=new LocalChain(path);workspace.private();makeDirectory(workspace.last,'acceptance');makeDirectory(workspace.last,'quota');receipts=new LocalChain(join(path,'acceptance'));quota=new LocalChain(join(path,'quota'));parent.check();return {path,identity:workspace.identities.at(-1)!,receipts:receipts.identities.at(-1)!,quota:quota.identities.at(-1)!};}
 finally{quota?.close();receipts?.close();workspace?.close();parent.close();}
}
function knownQuotaEntries(chain:LocalChain){
 chain.check();const copy=relativeOpen(chain.last,'.',directoryFlags);if(copy<0)refuse('recovery-required');const directory=libc!.symbols.fdopendir(copy);if(!directory){closeSync(copy);refuse('recovery-required');}
 try{let seen=0,reads=0;const buffer=Buffer.alloc(256);while(true){const length=shim!.symbols.qa_directory_name(directory,ptr(buffer),buffer.length);if(length===0)break;if(length<0||++reads>6)refuse('recovery-required');const name=buffer.subarray(0,length).toString('utf8');if(name==='.'||name==='..')continue;if(++seen>3||name!=='ledger')refuse('recovery-required');}}
 finally{libc!.symbols.closedir(directory);}
 chain.check();
}
function absent(fd:number,name:string){const file=relativeOpen(fd,name,fileFlags);if(file>=0){closeSync(file);refuse('recovery-required');}if(lastErrno!==2)refuse('recovery-required');}
function fixedLedger(value:unknown,runId:string,paths:string[]){
 const v=exact(value,['version','reservations','atomicWrites']);if(v.version!==1||!v.reservations||typeof v.reservations!=='object'||Array.isArray(v.reservations)||!v.atomicWrites||Object.keys(v.atomicWrites).length)refuse('recovery-required');
 for(const [id,raw] of Object.entries(v.reservations)){const r=exact(raw,['bytes','paths']);const expected=id===`qa-bootstrap-${runId}`?{bytes:ACCEPTANCE_RECEIPT_BYTES,paths}:id===`qa-ledger-${runId}`?{bytes:ACCEPTANCE_LEDGER_BYTES,paths:[]}:null;if(!expected||JSON.stringify(r)!==JSON.stringify(expected))refuse('recovery-required');}
 if(Buffer.byteLength(JSON.stringify(v))>4096)refuse('recovery-required');return v;
}
function canonical(value:unknown):string {
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical((value as Record<string,unknown>)[key])).join(',')+'}';
 return JSON.stringify(value);
}
function logFrames(bytes:Buffer,kind:'receipt'|'ledger'){
 if(!bytes.length||bytes.at(-1)!==10)refuse('recovery-required');
 const lines=bytes.toString('utf8').slice(0,-1).split('\n');if(lines.length<2||lines.length>(kind==='receipt'?5:3))refuse('recovery-required');
 const frames=lines.map(line=>decodeFrame(Buffer.from(line)));
 const header=exact(frames[0],kind==='receipt'?['format','version','identity','scope']:['format','version','identity']);
 if(header.format!=='heed-qa-'+kind||header.version!==2)refuse('recovery-required');
 return {header,records:frames.slice(1)};
}
/** Append only through the retained original file; never rename over a namespace entry. */
class AcceptanceLedger implements QuotaLedgerStorage {
 private fd:number|undefined;private original:LocalIdentity|undefined;private committed=Buffer.alloc(0);private header:Record<string,unknown>|undefined;private records:Record<string,any>[]=[];
 constructor(readonly chain:LocalChain,readonly runId:string,readonly paths:string[]){}
 private lock(){if(libc!.symbols.flock(this.fd!,2|4)!==0)refuse('recovery-required');} // Darwin LOCK_EX | LOCK_NB; close releases only this owned FD.
 private check(expected=this.committed){
  this.chain.check();knownQuotaEntries(this.chain);const current=relativeOpen(this.chain.last,'ledger',fileFlags);if(current<0||this.fd===undefined)refuse('recovery-required');
  try{for(const fd of [current,this.fd!]){const stat=fstatSync(fd,{bigint:true});if(!same(identity(stat as any),this.original!)||!stat.isFile()||stat.nlink!==1n||stat.uid!==BigInt(process.getuid!())||(stat.mode&0o777n)!==0o600n||stat.size!==BigInt(expected.length))refuse('identity-changed');const bytes=Buffer.alloc(expected.length+1);if(readSync(fd,bytes,0,bytes.length,0)!==expected.length||!bytes.subarray(0,expected.length).equals(expected))refuse('identity-changed');}}
  finally{closeSync(current);}
 }
 load():unknown|null {
  if(this.fd!==undefined){this.check();return this.records.at(-1)??null;}
  knownQuotaEntries(this.chain);this.fd=relativeOpen(this.chain.last,'ledger',constants.O_RDWR|constants.O_APPEND|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  if(this.fd<0){if(lastErrno!==2)refuse('recovery-required');this.fd=relativeOpen(this.chain.last,'ledger',constants.O_RDWR|constants.O_APPEND|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);if(this.fd<0)refuse('recovery-required');this.lock();this.original=identity(fstatSync(this.fd,{bigint:true}) as any);this.header={format:'heed-qa-ledger',version:2,identity:this.original};this.check();return null;}
  this.lock();this.original=identity(fstatSync(this.fd,{bigint:true}) as any);this.committed=privateFile(this.fd,4096);const {header,records}=logFrames(this.committed,'ledger');
  if(!same(identityInput(header.identity),this.original))refuse('identity-changed');this.header=header;
  for(let index=0;index<records.length;index++){const value=fixedLedger(records[index],this.runId,this.paths),ids=Object.keys(value.reservations);if(ids.length!==index+1||!ids.includes('qa-ledger-'+this.runId))refuse('recovery-required');this.records.push(structuredClone(value));}
  this.check();fsyncSync(this.fd);fsyncSync(this.chain.last);this.check();return this.records.at(-1)!;
 }
 predict(values:unknown[]){if(!this.header)refuse('recovery-required');const bytes=Buffer.byteLength([this.header,...values].map(canonical).join('\n')+'\n');if(bytes>4096)refuse('recovery-required');}
 save(input:unknown){
  const value=fixedLedger(input,this.runId,this.paths);this.check();if(this.records.length&&canonical(this.records.at(-1))===canonical(value))return;
  const ids=Object.keys(value.reservations);if(this.records.length>=2||ids.length!==this.records.length+1||!ids.includes('qa-ledger-'+this.runId))refuse('recovery-required');
  const addition=Buffer.from((this.committed.length?'':canonical(this.header)+'\n')+canonical(value)+'\n'),expected=Buffer.concat([this.committed,addition]);if(expected.length>4096)refuse('recovery-required');
  let offset=0;while(offset<addition.length){const written=writeSync(this.fd!,addition,offset,addition.length-offset);if(written<=0)refuse('recovery-required');offset+=written;}
  fsyncSync(this.fd!);fsyncSync(this.chain.last);this.check(expected);this.committed=expected;this.records.push(structuredClone(value));
 }
 close(){if(this.fd!==undefined&&this.fd>=0){closeSync(this.fd);this.fd=undefined;}}
}
export function openAcceptanceQuota(descriptor:AcceptanceWorkspace,runId:string,limitBytes:number){
 if(!UUID.test(runId)||!Number.isSafeInteger(limitBytes)||limitBytes<ACCEPTANCE_RECEIPT_BYTES+ACCEPTANCE_LEDGER_BYTES)refuse();
 const workspace=new LocalChain(descriptor.path);let receipts:LocalChain|undefined,quota:LocalChain|undefined,ledgerStorage:AcceptanceLedger|undefined;
 try{workspace.private();receipts=new LocalChain(join(descriptor.path,'acceptance'));receipts.private();quota=new LocalChain(join(descriptor.path,'quota'));quota.private();
  const verifyIdentities=()=>{for(const [chain,expected] of [[workspace,descriptor.identity],[receipts!,descriptor.receipts],[quota!,descriptor.quota]] as const){chain.check();chain.private();if(!same(chain.identities.at(-1)!,identityInput(expected)))refuse('identity-changed');}};verifyIdentities();
  const paths=RECEIPT_NAMES.map(name=>join(descriptor.path,'acceptance',name)).sort();const expected={version:1,reservations:{[`qa-ledger-${runId}`]:{bytes:ACCEPTANCE_LEDGER_BYTES,paths:[]},[`qa-bootstrap-${runId}`]:{bytes:ACCEPTANCE_RECEIPT_BYTES,paths}},atomicWrites:{}};fixedLedger(expected,runId,paths);
  ledgerStorage=new AcceptanceLedger(quota,runId,paths);const managed=new ManagedQuota({ledgerPath:join(descriptor.path,'quota','ledger'),ledgerStorage,roots:{text:paths},getLimit:()=>limitBytes,setLimit:()=>refuse(),protectedPaths:()=>paths});
  ledgerStorage.predict([{version:1,reservations:{[`qa-ledger-${runId}`]:{bytes:ACCEPTANCE_LEDGER_BYTES,paths:[]}},atomicWrites:{}},expected]);
  verifyIdentities();managed.reserve(`qa-ledger-${runId}`,ACCEPTANCE_LEDGER_BYTES,[]);verifyIdentities();managed.reserve(`qa-bootstrap-${runId}`,ACCEPTANCE_RECEIPT_BYTES,paths);verifyIdentities();
  const verify=()=>{verifyIdentities();const ledger=fixedLedger(ledgerStorage!.load(),runId,paths);if(Object.keys(ledger.reservations).length!==2)refuse('recovery-required');let size=0;for(const name of RECEIPT_NAMES){const fd=relativeOpen(receipts!.last,name,fileFlags);if(fd<0){if(lastErrno!==2)refuse('recovery-required');continue;}try{const max=name==='guard'?0:['receipt','checkpoint'].includes(name)?16384:150000;const info=fstatSync(fd);if(!info.isFile()||info.nlink!==1||info.uid!==process.getuid?.()||(info.mode&0o777)!==0o600||info.size>max)refuse('recovery-required');size+=info.size;}finally{closeSync(fd);}}if(size>ACCEPTANCE_RECEIPT_BYTES)refuse('recovery-required');verifyIdentities();};verify();
  let closed=false;return {verify,snapshot:()=>{verify();const result=managed.snapshot();verify();return result;},close:()=>{if(!closed){closed=true;ledgerStorage!.close();quota!.close();receipts!.close();workspace.close();}}};
 }catch(error){ledgerStorage?.close();quota?.close();receipts?.close();workspace.close();throw error;}
}

interface AcceptanceNatives {cloud?:CloudAcceptanceNative;smb?:DirectSmbAcceptanceNative;vault?:Pick<SecretVault,'get'>}
export interface ProvisioningEvidence {runId:string;destinationId:string;provider:'icloud'|'smb-direct';destinationVersion:2|3;child:string;initialized:true}
export function provisioningEvidence(spec:AcceptanceSpec):ProvisioningEvidence {return {runId:spec.runId,destinationId:spec.destinationId,provider:spec.provider,destinationVersion:spec.destinationVersion,child:spec.child,initialized:true};}
export async function observeSelectedBinding(descriptor:LocalBindingDescriptor,natives:AcceptanceNatives={},signal?:AbortSignal){
 return withResolvedLocalBinding(descriptor,async local=>{
  signal?.throwIfAborted();
  if(local.provider==='icloud'){
   const result=exact(await (natives.cloud??new MacCloudNative()).acceptance({action:'qa-observe-parent',binding:local.binding},signal),['identity','ancestors','accountMatched','ubiquitous']);
   if(result.identity!==local.binding.identity||result.accountMatched!==true||result.ubiquitous!==true||!Array.isArray(result.ancestors)||!result.ancestors.length||result.ancestors.length>64||result.ancestors.some((v:unknown)=>typeof v!=='string'||!/^\d+:\d+:\d+:\d+$/.test(v)))refuse('identity-changed');
  }else{
   const result=exact(await (natives.smb??new PythonDirectSmbNative()).acceptance({action:'qa-observe-parent',endpoint:local.binding.endpoint,credentials:local.credentials,identity:local.binding.identity},signal),['identity','ancestors','security','readOnly','namespaceSafe']);
   if(!sameDirectIdentity(validateDirectIdentity(result.identity),local.binding.identity)||!Array.isArray(result.ancestors)||!result.ancestors.length||result.ancestors.length>64||!['signed','encrypted'].includes(result.security)||local.binding.security==='encrypted'&&result.security!=='encrypted'||result.namespaceSafe!==true||typeof result.readOnly!=='boolean')refuse('identity-changed');
  }
  return {category:'observation-complete' as const,provider:local.provider,connectionId:local.connectionId,identityMatched:true};
 },natives.vault??(descriptor.provider==='smb-direct'?createKeychainVault():undefined));
}
function localReceiptPreflight(workspace:AcceptanceWorkspace,runId:string){
 const chain=new LocalChain(join(workspace.path,'acceptance'));
 try{
  chain.private();if(!same(chain.identities.at(-1)!,workspace.receipts))refuse('identity-changed');absent(chain.last,'checkpoint');
  const fd=relativeOpen(chain.last,'receipt',fileFlags);
  if(fd<0){if(lastErrno!==2)refuse('recovery-required');for(const name of ['guard','parent-binding','child-binding'])absent(chain.last,name);return;}
  let receipt:Record<string,unknown>;try{const frames=logFrames(privateFile(fd,16384),'receipt');const own=identity(fstatSync(fd,{bigint:true}) as any),saved=frames.header.identity;if(!(Array.isArray(saved)?saved[0]===own.device&&saved[1]===own.inode:typeof saved==='string'&&saved.split(':')[0]===own.device&&saved.split(':')[1]===own.inode))refuse('ownership-unavailable');const scope=frames.header.scope as Record<string,unknown>;const phases=scope?.role==='creator'?['prepared','allocating','allocated','initialized']:['prepared','joined'];for(let index=0;index<frames.records.length;index++){const record=exact(frames.records[index],['phase','child','childFile']);if(record.phase!==phases[index])refuse('recovery-required');}receipt={...scope,...frames.records.at(-1)};}finally{closeSync(fd);}
  const origin=receipt.origin as Record<string,unknown>|undefined;const spec=receipt.spec as Record<string,unknown>|undefined;
  if(receipt.version!==2||!origin||spec?.runId!==runId||!['creator','participant'].includes(String(receipt.role))||!['prepared','allocating','allocated','initialized','joined'].includes(String(receipt.phase)))refuse('recovery-required');
  const guard=relativeOpen(chain.last,'guard',fileFlags);if(guard<0)refuse('recovery-required');try{const info=fstatSync(guard,{bigint:true});if(!info.isFile()||info.nlink!==1n||info.uid!==BigInt(process.getuid!())||(info.mode&0o777n)!==0o600n||info.size!==0n)refuse('recovery-required');
   const matches=(value:unknown,expected:LocalIdentity)=>Array.isArray(value)?value.length===3&&value[0]===expected.device&&value[1]===expected.inode:typeof value==='string'&&value.split(':')[0]===expected.device&&value.split(':')[1]===expected.inode;
   if(!matches(origin!.workspace,workspace.identity)||!matches(origin!.receipts,workspace.receipts)||!matches(origin!.guard,identity(info as any)))refuse('ownership-unavailable');
  }finally{closeSync(guard);}
  for(const name of ['parent-binding','child-binding']){const file=relativeOpen(chain.last,name,fileFlags);if(file<0){if(lastErrno!==2||name==='parent-binding'||['initialized','joined'].includes(String(receipt.phase)))refuse('recovery-required');continue;}try{decodeFrame(privateFile(file,150000));}finally{closeSync(file);}}
  chain.check();
 }finally{chain.close();}
}
interface BootstrapInput {descriptor:LocalBindingDescriptor;workspace:AcceptanceWorkspace;spec:AcceptanceSpec;limitBytes:number}
export async function createOwnedChild(input:BootstrapInput,natives:AcceptanceNatives={},signal?:AbortSignal){return prepareOwnedChild(input,'creator',undefined,natives,signal);}
export async function joinOwnedChild(input:BootstrapInput,evidence:ProvisioningEvidence,natives:AcceptanceNatives={},signal?:AbortSignal){return prepareOwnedChild(input,'participant',evidence,natives,signal);}
async function prepareOwnedChild(input:BootstrapInput,role:'creator'|'participant',evidence:ProvisioningEvidence|undefined,natives:AcceptanceNatives,signal?:AbortSignal){
 const spec=parseAcceptanceSpec(input.spec);if(spec.provider!==input.descriptor.provider)refuse();
 if(role==='participant'){const actual=exact(evidence,['runId','destinationId','provider','destinationVersion','child','initialized']);if(Object.entries(provisioningEvidence(spec)).some(([key,value])=>actual[key]!==value))refuse();}
 localReceiptPreflight(input.workspace,spec.runId);
 return withResolvedLocalBinding(input.descriptor,async local=>{
  if(!local.preparation.disabled||!local.preparation.drained)refuse('binding-unavailable');
  localReceiptPreflight(input.workspace,spec.runId);const quota=openAcceptanceQuota(input.workspace,spec.runId,input.limitBytes);
  try{
   signal?.throwIfAborted();quota.verify();const action=role==='creator'?'qa-create-child':'qa-join-child',selectedScope=role==='creator'?'parent':'child';
   const result=local.provider==='icloud'?await (natives.cloud??new MacCloudNative()).acceptance({action,binding:local.binding,connectionGeneration:local.generation,spec,workspace:input.workspace,selectedScope,...(evidence?{evidence}:{})},signal):await (natives.smb??new PythonDirectSmbNative()).acceptance({action,binding:local.binding,endpoint:local.binding.endpoint,credentials:local.credentials,spec,workspace:input.workspace,selectedScope,...(evidence?{evidence}:{})},signal);
   const response=exact(result,local.provider==='icloud'?['role','binding','generation','phase','cleanup']:['role','binding','phase','cleanup']);
   if(response.role!==role||response.phase!==(role==='creator'?'initialized':'joined')||response.cleanup!=='retained-owned-child-and-immutable-audio')refuse('recovery-required');
   const child=local.provider==='icloud'?cloudBinding(response.binding):validateDirectBinding(response.binding);
   if(local.provider==='smb-direct'){const direct=child as DirectSmbBinding;if(direct.destinationId!==spec.destinationId||direct.endpoint.folder.split('/').at(-1)!==spec.child||direct.credentialRef!==local.binding.credentialRef||direct.endpoint.server!==local.binding.endpoint.server||direct.endpoint.share!==local.binding.endpoint.share)refuse('identity-changed');}
   else if(typeof response.generation!=='string'||!UUID.test(response.generation))refuse('recovery-required');
   quota.verify();localReceiptPreflight(input.workspace,spec.runId);
   return {private:{workspace:input.workspace,spec,role,binding:child,generation:local.provider==='icloud'?response.generation:(child as DirectSmbBinding).connectionGeneration},public:{category:'observation-complete' as const,...provisioningEvidence(spec),role,cleanup:'retained-owned-child-and-immutable-audio' as const}};
  }finally{quota.close();}
 },natives.vault??(input.descriptor.provider==='smb-direct'?createKeychainVault():undefined));
}

export interface BindingIssueRequest {provider:'icloud'|'smb-direct';appPath:string;connectionId:string}
/** Issue only from the pinned selected config; never derive authority from a later path lookup. */
export async function withIssuedLocalBinding<T>(request:BindingIssueRequest,run:(descriptor:LocalBindingDescriptor,local:ResolvedLocalBinding)=>Promise<T>,dependencies:{vault?:Pick<SecretVault,'get'>;smb?:Pick<PythonDirectSmbNative,'pending'>}={},signal?:AbortSignal):Promise<T>{
 let chain:LocalChain|undefined,fd:number|undefined;
 try{
  const v=exact(request,['provider','appPath','connectionId']);if(!['icloud','smb-direct'].includes(v.provider)||typeof v.appPath!=='string'||!UUID.test(v.connectionId))refuse();
  signal?.throwIfAborted();chain=new LocalChain(v.appPath);chain.installed();const name=v.provider==='icloud'?'icloud-folder.json':'direct-smb-connections.json';
  fd=relativeOpen(chain.last,name,fileFlags);if(fd<0)refuse('binding-unavailable');const bytes=privateFile(fd,v.provider==='icloud'?150000:16000000),parsed=decodeFrame(bytes);
  // The complete shape is validated by the existing selected parser below.
  const connection=v.provider==='icloud'?parsed.connection:(Array.isArray(parsed.connections)?parsed.connections.find((c:any)=>c?.binding?.id===v.connectionId)?.binding:undefined);
  if(!connection||typeof connection!=='object')refuse('binding-unavailable');let generation:string;
  if(v.provider==='icloud'){const {name,enabled,...parts}=connection as Record<string,unknown>;generation=createHash('sha256').update(JSON.stringify(parts)).digest('hex');}else generation=(connection as any).connectionGeneration;
  const descriptor:LocalBindingDescriptor={version:1,provider:v.provider,appPath:v.appPath,appIdentity:chain.identities.at(-1)!,configIdentity:identity(fstatSync(fd,{bigint:true}) as any),connectionId:v.connectionId,generation};
  const verify=()=>{signal?.throwIfAborted();chain!.check();chain!.installed();const current=relativeOpen(chain!.last,name,fileFlags);if(current<0)refuse('identity-changed');try{if(!same(identity(fstatSync(current,{bigint:true}) as any),descriptor.configIdentity)||!privateFile(current,bytes.length).equals(bytes)||!privateFile(fd!,bytes.length).equals(bytes))refuse('identity-changed');}finally{closeSync(current);}};
  verify();const result=await withResolvedLocalBinding(descriptor,async local=>{verify();const pending=local.provider==='smb-direct'?(dependencies.smb??new PythonDirectSmbNative()):undefined;if(pending){const jobs=await pending.pending((local as Extract<ResolvedLocalBinding,{provider:'smb-direct'}>).binding,descriptor.appPath,signal);if(jobs.length)local.preparation.drained=false;verify();}const result=await run(descriptor,local);verify();if(pending){const jobs=await pending.pending((local as Extract<ResolvedLocalBinding,{provider:'smb-direct'}>).binding,descriptor.appPath,signal);if(jobs.length)refuse('recovery-required');verify();}return result;},dependencies.vault??(v.provider==='smb-direct'?createKeychainVault():undefined));verify();return result;
 }catch(error){if(error instanceof AcceptanceError)throw error;throw new AcceptanceError('binding-unavailable');}
 finally{if(fd!==undefined&&fd>=0)closeSync(fd);chain?.close();}
}
export interface PinnedQaDirectory {readonly identity:LocalIdentity;verify():void;issue(name:string,value:Record<string,unknown>,maximum:number):void;read(name:string,maximum:number):Record<string,unknown>}
/** Small shared descriptor-only primitives for new immutable QA files, not ownership parsing. */
export async function withPinnedQaDirectory<T>(path:string,expected:LocalIdentity|undefined,run:(directory:PinnedQaDirectory)=>Promise<T>):Promise<T>{
 let chain:LocalChain|undefined,active=true;
 try{
  chain=new LocalChain(path);chain.private();const own=chain.identities.at(-1)!;if(expected&&!same(own,identityInput(expected)))refuse('identity-changed');
  const verify=()=>{if(!active)refuse('ownership-unavailable');chain!.check();chain!.private();};
  const input=(name:string,max:number)=>{verify();if(typeof name!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(name)||!Number.isSafeInteger(max)||max<1||max>1048576)refuse();};
  const read=(name:string,max:number)=>{input(name,max);const fd=relativeOpen(chain!.last,name,fileFlags);if(fd<0)refuse('recovery-required');try{const bytes=privateFile(fd,max);if(bytes.at(-1)!==10||bytes.subarray(0,-1).includes(10))refuse('recovery-required');const frame=exact(decodeFrame(bytes.subarray(0,-1)),['format','version','identity','value']);if(frame.format!=='heed-qa-private'||frame.version!==1||!same(identity(fstatSync(fd,{bigint:true}) as any),identityInput(frame.identity))||!frame.value||typeof frame.value!=='object'||Array.isArray(frame.value))refuse('identity-changed');const current=relativeOpen(chain!.last,name,fileFlags);if(current<0)refuse('identity-changed');try{if(!same(identity(fstatSync(current,{bigint:true}) as any),identityInput(frame.identity))||!privateFile(current,max).equals(bytes))refuse('identity-changed');}finally{closeSync(current);}verify();return structuredClone(frame.value);}finally{closeSync(fd);}};
  const issue=(name:string,value:Record<string,unknown>,max:number)=>{input(name,max);const fd=relativeOpen(chain!.last,name,constants.O_RDWR|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);if(fd<0)refuse('recovery-required');try{const frame={format:'heed-qa-private',version:1,identity:identity(fstatSync(fd,{bigint:true}) as any),value};const bytes=Buffer.from(canonical(frame)+'\n');if(bytes.length>max)refuse('recovery-required');decodeFrame(bytes);let offset=0;while(offset<bytes.length){const written=writeSync(fd,bytes,offset,bytes.length-offset);if(written<=0)refuse('recovery-required');offset+=written;}fsyncSync(fd);fsyncSync(chain!.last);verify();const actual=read(name,max);if(canonical(actual)!==canonical(value))refuse('identity-changed');}finally{closeSync(fd);}};
  const result=await run({identity:own,verify,issue,read});verify();return result;
 }catch(error){if(error instanceof AcceptanceError)throw error;throw new AcceptanceError('ownership-unavailable');}
 finally{active=false;chain?.close();}
}
/** Reuse the reviewed schema-v2 preflight before launching original-authority proof. */
export function preflightOwnedWorkspace(workspace:AcceptanceWorkspace,runId:string){localReceiptPreflight(workspace,runId);}

/** Explicit originals for a tree operation, never discovered by matching bytes. */
export interface QaTreeProof {path:string;identity:LocalIdentity;kind:'directory'|'file';policy:'private'|'installed'}
export interface PinnedQaTree {
 readonly path:string;readonly identity:LocalIdentity;
 verify():void;stat(proofs:readonly QaTreeProof[]):import('../local-store-io').LocalStoreStat;
 absent(parents:readonly QaTreeProof[],name:string):void;
 list(parents:readonly QaTreeProof[],maximum:number):string[];
 createDirectory(parents:readonly QaTreeProof[],name:string):LocalIdentity;
 openRead(proofs:readonly QaTreeProof[],maximum:number):import('../local-store-io').LocalReadHandle;
 createFile(parents:readonly QaTreeProof[],name:string,maximum:number):import('../local-store-io').LocalWriteHandle;
 promote(source:readonly QaTreeProof[],parents:readonly QaTreeProof[],name:string,target?:QaTreeProof):void;
 unlink(proofs:readonly QaTreeProof[]):void;syncDirectory(parents:readonly QaTreeProof[]):void;
}
function boundedInteger(value:number,maximum=Number.MAX_SAFE_INTEGER){if(!Number.isSafeInteger(value)||value<0||value>maximum)refuse();return value;}
function structuralStat(fd:number):import('../local-store-io').LocalStoreStat {
 const s=fstatSync(fd);
 for(const key of ['dev','ino','size','uid','mode','nlink'] as const)boundedInteger(s[key]);
 for(const key of ['birthtimeMs','mtimeMs'] as const)if(!Number.isFinite(s[key])||s[key]<0)refuse('identity-changed');
 return {dev:s.dev,ino:s.ino,birthtimeMs:s.birthtimeMs,size:s.size,mtimeMs:s.mtimeMs,uid:s.uid,mode:s.mode,nlink:s.nlink,isFile:()=>s.isFile(),isDirectory:()=>s.isDirectory(),isSymbolicLink:()=>s.isSymbolicLink()};
}
function treeName(name:string){if(typeof name!=='string'||!name||name==='.'||name==='..'||name.includes('/')||name.includes('\0')||Buffer.byteLength(name)>255)refuse();return name;}
function treePermission(fd:number,kind:QaTreeProof['kind'],policy:QaTreeProof['policy']){
 const info=structuralStat(fd);
 if(info.uid!==process.getuid?.()||!(kind==='directory'?info.isDirectory():info.isFile())||(kind==='file'&&info.nlink!==1)||(policy==='private'?(info.mode&0o777)!==(kind==='directory'?0o700:0o600):(info.mode&0o022)!==0))refuse('ownership-unavailable');
 return info;
}
/** Callback-scoped descriptors. mkdirat provides no creator FD/inode: after parent fsync,
 * a same-UID substitution before first no-follow open/validation/issuance is unsupported
 * and can become the recorded parent for descendant effects. Confinement against
 * substituted ancestors is conditional on genuine original-parent issuance.
 * Ordinary rename/unlink namespace effects also remain outside inode-CAS guarantees. */
export async function withPinnedQaTree<T>(path:string,originalRootIdentity:LocalIdentity,run:(tree:PinnedQaTree)=>Promise<T>):Promise<T>{
 const chain=new LocalChain(path),directories=new Map<string,{fd:number;proof:QaTreeProof;parent:number;name:string}>(),handles=new Set<{close():void}>(),known=new Set<string>();let live=true;
 try{
  identityInput(originalRootIdentity);chain.installed();if(!same(chain.identities.at(-1)!,originalRootIdentity))refuse('identity-changed');
  const verify=()=>{if(!live)refuse('identity-changed');chain.check();chain.installed();for(const d of directories.values()){treePermission(d.fd,'directory',d.proof.policy);if(!same(identity(fstatSync(d.fd,{bigint:true}) as any),d.proof.identity))refuse('identity-changed');const fd=relativeOpen(d.parent,d.name,directoryFlags);if(fd<0)refuse('identity-changed');try{if(!same(identity(fstatSync(fd,{bigint:true}) as any),d.proof.identity))refuse('identity-changed');}finally{closeSync(fd);}}};
  const remember=(path:string)=>{known.add(path);if(known.size>512)refuse('recovery-required');};
  const directory=(proofs:readonly QaTreeProof[])=>{
   verify();if(proofs.length>16)refuse('recovery-required');let parent=chain.last,prefix='';
   for(const proof of proofs){exact(proof,['path','identity','kind','policy']);if(proof.kind!=='directory'||!['private','installed'].includes(proof.policy))refuse();identityInput(proof.identity);const name=treeName(proof.path.slice(prefix?prefix.length+1:0));const expected=prefix?prefix+'/'+name:name;if(proof.path!==expected)refuse();remember(expected);let entry=directories.get(expected);
    if(entry){if(!same(entry.proof.identity,proof.identity)||entry.proof.policy!==proof.policy)refuse('identity-changed');}
    else{const fd=relativeOpen(parent,name,directoryFlags);if(fd<0)refuse('identity-changed');try{treePermission(fd,'directory',proof.policy);if(!same(identity(fstatSync(fd,{bigint:true}) as any),proof.identity))refuse('identity-changed');}catch(error){closeSync(fd);throw error;}entry={fd,proof:structuredClone(proof),parent,name};directories.set(expected,entry);}
    parent=entry.fd;prefix=expected;
   }
   verify();return parent;
  };
  const leaf=(proofs:readonly QaTreeProof[])=>{if(!proofs.length||proofs.length>16)refuse();const proof=proofs.at(-1)!;exact(proof,['path','identity','kind','policy']);if(!['directory','file'].includes(proof.kind)||!['private','installed'].includes(proof.policy))refuse();identityInput(proof.identity);const parents=proofs.slice(0,-1),parent=directory(parents),prefix=parents.at(-1)?.path;const name=treeName(proof.path.slice(prefix?prefix.length+1:0));if(proof.path!==(prefix?prefix+'/'+name:name))refuse();remember(proof.path);return {parent,name,proof};};
  const original=(proofs:readonly QaTreeProof[])=>{const entry=leaf(proofs),fd=relativeOpen(entry.parent,entry.name,entry.proof.kind==='directory'?directoryFlags:fileFlags);if(fd<0)refuse('identity-changed');try{treePermission(fd,entry.proof.kind,entry.proof.policy);if(!same(identity(fstatSync(fd,{bigint:true}) as any),entry.proof.identity))refuse('identity-changed');return {fd,...entry};}catch(error){closeSync(fd);throw error;}};
  const absentName=(parent:number,name:string)=>{const fd=relativeOpen(parent,treeName(name),fileFlags);if(fd>=0){closeSync(fd);refuse('destination-exists');}if(lastErrno!==2)refuse('identity-changed');};
  const readHandle=(proofs:readonly QaTreeProof[],maximum:number)=>{
   boundedInteger(maximum);if(handles.size>=512)refuse('recovery-required');const entry=original(proofs);if(entry.proof.kind!=='file'){closeSync(entry.fd);refuse();}let closed=false;
   const check=()=>{if(closed)refuse('identity-changed');verify();treePermission(entry.fd,'file',entry.proof.policy);if(!same(identity(fstatSync(entry.fd,{bigint:true}) as any),entry.proof.identity))refuse('identity-changed');const current=original(proofs);closeSync(current.fd);};
   const handle={identity:Object.freeze({...entry.proof.identity}),verify:check,readAt(offset:number,count:number){boundedInteger(offset);boundedInteger(count,maximum);if(offset>maximum||count>maximum-offset)refuse();check();const out=Buffer.alloc(count);let total=0;while(total<count){check();const n=readSync(entry.fd,out,total,count-total,offset+total);boundedInteger(n,count-total);if(!n)break;total+=n;check();}check();return out.subarray(0,total);},close(){if(closed)return;closed=true;handles.delete(handle);closeSync(entry.fd);}};
   handles.add(handle);return handle;
  };
  const tree:PinnedQaTree={path,identity:Object.freeze({...originalRootIdentity}),verify,
   stat(proofs){if(!proofs.length){verify();return structuralStat(chain.last);}const entry=original(proofs);try{const info=structuralStat(entry.fd);verify();return info;}finally{closeSync(entry.fd);}},
   absent(parents,name){const parent=directory(parents);absentName(parent,name);verify();},
   list(parents,maximum){boundedInteger(maximum,512);const parent=directory(parents);maximum=Math.min(maximum,512-known.size);const copy=relativeOpen(parent,'.',directoryFlags);if(copy<0)refuse('identity-changed');const dir=libc!.symbols.fdopendir(copy);if(!dir){closeSync(copy);refuse('recovery-required');}const names:string[]=[];try{let reads=0;const bytes=Buffer.alloc(256);while(true){const length=shim!.symbols.qa_directory_name(dir,ptr(bytes),bytes.length);if(!length)break;if(length<0||++reads>maximum+2)refuse('recovery-required');const name=bytes.subarray(0,length).toString('utf8');if(name==='.'||name==='..')continue;treeName(name);if(names.length>=maximum)refuse('recovery-required');names.push(name);}}finally{libc!.symbols.closedir(dir);}verify();return names;},
   createDirectory(parents,name){if(parents.length>=16)refuse('recovery-required');chain.private();const parent=directory(parents);absentName(parent,name);remember(parents.at(-1)?.path?parents.at(-1)!.path+'/'+name:name);makeDirectory(parent,name);const fd=relativeOpen(parent,name,directoryFlags);if(fd<0)refuse('identity-changed');try{treePermission(fd,'directory','private');const own=identity(fstatSync(fd,{bigint:true}) as any),path=parents.at(-1)?.path?parents.at(-1)!.path+'/'+name:name;directories.set(path,{fd,proof:{path,identity:own,kind:'directory',policy:'private'},parent,name});verify();return own;}catch(error){if(![...directories.values()].some(d=>d.fd===fd))closeSync(fd);throw error;}},
   openRead:readHandle,
   createFile(parents,name,maximum){if(parents.length>=16)refuse('recovery-required');boundedInteger(maximum);if(handles.size>=512)refuse('recovery-required');chain.private();const parent=directory(parents);absentName(parent,name);remember(parents.at(-1)?.path?parents.at(-1)!.path+'/'+name:name);const fd=relativeOpen(parent,name,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);if(fd<0)refuse('destination-exists');let closed=false;let total=0;const own=identity(fstatSync(fd,{bigint:true}) as any);
    const check=()=>{if(closed)refuse('identity-changed');verify();treePermission(fd,'file','private');if(!same(identity(fstatSync(fd,{bigint:true}) as any),own))refuse('identity-changed');const current=relativeOpen(parent,name,fileFlags);if(current<0)refuse('identity-changed');try{if(!same(identity(fstatSync(current,{bigint:true}) as any),own))refuse('identity-changed');}finally{closeSync(current);}};
    const handle={identity:Object.freeze({...own}),verify:check,append(chunk:Uint8Array){if(!(chunk instanceof Uint8Array)||chunk.byteLength>maximum-total)refuse();check();let written=0;while(written<chunk.byteLength){check();const n=writeSync(fd,chunk,written,chunk.byteLength-written);if(!Number.isSafeInteger(n)||n<=0||n>chunk.byteLength-written)refuse('recovery-required');written+=n;total+=n;check();}},sync(){check();fsyncSync(fd);check();},close(){if(closed)return;closed=true;handles.delete(handle);closeSync(fd);}};
    try{treePermission(fd,'file','private');check();handles.add(handle);return handle;}catch(error){handle.close();throw error;}
   },
   promote(source,parents,name,target){if(parents.length>=16)refuse('recovery-required');chain.private();const src=original(source);try{if(src.proof.kind!=='file')refuse();const destination=directory(parents);if(target){const check=original([...parents,target]);closeSync(check.fd);}else absentName(destination,name);const from=Buffer.from(src.name+'\0'),to=Buffer.from(treeName(name)+'\0');if(libc!.symbols.renameat(src.parent,ptr(from),destination,ptr(to))!==0)refuse('recovery-required');const fd=relativeOpen(destination,name,fileFlags);if(fd<0)refuse('identity-changed');try{if(!same(identity(fstatSync(fd,{bigint:true}) as any),src.proof.identity))refuse('identity-changed');}finally{closeSync(fd);}verify();}finally{closeSync(src.fd);}},
   unlink(proofs){chain.private();const entry=original(proofs);try{const name=Buffer.from(entry.name+'\0');if(libc!.symbols.unlinkat(entry.parent,ptr(name),entry.proof.kind==='directory'?0x80:0)!==0)refuse('recovery-required');if(entry.proof.kind==='directory'){const pin=directories.get(entry.proof.path);if(pin){closeSync(pin.fd);directories.delete(entry.proof.path);}}verify();}finally{closeSync(entry.fd);}},
   syncDirectory(parents){chain.private();const fd=directory(parents);fsyncSync(fd);verify();}
  };
  const result=await run(tree);verify();return result;
 }finally{live=false;for(const handle of [...handles])handle.close();for(const d of [...directories.values()].reverse())closeSync(d.fd);chain.close();}
}

export interface QaNamespaceIntent {
 id:string;path:string;rootIdentity:LocalIdentity;operation:string;phase:string;claim:string;
 kind:'directory'|'file';mode:0o700|0o600;maximum:number;role:'retained'|'temporary'|'staging';
}
export interface QaNamespaceGrant extends QaNamespaceIntent {parentIdentity:LocalIdentity}
export interface QaNamespaceEntry extends QaNamespaceGrant {identity:LocalIdentity;policy:'private'|'installed'}
export interface QaNamespaceFrame {
 format:'heed-qa-runtime-namespace';version:1;rootIdentity:LocalIdentity;operation:string;
 entries:QaNamespaceEntry[];grants:QaNamespaceGrant[];limitation:'same-uid-leaf-namespace-race-unprotected';
}
const intentKeys=['id','path','rootIdentity','operation','phase','claim','kind','mode','maximum','role'];
export function parseQaNamespaceIntent(value:unknown):QaNamespaceIntent {
 const v=exact(value,intentKeys);identityInput(v.rootIdentity);
 if(!UUID.test(v.id)||!UUID.test(v.operation)||typeof v.phase!=='string'||!/^[a-z0-9-]{1,80}$/.test(v.phase)||typeof v.claim!=='string'||!/^[A-Za-z0-9_-]{1,160}$/.test(v.claim)||typeof v.path!=='string'||v.path.length>4096||v.path.split('/').length>16||v.path.split('/').some((p:string)=>!p||p==='.'||p==='..'||p.includes('\0')||Buffer.byteLength(p)>255)||!['directory','file'].includes(v.kind)||v.mode!==(v.kind==='directory'?0o700:0o600)||!Number.isSafeInteger(v.maximum)||v.maximum<0||(v.kind==='directory'&&v.maximum!==0)||!['retained','temporary','staging'].includes(v.role))refuse();
 return structuredClone(v) as QaNamespaceIntent;
}
export function parseQaNamespaceGrant(value:unknown):QaNamespaceGrant {const v=exact(value,[...intentKeys,'parentIdentity']);identityInput(v.parentIdentity);const {parentIdentity,...intent}=v;return {...parseQaNamespaceIntent(intent),parentIdentity:structuredClone(parentIdentity)};}
export function parseQaNamespaceEntry(value:unknown):QaNamespaceEntry {const v=exact(value,[...intentKeys,'parentIdentity','identity','policy']);identityInput(v.identity);if(!['private','installed'].includes(v.policy))refuse();const {identity:own,policy,...grant}=v;return {...parseQaNamespaceGrant(grant),identity:structuredClone(own),policy};}
/** Runtime namespace frames are distinct from native receipts and their unchanged parser. */
export function parseQaNamespaceFrame(value:unknown):QaNamespaceFrame {
 const v=exact(value,['format','version','rootIdentity','operation','entries','grants','limitation']);identityInput(v.rootIdentity);
 if(Buffer.byteLength(JSON.stringify(v))>1_048_576||v.format!=='heed-qa-runtime-namespace'||v.version!==1||!UUID.test(v.operation)||v.limitation!=='same-uid-leaf-namespace-race-unprotected'||!Array.isArray(v.entries)||!Array.isArray(v.grants)||v.entries.length>512||v.grants.length>512)refuse('recovery-required');
 const entries=v.entries.map(parseQaNamespaceEntry),grants=v.grants.map(parseQaNamespaceGrant),names=new Set<string>();
 for(const group of [entries,grants]){const seen=new Set<string>();for(const entry of group){if(!same(entry.rootIdentity,v.rootIdentity)||(group===grants&&entry.operation!==v.operation)||seen.has(entry.path))refuse('recovery-required');seen.add(entry.path);names.add(entry.path);}}
 if(names.size>512)refuse('recovery-required');return {...v,entries,grants} as QaNamespaceFrame;
}
