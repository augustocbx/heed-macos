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
export type ResolvedLocalBinding={provider:'icloud';binding:CloudBinding;connectionId:string;generation:string}|{provider:'smb-direct';binding:DirectSmbBinding;credentials:DirectSmbCredentials;connectionId:string;generation:string};
function selected(value:Record<string,unknown>,d:LocalBindingDescriptor):Omit<Extract<ResolvedLocalBinding,{provider:'icloud'}>,'provider'>|DirectSmbBinding {
 if(d.provider==='icloud'){
  const v=exact(value,['version','connection']);if(v.version!==1)refuse('recovery-required');const c=exact(v.connection,['id','name','enabled','binding','destinationId','destinationVersion']);
  if(c.id!==d.connectionId||!UUID.test(c.id)||!UUID.test(c.destinationId)||c.destinationVersion!==2||typeof c.enabled!=='boolean'||typeof c.name!=='string'||c.name!==c.name.trim()||c.name.length<1||c.name.length>80||/[\x00-\x1f\x7f]/.test(c.name))refuse('binding-unavailable');
  const binding=cloudBinding(c.binding);const {name,enabled,...parts}=c;const generation=createHash('sha256').update(JSON.stringify(parts)).digest('hex');if(generation!==d.generation)refuse('identity-changed');return {binding,connectionId:c.id,generation};
 }
 if(Object.hasOwn(value,'transition'))refuse('recovery-required');const v=exact(value,['version','connections','cleanup']);if(v.version!==1||!Array.isArray(v.connections)||v.connections.length>8||!Array.isArray(v.cleanup)||v.cleanup.length)refuse('recovery-required');
 const ids=new Set(),refs=new Set();let found:DirectSmbBinding|undefined;
 for(const raw of v.connections){const c=exact(raw,['uncertainty','binding','dialect','enabled','jobs','acknowledged','retryAt','failures','lastSync','imported','skipped','error']);const b=validateDirectBinding(c.binding);
  if(ids.has(b.id)||refs.has(b.credentialRef)||c.uncertainty!==null||typeof c.enabled!=='boolean'||!['3.0','3.0.2','3.1.1'].includes(c.dialect)||!c.jobs||typeof c.jobs!=='object'||Array.isArray(c.jobs)||Object.keys(c.jobs).length>10000||!Array.isArray(c.acknowledged)||c.acknowledged.length>10000||c.acknowledged.some((id:unknown)=>typeof id!=='string'||!UUID.test(id)))refuse('recovery-required');
  for(const [id,rawJob] of Object.entries(c.jobs)){const j=exact(rawJob,['attempts','next']);if(!UUID.test(id)||!Number.isInteger(j.attempts)||j.attempts<0||j.attempts>30||typeof j.next!=='number'||!Number.isFinite(j.next)||j.next<0)refuse('recovery-required');}
  if(['retryAt','failures','imported','skipped'].some(k=>!Number.isSafeInteger(c[k])||c[k]<0)||c.failures>30||(c.lastSync!==null&&(!Number.isSafeInteger(c.lastSync)||c.lastSync<0))||(c.error!==null&&typeof c.error!=='string'))refuse('recovery-required');
  ids.add(b.id);refs.add(b.credentialRef);if(b.id===d.connectionId){if(b.readOnly||b.connectionGeneration!==d.generation)refuse('binding-unavailable');found=b;}
 }
 return found??refuse('binding-unavailable');
}
export async function withResolvedLocalBinding<T>(input:LocalBindingDescriptor,run:(binding:ResolvedLocalBinding)=>Promise<T>,vault?:Pick<SecretVault,'get'>):Promise<T>{
 let chain:LocalChain|undefined,fd:number|undefined;
 try{
  const raw=exact(input,['version','provider','appPath','appIdentity','configIdentity','connectionId','generation']);
  if(raw.version!==1||!['icloud','smb-direct'].includes(raw.provider)||typeof raw.appPath!=='string'||!UUID.test(raw.connectionId)||typeof raw.generation!=='string'||!(raw.provider==='icloud'?HASH:UUID).test(raw.generation))refuse();
  const d=raw as LocalBindingDescriptor;identityInput(d.appIdentity);identityInput(d.configIdentity);chain=new LocalChain(d.appPath);chain.installed();if(!same(chain.identities.at(-1)!,d.appIdentity))refuse('identity-changed');
  const name=d.provider==='icloud'?'icloud-folder.json':'direct-smb-connections.json';
  const transition=()=>{if(d.provider==='icloud'){const t=relativeOpen(chain!.last,name+'.transition.json',fileFlags);if(t>=0){closeSync(t);refuse('recovery-required');}if(lastErrno!==2)refuse('recovery-required');}};
  transition();fd=relativeOpen(chain.last,name,fileFlags);if(fd<0)refuse('binding-unavailable');if(!same(identity(fstatSync(fd,{bigint:true}) as any),d.configIdentity))refuse('identity-changed');
  const max=d.provider==='icloud'?150000:16_000_000;const bytes=privateFile(fd,max);const parsed=decodeFrame(bytes);const local=selected(parsed,d);
  const check=()=>{chain!.check();chain!.installed();transition();const current=relativeOpen(chain!.last,name,fileFlags);if(current<0)refuse('identity-changed');try{if(!same(identity(fstatSync(current,{bigint:true}) as any),d.configIdentity)||!privateFile(current,max).equals(bytes)||!privateFile(fd!,max).equals(bytes))refuse('identity-changed');}finally{closeSync(current);}};
  let binding:ResolvedLocalBinding;
  if(d.provider==='icloud')binding={provider:'icloud',...(local as Omit<Extract<ResolvedLocalBinding,{provider:'icloud'}>,'provider'>)};
  else{if(!vault)refuse('binding-unavailable');const b=local as DirectSmbBinding;check();const credentials=validateDirectCredentials(await vault!.get(b.credentialRef));binding={provider:'smb-direct',binding:b,credentials,connectionId:b.id,generation:b.connectionGeneration};}
  check();const result=await run(binding);check();return result;
 }catch(error){if(error instanceof AcceptanceError)throw error;const safe=new AcceptanceError('binding-unavailable');if(error instanceof Error&&Object.getOwnPropertyDescriptor(error,'guardianStopped')?.value===true)Object.defineProperty(safe,'guardianStopped',{value:true,enumerable:false});throw safe;}
 finally{if(fd!==undefined&&fd>=0)closeSync(fd);chain?.close();}
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
/** A descriptor-only ledger adapter; unknown checkpoints remain retained and block restart. */
class AcceptanceLedger implements QuotaLedgerStorage {
 private original:LocalIdentity|null=null;
 constructor(readonly chain:LocalChain,readonly runId:string,readonly paths:string[]){}
 load():unknown|null {knownQuotaEntries(this.chain);const fd=relativeOpen(this.chain.last,'ledger',fileFlags);if(fd<0){if(lastErrno!==2)refuse('recovery-required');return null;}try{const result=fixedLedger(decodeFrame(privateFile(fd,4096)),this.runId,this.paths);this.original=identity(fstatSync(fd,{bigint:true}) as any);return result;}finally{closeSync(fd);}}
 save(input:unknown){
  const value=fixedLedger(input,this.runId,this.paths);const bytes=Buffer.from(JSON.stringify(value));knownQuotaEntries(this.chain);
  const current=relativeOpen(this.chain.last,'ledger',fileFlags);if(current>=0){try{if(!this.original||!same(this.original,identity(fstatSync(current,{bigint:true}) as any)))refuse('identity-changed');privateFile(current,4096);}finally{closeSync(current);}}else if(lastErrno!==2||this.original)refuse('identity-changed');
  absent(this.chain.last,'checkpoint');const fd=relativeOpen(this.chain.last,'checkpoint',constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);if(fd<0)refuse('recovery-required');
  try{let offset=0;while(offset<bytes.length){const written=writeSync(fd,bytes,offset,bytes.length-offset);if(written<=0)refuse('recovery-required');offset+=written;}fsyncSync(fd);this.chain.check();const from=Buffer.from('checkpoint\0'),to=Buffer.from('ledger\0');if(libc!.symbols.renameat(this.chain.last,ptr(from),this.chain.last,ptr(to))!==0)refuse('recovery-required');fsyncSync(this.chain.last);this.original=identity(fstatSync(fd,{bigint:true}) as any);this.chain.check();}
  finally{closeSync(fd);} // A failed checkpoint is intentionally retained.
 }
}
export function openAcceptanceQuota(descriptor:AcceptanceWorkspace,runId:string,limitBytes:number){
 if(!UUID.test(runId)||!Number.isSafeInteger(limitBytes)||limitBytes<ACCEPTANCE_RECEIPT_BYTES+ACCEPTANCE_LEDGER_BYTES)refuse();
 const workspace=new LocalChain(descriptor.path);let receipts:LocalChain|undefined,quota:LocalChain|undefined;
 try{workspace.private();receipts=new LocalChain(join(descriptor.path,'acceptance'));receipts.private();quota=new LocalChain(join(descriptor.path,'quota'));quota.private();
  const verifyIdentities=()=>{for(const [chain,expected] of [[workspace,descriptor.identity],[receipts!,descriptor.receipts],[quota!,descriptor.quota]] as const){chain.check();chain.private();if(!same(chain.identities.at(-1)!,identityInput(expected)))refuse('identity-changed');}};verifyIdentities();
  const paths=RECEIPT_NAMES.map(name=>join(descriptor.path,'acceptance',name)).sort();const expected={version:1,reservations:{[`qa-ledger-${runId}`]:{bytes:ACCEPTANCE_LEDGER_BYTES,paths:[]},[`qa-bootstrap-${runId}`]:{bytes:ACCEPTANCE_RECEIPT_BYTES,paths}},atomicWrites:{}};fixedLedger(expected,runId,paths);
  const ledgerStorage=new AcceptanceLedger(quota,runId,paths);const managed=new ManagedQuota({ledgerPath:join(descriptor.path,'quota','ledger'),ledgerStorage,roots:{text:paths},getLimit:()=>limitBytes,setLimit:()=>refuse(),protectedPaths:()=>paths});
  verifyIdentities();managed.reserve(`qa-ledger-${runId}`,ACCEPTANCE_LEDGER_BYTES,[]);verifyIdentities();managed.reserve(`qa-bootstrap-${runId}`,ACCEPTANCE_RECEIPT_BYTES,paths);verifyIdentities();
  const verify=()=>{verifyIdentities();const ledger=fixedLedger(ledgerStorage.load(),runId,paths);if(Object.keys(ledger.reservations).length!==2)refuse('recovery-required');let size=0;for(const name of RECEIPT_NAMES){const fd=relativeOpen(receipts!.last,name,fileFlags);if(fd<0){if(lastErrno!==2)refuse('recovery-required');continue;}try{const max=name==='guard'?0:['receipt','checkpoint'].includes(name)?16384:150000;const info=fstatSync(fd);if(!info.isFile()||info.nlink!==1||info.uid!==process.getuid?.()||(info.mode&0o777)!==0o600||info.size>max)refuse('recovery-required');size+=info.size;}finally{closeSync(fd);}}if(size>ACCEPTANCE_RECEIPT_BYTES)refuse('recovery-required');verifyIdentities();};verify();
  let closed=false;return {verify,snapshot:()=>{verify();const result=managed.snapshot();verify();return result;},close:()=>{if(!closed){closed=true;quota!.close();receipts!.close();workspace.close();}}};
 }catch(error){quota?.close();receipts?.close();workspace.close();throw error;}
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
  let receipt:Record<string,unknown>;try{receipt=decodeFrame(privateFile(fd,16384));}finally{closeSync(fd);}
  const origin=receipt.origin as Record<string,unknown>|undefined;const spec=receipt.spec as Record<string,unknown>|undefined;
  if(receipt.version!==1||!origin||spec?.runId!==runId||!['creator','participant'].includes(String(receipt.role))||!['prepared','allocating','allocated','initialized','joined'].includes(String(receipt.phase)))refuse('recovery-required');
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
