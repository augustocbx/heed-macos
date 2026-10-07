import {desktopRequestAllowed} from '../desktop-permissions';
import {AiConnectionError, type AiConnections} from './connections';
import type {AiConnectionInput} from '../../../shared/types/ai';
const headers={'Cache-Control':'no-store'};
function error(code:string,status:number):Response{return Response.json({code,error:code==='settings-recovery'?'AI settings require recovery. Preserve private configuration.':code==='credential-unavailable'?'Protected credentials are unavailable. Unlock Keychain or register the key again.':code==='stale-connection'?'AI settings changed. Refresh before continuing.':'AI configuration request could not be completed.'},{status,headers});}
async function body(request:Request):Promise<Record<string,any>>{
 const reader=request.body?.getReader();if(!reader)throw Error();const chunks:Uint8Array[]=[];let bytes=0;
 try{while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>65536)throw Error();chunks.push(part.value);}const parsed=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw Error();return parsed;}
 finally{void reader.cancel().catch(()=>{});reader.releaseLock();}
}
/** Write-only keys, safe snapshots, and the established desktop Origin policy. */
export async function aiResponse(request:Request,runtime:AiConnections|undefined,allowed:boolean):Promise<Response|null>{
 const url=new URL(request.url);if(!['/api/ai/settings','/api/ai/connections'].includes(url.pathname))return null;
 if(!allowed||!desktopRequestAllowed(request,url.port))return new Response(null,{status:403,headers});
 if(!runtime||runtime.snapshot().unavailable)return error('settings-recovery',503);
 if(url.pathname==='/api/ai/settings'&&request.method==='GET')return Response.json(runtime.snapshot(),{headers});
 if(request.method!=='POST')return new Response(null,{status:405,headers});
 let command:Record<string,any>;try{command=await body(request);}catch{return error('invalid-request',400);}
 try{
  if(url.pathname==='/api/ai/settings'){
   if(Object.keys(command).sort().join(',')!=='feature,selection')return error('invalid-request',400);
   return Response.json(runtime.saveSelection(command.feature,command.selection),{headers});
  }
  const {action,id,...input}=command;
  if(action==='register'||action==='replace'){
   if(action==='register'&&id!==undefined||action==='replace'&&typeof id!=='string')return error('invalid-request',400);
   return Response.json(action==='register'?await runtime.register(input as AiConnectionInput):await runtime.replace(id,input as AiConnectionInput),{headers});
  }
  if(Object.keys(command).sort().join(',')!=='action,id'||typeof id!=='string')return error('invalid-request',400);
  if(action==='validate')return Response.json(await runtime.validate(id),{headers});
  if(action==='remove'){await runtime.remove(id);return Response.json(runtime.snapshot(),{headers});}
  return error('invalid-request',400);
 }catch(failure){const code=failure instanceof AiConnectionError?failure.code:'settings-recovery';return error(code,['invalid-request','invalid-endpoint','unsupported-capability'].includes(code)?400:code==='not-found'?404:code==='stale-connection'?409:503);}
}
