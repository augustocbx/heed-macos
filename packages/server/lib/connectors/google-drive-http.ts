import type {GoogleDriveSnapshot,GoogleAccessMode} from '@heed/shared';
import type {GoogleAuth} from './google-auth';
import {GoogleDriveLibraryManager} from './google-drive-library';
import {GoogleDriveProvider} from './google-drive-provider';
import type {LibraryProvider} from '../portable-provider';
import {desktopRequestAllowed} from '../desktop-permissions';
interface Registry {assertIdle():void;register(id:string,factory:()=>LibraryProvider):void;activate(id:string):void;deactivate(id:string):void;unregister(id:string):void;currentId():string|null|undefined;preferredId():string|null|undefined}
interface Options {auth:Pick<GoogleAuth,'snapshot'|'start'|'wait'|'cancel'|'disconnect'>;manager:GoogleDriveLibraryManager;registry:Registry;audioBusy:()=>boolean}
/** Public HTTP state contains only connection metadata; tokens and upload URLs stay in the vault. */
export class GoogleDriveController {
 private active:AbortController|null=null;
 private factories=new Map<string,()=>GoogleDriveProvider>();private providers=new Set<GoogleDriveProvider>();
 constructor(private options:Options){if(options.auth.snapshot().connected&&options.auth.snapshot().folder)this.register();}
 snapshot():GoogleDriveSnapshot{return {...this.options.auth.snapshot(),pendingCreation:this.options.manager.pendingCreation(),busy:!!this.active||this.options.manager.isBusy()};}
 private idle(){if(this.active||this.options.manager.isBusy()||this.options.audioBusy())throw new Error('A recording or library operation is already running');this.options.registry.assertIdle();}
 private register(){const id=this.options.manager.providerId();let factory=this.factories.get(id);if(!factory){factory=()=>{if(this.options.manager.providerId()!==id)throw new Error('Google destination changed');const provider=new GoogleDriveProvider({id,name:this.options.auth.snapshot().folder!.name,store:this.options.manager.store(),readOnly:!this.options.auth.snapshot().folder!.canUpload});this.providers.add(provider);return provider;};this.factories.set(id,factory);}this.options.registry.register(id,factory);return id;}
 private current(){return this.options.auth.snapshot().folder?this.options.manager.providerId():undefined;}
 private async operation<T>(signal:AbortSignal|undefined,run:(signal:AbortSignal)=>Promise<T>):Promise<T>{this.idle();const controller=new AbortController();this.active=controller;try{return await run(signal?AbortSignal.any([signal,controller.signal]):controller.signal);}finally{if(this.active===controller)this.active=null;}}
 async preempt(){this.active?.abort();await Promise.all([...this.providers].map(provider=>provider.preempt()));}
 async command(body:Record<string,unknown>,signal?:AbortSignal):Promise<unknown>{
  const action=body.action;const snapshot=this.options.auth.snapshot();if(body.expectedGeneration!==snapshot.generation||body.expectedConnectionId!==(snapshot.connectionId??null)||body.expectedFolderId!==(snapshot.folder?.id??null))throw new Error('Google connection changed; refresh before continuing');
  if(action==='cancel'){await this.options.auth.cancel();return this.snapshot();}
  if(action==='connect'){this.idle();const previous=this.current();this.options.auth.start({clientId:body.clientId as string,accessMode:body.accessMode as GoogleAccessMode,broaderAccessConfirmed:body.broaderAccessConfirmed as boolean});void this.options.auth.wait().then(()=>{if(!this.options.auth.snapshot().folder&&previous)this.options.registry.deactivate(previous);}).catch(()=>{});return this.snapshot();}
  return this.operation(signal,async combined=>{
   if(action==='folders')return this.options.manager.folders(combined);
   if(action==='capacity')return this.options.manager.capacity(combined);
   if(action==='disconnect'){const previous=this.current();await this.options.auth.disconnect(body.revoke as boolean);if(previous)this.options.registry.unregister(previous);return this.snapshot();}
   if(action==='forget-creation'){this.options.manager.forgetCreation();return this.snapshot();}
   if(action==='select'||action==='create'){const previous=this.current();if(action==='select')await this.options.manager.select(body.folderId as string,combined);else await this.options.manager.create({parentId:body.parentId as string,name:body.name as string,confirmed:body.confirmed as boolean},combined);if(previous)this.options.registry.deactivate(previous);this.options.registry.activate(this.register());return this.snapshot();}
   if(action==='enable'){this.options.registry.activate(this.register());return this.snapshot();}
   throw new Error('Invalid Google command');
  });
 }
}
const fields:Record<string,string[]>={connect:['action','clientId','accessMode','broaderAccessConfirmed'],cancel:['action'],disconnect:['action','revoke'],folders:['action'],select:['action','folderId'],create:['action','parentId','name','confirmed'],capacity:['action'],enable:['action'],'forget-creation':['action']};
function valid(body:unknown):body is Record<string,unknown>{if(!body||typeof body!=='object'||Array.isArray(body))return false;const value=body as Record<string,unknown>,allowed=fields[String(value.action)]?.concat(['expectedGeneration','expectedConnectionId','expectedFolderId']);if(!allowed||Object.keys(value).some(key=>!allowed.includes(key))||!Number.isSafeInteger(value.expectedGeneration)||(value.expectedGeneration as number)<0||(value.expectedConnectionId!==null&&(typeof value.expectedConnectionId!=='string'||!/^[a-f0-9-]{36}$/.test(value.expectedConnectionId)))||(value.expectedFolderId!==null&&(typeof value.expectedFolderId!=='string'||!/^[-A-Za-z0-9_]{1,256}$/.test(value.expectedFolderId))))return false;
 if(value.action==='connect')return typeof value.clientId==='string'&&value.clientId.length<=256&&['app-files','existing-readonly','existing-readwrite'].includes(String(value.accessMode))&&typeof value.broaderAccessConfirmed==='boolean';
 if(value.action==='disconnect')return typeof value.revoke==='boolean';if(value.action==='select')return typeof value.folderId==='string'&&/^[-A-Za-z0-9_]{1,256}$/.test(value.folderId);
 if(value.action==='create')return typeof value.parentId==='string'&&/^[-A-Za-z0-9_]{1,256}$/.test(value.parentId)&&typeof value.name==='string'&&value.name.length<=80&&typeof value.confirmed==='boolean';return true;}
