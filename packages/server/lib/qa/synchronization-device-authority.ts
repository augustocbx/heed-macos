/** QA original-authority lifetime; native proof never performs artifact I/O. */
import {AcceptanceError,withResolvedLocalBinding,preflightOwnedWorkspace,parseAcceptanceSpec,type LocalBindingDescriptor,type AcceptanceWorkspace,type AcceptanceSpec} from './synchronization-device-binding';
import type {CloudBinding} from '../connectors/icloud-folder';
import {cloudBinding} from '../connectors/icloud-folder';
import {validateDirectBinding,type DirectSmbBinding} from '../smb-direct-types';
import {decodeFrame} from '../smb-direct-native';
import {track,untrack,killTree} from '../process';
import type {SecretVault} from '../connectors/keychain-vault';
import type {LibraryProvider,RemoteTransaction,PendingRemoteTransaction} from '../portable-provider';
export interface ValidatedChildBinding {role:'creator'|'participant';binding:CloudBinding|DirectSmbBinding;generation:string}
export interface AcceptanceAuthoritySession {ready:ValidatedChildBinding;signal:AbortSignal;check(signal?:AbortSignal):Promise<void>;close():Promise<void>}
export interface NativeOwnedAuthorityRequest {action:'qa-open-owned-authority';binding:CloudBinding|DirectSmbBinding;connectionGeneration?:string;endpoint?:unknown;credentials?:unknown;spec:AcceptanceSpec;workspace:AcceptanceWorkspace;selectedScope:'parent'|'child';role:'creator'|'participant'}
export interface AcceptanceAuthorityNative {openAcceptanceAuthority(request:NativeOwnedAuthorityRequest,signal?:AbortSignal):Promise<AcceptanceAuthoritySession>;pending?(binding:DirectSmbBinding,appDir:string,signal?:AbortSignal):Promise<PendingRemoteTransaction[]>}
export interface OwnedAuthorityRequest {descriptor:LocalBindingDescriptor;workspace:AcceptanceWorkspace;spec:AcceptanceSpec;role:'creator'|'participant'}
export interface OwnedAuthorityHandle {child:ValidatedChildBinding;signal:AbortSignal;check():Promise<void>}
export interface OwnedAuthorityDependencies {cloud?:AcceptanceAuthorityNative;smb?:AcceptanceAuthorityNative;vault?:Pick<SecretVault,'get'>}
const unavailable=()=>new AcceptanceError('ownership-unavailable');
function exact(value:unknown,keys:string[]){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!==keys.sort().join(','))throw unavailable();return value as Record<string,any>;}
function ready(value:unknown):ValidatedChildBinding {const v=exact(value,['role','binding','generation']);if(!['creator','participant'].includes(v.role)||typeof v.generation!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v.generation))throw unavailable();return {role:v.role,binding:Object.hasOwn(v.binding??{},'bookmark')?cloudBinding(v.binding):validateDirectBinding(v.binding),generation:v.generation};}
/** Bounded opt-in stdin control lifecycle shared by the two native QA adapters. */
export async function openNativeAuthoritySession(spawn:()=>any|Promise<any>,request:Record<string,unknown>,external?:AbortSignal):Promise<AcceptanceAuthoritySession>{
 let child:any,spawnAttempted=false,stopped=false,cleanClose=false,closed=false,closing=false,sequence=0,busy=false;const lost=new AbortController();
 let outputDone:Promise<void>|undefined;let invalidOutput=false;
 let pending:{resolve:(v:any)=>void;reject:(e:unknown)=>void}|undefined;let finishing:Promise<void>|undefined;let lifetime:ReturnType<typeof setTimeout>|undefined;let abort:()=>void;
 const failure=()=>{const e=unavailable();if(stopped)Object.defineProperty(e,'guardianStopped',{value:true,enumerable:false});return e;};
 const finish=(graceful=false)=>finishing??=(async()=>{closed=true;lost.abort(unavailable());pending?.reject(unavailable());pending=undefined;clearTimeout(lifetime);external?.removeEventListener('abort',abort);
  if(!child){if(!spawnAttempted)stopped=true;return;}try{child.stdin.end();}catch{}if(graceful){let grace:ReturnType<typeof setTimeout>|undefined;try{const completed=await Promise.race([Promise.all([child.exited,outputDone??Promise.resolve()]),new Promise<null>(resolve=>{grace=setTimeout(()=>resolve(null),1000);})]);if(completed!==null){stopped=true;untrack(child);if(completed[0]!==0||invalidOutput)throw failure();cleanClose=true;return;}}finally{clearTimeout(grace);}}killTree(child,'SIGTERM');const timer=setTimeout(()=>killTree(child,'SIGKILL'),1000);let limit:ReturnType<typeof setTimeout>|undefined;
  try{await Promise.race([child.exited,new Promise<never>((_,reject)=>{limit=setTimeout(()=>reject(unavailable()),5000);})]);stopped=true;untrack(child);if(graceful)throw failure();}finally{clearTimeout(timer);clearTimeout(limit);}
 })();
 const fail=()=>{lost.abort(unavailable());pending?.reject(unavailable());pending=undefined;void finish().catch(()=>{});};
 abort=fail;
 const awaitFrame=async(write:()=>void)=>{if(closed||busy||external?.aborted||lost.signal.aborted)throw failure();busy=true;let timer:ReturnType<typeof setTimeout>|undefined;
  try{const frame=new Promise<any>((resolve,reject)=>{pending={resolve,reject};timer=setTimeout(fail,30000);});write();return await frame;}catch{await finish();throw failure();}finally{busy=false;clearTimeout(timer);}
 };
 try{
  external?.throwIfAborted();spawnAttempted=true;try{child=track(await spawn());}catch(error){const witness=error instanceof Error?Object.getOwnPropertyDescriptor(error,'guardianStopped'):undefined;stopped=witness?.value===true&&witness.enumerable===false;throw unavailable();}external?.addEventListener('abort',abort,{once:true});lifetime=setTimeout(fail,120000);
  void child.exited.then(()=>{if(!closing&&!closed)fail();},fail);
  outputDone=(async()=>{try{let bytes=Buffer.alloc(0),first=true;for await(const chunk of child.stdout){bytes=Buffer.concat([bytes,Buffer.from(chunk)]);if(bytes.length>(first?150000:4096))throw unavailable();let index:number;while((index=bytes.indexOf(10))>=0){const frame=decodeFrame(bytes.subarray(0,index));bytes=bytes.subarray(index+1);if(!pending||closed)throw unavailable();const receiver=pending;pending=undefined;first=false;receiver.resolve(frame);}if(bytes.length>4096&&!first)throw unavailable();}if(bytes.length)throw unavailable();if(!closing&&!closed)fail();}catch{invalidOutput=true;fail();}})();
  void (async()=>{try{let size=0;for await(const chunk of child.stderr){size+=chunk.length;if(size>4096){fail();break;}}}catch{fail();}})();
  const initial=exact(await awaitFrame(()=>{const data=JSON.stringify(request)+'\n';if(Buffer.byteLength(data)>150000)throw unavailable();child.stdin.write(data);}),['ok','value']);if(initial.ok!==true)throw unavailable();const value=ready(initial.value);
  const send=async(action:'check'|'close',signal?:AbortSignal)=>{if(action==='check'&&sequence>=512||signal?.aborted){await finish();throw failure();}const localAbort=()=>fail();signal?.addEventListener('abort',localAbort,{once:true});try{const next=++sequence;const result=exact(await awaitFrame(()=>child.stdin.write(JSON.stringify({sequence:next,action})+'\n')),['sequence','ok']);if(result.sequence!==next||result.ok!==true)throw unavailable();}catch{await finish();throw failure();}finally{signal?.removeEventListener('abort',localAbort);}};
  return {ready:value,signal:lost.signal,check:signal=>send('check',signal),close:async()=>{if(closed){await finish();if(!cleanClose)throw failure();return;}closing=true;try{await send('close');}finally{await finish(true);if(!cleanClose)throw failure();}}};
 }catch{await finish();throw failure();}
}
export async function withValidatedOwnedChild<T>(input:OwnedAuthorityRequest,run:(handle:OwnedAuthorityHandle)=>Promise<T>,dependencies:OwnedAuthorityDependencies={},signal?:AbortSignal):Promise<T>{
 let session:AcceptanceAuthoritySession|undefined;let active=false,closedProof=false;
 try{
  exact(input,['descriptor','workspace','spec','role']);const spec=parseAcceptanceSpec(input.spec);if(!['creator','participant'].includes(input.role)||spec.provider!==input.descriptor.provider)throw unavailable();preflightOwnedWorkspace(input.workspace,spec.runId);
  const {createKeychainVault}=await import('../connectors/keychain-vault');
  return await withResolvedLocalBinding(input.descriptor,async(local,verify)=>{
   if(!local.preparation.disabled||!local.preparation.drained)throw unavailable();verify();preflightOwnedWorkspace(input.workspace,spec.runId);
   let native:AcceptanceAuthorityNative;
   if(local.provider==='icloud')native=dependencies.cloud??new (await import('../connectors/icloud-folder')).MacCloudNative();else native=dependencies.smb??new (await import('../smb-direct-native')).PythonDirectSmbNative();
   const request:NativeOwnedAuthorityRequest={action:'qa-open-owned-authority',binding:local.binding,spec,workspace:input.workspace,role:input.role,selectedScope:input.role==='creator'?'parent':'child',...(local.provider==='icloud'?{connectionGeneration:local.generation}:{endpoint:local.binding.endpoint,credentials:local.credentials})};
   const drain=async()=>{if(local.provider==='smb-direct'){if(!native.pending)throw unavailable();if((await native.pending(local.binding,input.descriptor.appPath,signal)).length)throw unavailable();verify();}};await drain();
   session=await native.openAcceptanceAuthority(request,signal);const value=ready(session.ready);if(value.role!==input.role||(local.provider==='icloud'? !Object.hasOwn(value.binding,'bookmark'):(value.binding as DirectSmbBinding).destinationId!==spec.destinationId||(value.binding as DirectSmbBinding).connectionGeneration!==value.generation))throw unavailable();
   active=true;const effective=AbortSignal.any([session.signal,...(signal?[signal]:[])]);const check=async()=>{if(!active)throw unavailable();effective.throwIfAborted();verify();await drain();preflightOwnedWorkspace(input.workspace,spec.runId);await session!.check(effective);verify();};
   await check();try{const result=await run({child:value,signal:effective,check});await check();return result;}finally{active=false;await session!.close();closedProof=true;}
  },dependencies.vault??(input.descriptor.provider==='smb-direct'?createKeychainVault():undefined));
 }catch(error){const safe=unavailable();if(closedProof||error instanceof Error&&Object.getOwnPropertyDescriptor(error,'guardianStopped')?.value===true)Object.defineProperty(safe,'guardianStopped',{value:true,enumerable:false});throw safe;}
 finally{active=false;await session?.close();}
}
/** Delegate unchanged production operations and every borrowed control through live proof. */
export function guardedAuthorityProvider(provider:LibraryProvider,handle:OwnedAuthorityHandle):LibraryProvider {
 const signal=(s?:AbortSignal)=>AbortSignal.any([handle.signal,...(s?[s]:[])]);
 const invoke=async<T>(run:()=>Promise<T>)=>{try{await handle.check();const result=await run();await handle.check();return result;}catch{throw unavailable();}};
 const controls=(tx:RemoteTransaction):RemoteTransaction=>{
  const wrap=(name:keyof RemoteTransaction)=>async(...args:any[])=>invoke(()=>{handle.signal.throwIfAborted();const fn=tx[name] as Function;const last=args.length-1;if(last>=0&&(args[last]===undefined||args[last] instanceof AbortSignal))args[last]=signal(args[last]);else if(name!=='checkpoint'&&name!=='observationDigest')args.push(signal());return fn.apply(tx,args) as Promise<any>;});
  return {checkpoint:wrap('checkpoint'),inventory:wrap('inventory'),writeDeletion:wrap('writeDeletion'),writeFence:wrap('writeFence'),writePending:wrap('writePending'),retirePending:wrap('retirePending'),removeExact:wrap('removeExact'),...(tx.observationDigest?{observationDigest:wrap('observationDigest')}:{})};
 };
 return {id:provider.id,name:provider.name,readOnly:provider.readOnly,transport:provider.transport,capabilities:provider.capabilities,deletionCapabilities:provider.deletionCapabilities,
  ...(provider.pendingTransactions?{pendingTransactions:()=>{handle.signal.throwIfAborted();return provider.pendingTransactions!();}}:{}),
  ...(provider.withTransaction?{withTransaction:(context,run,s)=>invoke(()=>provider.withTransaction!(context,tx=>run(controls(tx)),signal(s)))}:{}),
  ...(provider.acknowledgeDiscovery?{acknowledgeDiscovery:s=>invoke(()=>provider.acknowledgeDiscovery!(signal(s)))}:{}),
  list:(cursor,limit,s)=>invoke(()=>provider.list(cursor,limit,signal(s))),read:(path,max,s)=>invoke(()=>provider.read(path,max,signal(s))),
  stream:async function*(path,max,s){try{await handle.check();for await(const chunk of provider.stream(path,max,signal(s))){await handle.check();yield chunk;}await handle.check();}catch{throw unavailable();}},
  writeObjectImmutable:(path,bytes,hash,source,s)=>invoke(()=>provider.writeObjectImmutable(path,bytes,hash,source,signal(s))),writeImmutable:(path,bytes,s)=>invoke(()=>provider.writeImmutable(path,bytes,signal(s))),confirm:(commit,s)=>invoke(()=>provider.confirm(commit,signal(s)))};
}
