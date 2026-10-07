/** Opt-in adapter; runtime phase/ledger authority is supplied by synchronous original callbacks. */
import {randomUUID} from 'node:crypto';
import {basename,dirname,join,relative,resolve,sep} from 'node:path';
import {reserveAtomicWrite} from '../atomic-json';
import type {LocalStoreIo,LocalOwnedFile,LocalWriteHandle} from '../local-store-io';
import type {ManagedCategory} from '../managed-quota';
import {AcceptanceError,parseQaNamespaceIntent,parseQaNamespaceGrant,parseQaNamespaceEntry,type PinnedQaTree,type QaTreeProof,type LocalIdentity,type QaNamespaceIntent,type QaNamespaceGrant,type QaNamespaceEntry} from './synchronization-device-binding';

export interface QaLocalNamespace {
 readonly operation:string;
 /** Original root/phase/claim intent admits accounting only; it cannot create a name. */
 intent(path:string):QaNamespaceIntent|undefined;
 entry(path:string):QaNamespaceEntry|undefined;
 /** Synchronously durable grant binding an already-issued original parent before creation. */
 grant(path:string,originalParentIdentity:LocalIdentity):QaNamespaceGrant;
 issued(grant:QaNamespaceGrant,identity:LocalIdentity):QaNamespaceEntry;
 promoted(source:QaNamespaceEntry,grant:QaNamespaceGrant,identity:LocalIdentity):QaNamespaceEntry;
 removed(entry:QaNamespaceEntry):void;
}
const identical=(a:LocalIdentity,b:LocalIdentity)=>a.device===b.device&&a.inode===b.inode&&a.birth===b.birth;
const sameIntent=(a:QaNamespaceIntent,b:QaNamespaceIntent)=>identical(a.rootIdentity,b.rootIdentity)&&(['id','path','operation','phase','claim','kind','mode','maximum','role'] as const).every(key=>a[key]===b[key]);
const sameGrant=(a:QaNamespaceGrant,b:QaNamespaceGrant)=>sameIntent(a,b)&&identical(a.parentIdentity,b.parentIdentity);
const sameEntry=(a:QaNamespaceEntry,b:QaNamespaceEntry)=>sameGrant(a,b)&&identical(a.identity,b.identity)&&a.policy===b.policy;
function refusal():never {throw new AcceptanceError('identity-changed');}
const bounded=(n:number)=>{if(!Number.isSafeInteger(n)||n<0)refusal();return n;};
/** No pathname I/O or fallback. Known/pre-existing/mismatched entries refuse.
 * same-uid-leaf-namespace-race-unprotected includes each new directory
 * mkdirat -> parent fsync -> first no-follow open/validation/durable issuance window.
 * mkdirat supplies no creator FD/inode: indistinguishable same-UID substitution
 * can become a recorded parent receiving descendants. Ancestor confinement holds
 * after genuine original-parent issuance; no created-inode attestation is claimed. */
