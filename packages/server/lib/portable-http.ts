import type {PortableLibrary} from './portable-library';import {UUID} from './portable-schema';import {desktopRequestAllowed} from './desktop-permissions';
const localId=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
export async function libraryResponse(req:Request,library:PortableLibrary,migrate?:()=>Promise<unknown>,busy=()=>false):Promise<Response>{
 if(req.method==='GET')return Response.json(library.snapshot());if(req.method!=='POST')return new Response(null,{status:405});
 if(!desktopRequestAllowed(req,new URL(req.url).port))return Response.json({error:'Library controls are only available from this Mac.'},{status:403});
 try{if(Number(req.headers.get('content-length'))>65536)throw new Error('Invalid library request');const text=await req.text();if(text.length>65536)throw new Error('Invalid library request');const body=JSON.parse(text);if(!body||typeof body!=='object'||Array.isArray(body)||typeof body.action!=='string')throw new Error('Invalid library request');
  const allowed:Record<string,string[]>={refresh:['action'],import:['action','revisionIds'],queue:['action','sessionId'],publish:['action','revisionId','expectedProviderId'],resolve:['action','revisionId'],audio:['action','sessionId'],migrate:['action']};const fields=allowed[body.action];if(!fields||Object.keys(body).some(key=>!fields.includes(key)))throw new Error('Invalid library action');
  if(body.action==='publish'){if(!localId(body.expectedProviderId))throw new Error('Invalid provider identity');if(body.expectedProviderId!==library.snapshot().providerId)return Response.json({error:'The selected provider changed. Refresh before publishing.',code:'provider-changed'},{status:409});}
  if(busy())return Response.json({error:'Wait for the active meeting to finish before library operations.'},{status:409});
  switch(body.action){
   case 'refresh':return Response.json(await library.discover(req.signal));
   case 'import':if(body.revisionIds!==undefined&&(!Array.isArray(body.revisionIds)||body.revisionIds.length>10000||body.revisionIds.some((id:unknown)=>typeof id!=='string'||!UUID.test(id))))throw new Error('Invalid library selection');return Response.json(await library.importSelected(body.revisionIds,req.signal));
   case 'queue':if(!localId(body.sessionId))throw new Error('Invalid meeting ID');return Response.json(await library.queueLocal(body.sessionId,req.signal));
   case 'publish':if(!UUID.test(body.revisionId))throw new Error('Invalid revision ID');return Response.json(await library.publish(body.revisionId,req.signal));
   case 'resolve':if(!UUID.test(body.revisionId))throw new Error('Invalid revision ID');return Response.json(await library.resolveConflict(body.revisionId,req.signal));
   case 'audio':if(!localId(body.sessionId))throw new Error('Invalid meeting ID');await library.requestAudio(body.sessionId,req.signal);return Response.json({available:true});
   case 'migrate':if(!migrate)throw new Error('Migration is unavailable');return Response.json(await migrate());
  }
 }catch(error){const message=error instanceof Error?error.message:'Library unavailable';const quota=/quota|reservation/i.test(message);const invalid=/^Invalid|Unsupported/.test(message);return Response.json({error:message,code:quota?'quota-blocked':invalid?'invalid-request':'unavailable'},{status:quota?409:invalid?400:503});}
 return new Response(null,{status:400});
}