export async function googleDriveResponse(request:Request,controller:GoogleDriveController,port:number|string):Promise<Response>{
 if(!desktopRequestAllowed(request,port))return new Response(null,{status:403});const headers={'Cache-Control':'no-store'};
 if(request.method==='GET')return Response.json(controller.snapshot(),{headers});if(request.method!=='POST')return new Response(null,{status:405});
 let body:unknown;try{const reader=request.body?.getReader();if(!reader)throw new Error();const chunks:Uint8Array[]=[];let length=0;try{while(true){const chunk=await reader.read();if(chunk.done)break;length+=chunk.value.length;if(length>6144)throw new Error();chunks.push(chunk.value);}}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{return Response.json({error:'Invalid Google Drive command'},{status:400,headers});}
 if(!valid(body))return Response.json({error:'Invalid Google Drive command'},{status:400,headers});
 try{return Response.json(await controller.command(body,request.signal),{headers});}catch(error){const stale=/connection changed/i.test((error as Error).message);const busy=/already running|busy/i.test((error as Error).message);return Response.json({code:stale?'connection-changed':busy?'busy':'unavailable',error:stale?'Google connection changed. Refresh before continuing.':busy?'Wait for the current recording or library operation.':'Google Drive operation failed. Check the connection, permissions, and pending work.'},{status:busy||stale?409:503,headers});}
}