export function createSynchronizationLocalIo(tree:PinnedQaTree,namespace:QaLocalNamespace):LocalStoreIo {
 const root=tree.path,operation=namespace.operation,census=new Set<string>();let poisoned=false;
 const check=()=>{if(poisoned)refusal();tree.verify();};
 const local=(path:string)=>{check();if(typeof path!=='string'||!path.startsWith('/')||path!==resolve(path))refusal();const result=relative(root,path);if(result==='..'||result.startsWith('..'+sep)||result.startsWith(sep)||result.split(sep).length>16)refusal();return result;};
 const admit=(value:QaNamespaceIntent)=>{if(value.operation!==operation||!identical(value.rootIdentity,tree.identity))refusal();return value;};
 const count=(path:string)=>{census.add(path);if(census.size>512)refusal();};
 const intent=(path:string)=>{const raw=namespace.intent(path);if(!raw)refusal();const value=admit(parseQaNamespaceIntent(raw));if(value.path!==path)refusal();return value;};
 const entry=(path:string)=>{const raw=namespace.entry(path);if(!raw)return undefined;const value=parseQaNamespaceEntry(raw);if(!identical(value.rootIdentity,tree.identity)||value.path!==path)refusal();count(path);return value;};
 const proofs=(path:string):QaTreeProof[]=>{if(!path)return [];const parts=path.split('/');let expectedParent=tree.identity;return parts.map((_,i)=>{const own=entry(parts.slice(0,i+1).join('/'));if(!own||!identical(own.parentIdentity,expectedParent))refusal();expectedParent=own.identity;return {path:own.path,identity:own.identity,kind:own.kind,policy:own.policy};});};
 const parent=(path:string)=>{const parts=path.split('/');parts.pop();return parts.join('/');};
 const parentIdentity=(path:string)=>{const value=parent(path);if(!value)return tree.identity;const own=entry(value);if(!own||own.kind!=='directory')refusal();tree.stat(proofs(value));return own.identity;};
 const grant=(path:string)=>{const originalParent=parentIdentity(path),value=admit(parseQaNamespaceGrant(namespace.grant(path,originalParent))) as QaNamespaceGrant;if(value.path!==path||!identical(value.parentIdentity,originalParent)||!sameIntent(value,intent(path)))refusal();return value;};
 const record=(run:()=>QaNamespaceEntry,expected:QaNamespaceGrant,identity:LocalIdentity)=>{
  try{const value=parseQaNamespaceEntry(run());const {identity:own,policy,...savedGrant}=value;if(!identical(own,identity)||policy!=='private'||!sameGrant(savedGrant,expected))refusal();const reread=entry(value.path);if(!reread||!sameEntry(reread,value))refusal();return value;}catch(error){poisoned=true;throw error;}
 };
 const existing=(path:string)=>{const name=local(path),own=entry(name);if(!own)refusal();tree.stat(proofs(name));return own;};
 const mutable=(own:QaNamespaceEntry)=>{if(own.operation!==operation||own.policy!=='private'||!['temporary','staging'].includes(own.role))refusal();};
 const writeFile=(path:string,maximum:number):LocalWriteHandle=>{
  const name=local(path);bounded(maximum);if(entry(name))refusal();const issued=grant(name);if(issued.kind!=='file'||maximum>issued.maximum)refusal();tree.absent(proofs(parent(name)),basename(name));
  let handle:LocalWriteHandle;try{handle=tree.createFile(proofs(parent(name)),basename(name),maximum);}catch(error){poisoned=true;throw error;}
  try{record(()=>namespace.issued(issued,handle.identity),issued,handle.identity);return handle;}catch(error){handle.close();throw error;}
 };
 const io:LocalStoreIo={
  exists(path){const name=local(path);if(!name){tree.stat([]);return true;}const own=entry(name);if(own){tree.stat(proofs(name));return true;}intent(name);const parts=name.split('/');for(let i=1;i<parts.length;i++){const prefix=parts.slice(0,i).join('/');if(!entry(prefix)){intent(prefix);tree.absent(proofs(parent(prefix)),basename(prefix));return false;}}tree.absent(proofs(parent(name)),basename(name));return false;},
  stat(path){const name=local(path);return tree.stat(proofs(name));},
  readFile(path,maximum){const name=local(path),own=existing(path),cap=Math.min(bounded(maximum),own.maximum);const info=tree.stat(proofs(name));if(!info.isFile()||info.size>cap)refusal();const handle=tree.openRead(proofs(name),cap+1);try{const bytes=handle.readAt(0,info.size+1);if(bytes.length!==info.size)refusal();handle.verify();return bytes;}finally{handle.close();}},
  list(path,maximumEntries){const name=local(path);const bound=Math.min(bounded(maximumEntries),512-census.size);const names=tree.list(proofs(name),bound);for(const child of names){const path=name?name+'/'+child:child;if(!entry(path))refusal();tree.stat(proofs(path));}return names;},
  mkdir(path){const name=local(path);if(!name){tree.stat([]);return;}const parts=name.split('/');for(let i=1;i<=parts.length;i++){const path=parts.slice(0,i).join('/'),own=entry(path);if(own){if(own.kind!=='directory')refusal();tree.stat(proofs(path));continue;}const issued=grant(path);if(issued.kind!=='directory')refusal();count(path);let identity:LocalIdentity;try{identity=tree.createDirectory(proofs(parent(path)),basename(path));}catch(error){poisoned=true;throw error;}record(()=>namespace.issued(issued,identity),issued,identity);}},
  canonical(path){const name=local(path);tree.stat(proofs(name));return path;},
  writeAtomic(path,data){
   if(typeof data!=='string')refusal();const name=local(path),target=entry(name),issued=grant(name),bytes=Buffer.from(data,'utf8');if(issued.kind!=='file'||bytes.length>issued.maximum)refusal();if(target)tree.stat(proofs(name));else tree.absent(proofs(parent(name)),basename(name));
   const temporary=path+'.'+randomUUID()+'.tmp';const release=reserveAtomicWrite(path,bytes.length,temporary);let handle:LocalWriteHandle|undefined;
   try{handle=writeFile(temporary,bytes.length);handle.append(bytes);handle.sync();handle.close();handle=undefined;io.promote(temporary,path);io.syncDirectory(dirname(path));if(!io.readFile(path,bytes.length).equals(bytes))refusal();}
   finally{handle?.close();if(!poisoned){try{const temporaryName=local(temporary);if(entry(temporaryName))io.unlink(temporary);}catch(error){poisoned=true;throw error;}if(!poisoned){try{release();}catch(error){poisoned=true;throw error;}}}}
  },
  openRead(path,maximum){const name=local(path),own=existing(path);if(own.kind!=='file')refusal();return tree.openRead(proofs(name),Math.min(bounded(maximum),own.maximum));},
  createFile:writeFile,
  async *stream(path,maximum,signal){const name=local(path),own=existing(path),cap=Math.min(bounded(maximum),own.maximum),handle=tree.openRead(proofs(name),cap+1);let received=0;try{while(received<cap){signal?.throwIfAborted();handle.verify();const chunk=handle.readAt(received,Math.min(65_536,cap-received));signal?.throwIfAborted();handle.verify();if(!chunk.length)break;received+=chunk.length;yield chunk;signal?.throwIfAborted();handle.verify();}signal?.throwIfAborted();if(handle.readAt(received,1).length)refusal();handle.verify();}finally{handle.close();}},
  promote(source,destination){const src=existing(source);mutable(src);if(src.kind!=='file')refusal();const targetName=local(destination),target=entry(targetName),issued=grant(targetName);if(issued.kind!=='file'||io.stat(source).size>issued.maximum)refusal();try{tree.promote(proofs(src.path),proofs(parent(targetName)),basename(targetName),target?proofs(targetName).at(-1):undefined);}catch(error){poisoned=true;throw error;}record(()=>namespace.promoted(src,issued,src.identity),issued,src.identity);},
  unlink(path){const own=existing(path);mutable(own);try{tree.unlink(proofs(own.path));}catch(error){poisoned=true;throw error;}try{namespace.removed(own);if(namespace.entry(own.path))refusal();}catch(error){poisoned=true;throw error;}},
  removeStaging(path){const name=local(path),own=entry(name);if(!own){intent(name);tree.absent(proofs(parent(name)),basename(name));return;}mutable(own);if(own.role!=='staging'||own.kind!=='directory')refusal();const removals:string[]=[];const visit=(path:string)=>{for(const child of io.list(join(root,path),512)){const next=path+'/'+child,item=entry(next);if(!item)refusal();mutable(item);if(item.kind==='directory')visit(next);removals.push(join(root,next));}};visit(name);for(const removal of removals)io.unlink(removal);io.unlink(path);io.syncDirectory(dirname(path));},
  syncDirectory(path){tree.syncDirectory(proofs(local(path)));},
  owns(path){const name=local(path);if(!name)return true;if(entry(name)){tree.stat(proofs(name));return true;}intent(name);let current=parent(name);while(current){const own=entry(current);if(own){tree.stat(proofs(current));break;}intent(current);current=parent(current);}return true;},
  inventory(roots:Partial<Record<ManagedCategory,string[]>>,excludedLedger){
   check();const files:LocalOwnedFile[]=[],seen=new Set<string>();
   const visit=(path:string,category:ManagedCategory)=>{if(!io.exists(path))return;const stat=io.stat(path);if(stat.isDirectory()){for(const name of io.list(path,512).sort())visit(join(path,name),category);return;}if(!stat.isFile()||resolve(path)===resolve(excludedLedger))return;const identity=stat.dev+':'+stat.ino;if(seen.has(identity))return;seen.add(identity);files.push({path:resolve(path),bytes:stat.size,modified:stat.mtimeMs,category:category==='media'&&!/\.(wav|mp3|mp4|m4a|aac|flac|ogg|webm|mov)$/i.test(path)?'text':category,identity});};
   for(const [category,paths] of Object.entries(roots))for(const path of paths!){visit(path,category as ManagedCategory);if(path.endsWith('.json')&&io.exists(dirname(path)))for(const name of io.list(dirname(path),512))if(name.startsWith(basename(path)+'.')&&/^\.[0-9a-f-]{36}\.tmp$/.test(name.slice(basename(path).length)))visit(join(dirname(path),name),category as ManagedCategory);}
   return files;
  }
 };
 return io;
}
