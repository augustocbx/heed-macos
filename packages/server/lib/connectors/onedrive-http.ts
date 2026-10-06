import {desktopRequestAllowed} from '../desktop-permissions';
import {UUID} from '../portable-schema';
import {OneDriveError} from './onedrive-auth';
import type {OneDriveConnections,OneDriveExpected} from './onedrive-connections';
import {GRAPH_ID} from './onedrive-store';
const fields:Record<string,string[]>={connect:['clientId','tenant'],cancel:[],libraries:[],create:['name'],initialize:['folderId'],select:['folderId','uploadLocal'],configure:['uploadLocal','enabled'],sync:[],disconnect:[]};
function valid(body:unknown):body is Record<string,any>{
 if(!body||typeof body!=='object'||Array.isArray(body))return false;
 const value=body as Record<string,any>,allowed=fields[value.action];
 if(!allowed||Object.keys(value).some(key=>!['action','expected',...allowed].includes(key)))return false;
 const proof=value.expected;
 if(!proof||typeof proof!=='object'||Array.isArray(proof)||Object.keys(proof).sort().join(',')!=='authGeneration,connectionId,folderGeneration'||!(proof.connectionId===null||typeof proof.connectionId==='string'&&UUID.test(proof.connectionId))||![proof.folderGeneration,proof.authGeneration].every(n=>Number.isSafeInteger(n)&&n>=0))return false;
 if(value.action==='connect')return typeof value.clientId==='string'&&value.clientId.length<=100&&typeof value.tenant==='string'&&value.tenant.length<=100;
 if(['initialize','select'].includes(value.action)&&!(typeof value.folderId==='string'&&GRAPH_ID.test(value.folderId)))return false;
 if(value.action==='create'&&!(typeof value.name==='string'&&value.name.length<=100))return false;
 if(['select','configure'].includes(value.action)&&typeof value.uploadLocal!=='boolean')return false;
 if(value.action==='configure'&&typeof value.enabled!=='boolean')return false;
 return true;
}
/** No credential, continuation URL or raw provider error is exposed by this device-local API. */
export async function oneDriveResponse(request:Request,manager:OneDriveConnections):Promise<Response>{
 if(!desktopRequestAllowed(request,new URL(request.url).port))return new Response(null,{status:403});
 const headers={'Cache-Control':'no-store'};
 if(request.method==='GET')return Response.json(manager.snapshot(),{headers});
 if(request.method!=='POST')return new Response(null,{status:405});
 let body:unknown;
 try{const reader=request.body?.getReader();if(!reader)throw new Error();const chunks:Uint8Array[]=[];let bytes=0;try{while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.length;if(bytes>6144)throw new Error();chunks.push(part.value);}}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{return Response.json({code:'invalid-request',error:'Invalid OneDrive command.'},{status:400,headers});}
 if(!valid(body))return Response.json({code:'invalid-request',error:'Invalid OneDrive command.'},{status:400,headers});
 const expected=body.expected as OneDriveExpected;
 try{let result:unknown;switch(body.action){
 case 'connect':result=manager.start({clientId:body.clientId,tenant:body.tenant},expected);break;
 case 'cancel':result=await manager.cancel(expected);break;
 case 'libraries':result=await manager.libraries(expected,request.signal);break;
 case 'create':result=await manager.create({name:body.name,expected},request.signal);break;
 case 'initialize':result=await manager.initialize({folderId:body.folderId,expected},request.signal);break;
 case 'select':result=await manager.select({folderId:body.folderId,uploadLocal:body.uploadLocal,expected},request.signal);break;
 case 'configure':result=await manager.configure({enabled:body.enabled,uploadLocal:body.uploadLocal,expected});break;
 case 'sync':result=await manager.sync(expected);break;
 case 'disconnect':result=await manager.disconnect(expected);break;
 }return Response.json(result,{headers});
 }catch(error){const known=error instanceof OneDriveError?error.code:undefined,stale=known==='stale-state',busy=/already running|active meeting|busy/.test(error instanceof Error?error.message:''),quota=/quota|reservation/i.test(error instanceof Error?error.message:'');const code=known||(busy?'busy':quota?'quota-blocked':'unavailable');return Response.json({code,error:known==='remote-quota'?'OneDrive remote storage is full. Local transcripts and pending copies are preserved.':known==='unsupported-account'||known==='missing-scopes'?'This account does not support the required app-folder operations. No broader permission was requested.':known==='auth-required'?'Authorize the Microsoft account again before synchronization.':known==='rate-limited'?'Microsoft limited requests. Synchronization will retry after the requested delay.':stale?'OneDrive settings changed. Refresh before continuing.':busy?'Wait for the current recording or library operation.':quota?'Local storage is full. Pending work and retained transcripts are preserved.':'OneDrive operation failed. Check authorization, account support, and the selected library.'},{status:stale||busy||quota?409:503,headers});}
}
