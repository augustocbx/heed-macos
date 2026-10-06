import {desktopRequestAllowed} from './desktop-permissions';import type {SmbConnections} from './smb-connections';
const string=(value:unknown,max:number):value is string=>typeof value==='string'&&value.length>0&&value.length<=max;
const ids=(value:unknown):value is string=>string(value,100);
export async function smbResponse(request:Request,connections:SmbConnections):Promise<Response>{
 if(!desktopRequestAllowed(request,new URL(request.url).port))return Response.json({error:'Synchronization controls are only available from this Mac.'},{status:403});
 if(request.method==='GET')return Response.json(connections.snapshot());if(request.method!=='POST')return new Response(null,{status:405});
 try{
  if(Number(request.headers.get('content-length'))>16384)throw new Error('Invalid SMB request.');const text=await request.text();if(text.length>16384)throw new Error('Invalid SMB request.');const body=JSON.parse(text);if(!body||typeof body!=='object'||Array.isArray(body))throw new Error('Invalid SMB request.');
  const fields:Record<string,string[]>={test:['action','folder'],connect:['action','name','receipt','create','connectionId'],rename:['action','id','name'],enable:['action','id','enabled'],disconnect:['action','id'],sync:['action','connectionId'],folder:['action'],mount:['action','address'],'desktop-report':['action','id','folder','failed']};
  if(typeof body.action!=='string'||!fields[body.action]||Object.keys(body).some(key=>!fields[body.action]!.includes(key)))throw new Error('Invalid SMB request.');
  switch(body.action){
   case 'test':if(!string(body.folder,4096))throw new Error('Invalid mounted SMB folder.');return Response.json(await connections.test(body.folder));
   case 'connect':if(!string(body.name,80)||!ids(body.receipt)||typeof body.create!=='boolean'||body.connectionId!==undefined&&!ids(body.connectionId))throw new Error('Invalid SMB request.');return Response.json(await connections.connect(body));
   case 'rename':if(!ids(body.id)||!string(body.name,80))throw new Error('Invalid SMB request.');return Response.json(connections.rename(body.id,body.name));
   case 'enable':if(!ids(body.id)||typeof body.enabled!=='boolean')throw new Error('Invalid SMB request.');return Response.json(connections.enable(body.id,body.enabled));
   case 'disconnect':if(!ids(body.id))throw new Error('Invalid SMB request.');return Response.json(connections.disconnect(body.id));
   case 'sync':if(!ids(body.connectionId))throw new Error('Invalid SMB request.');return Response.json(await connections.sync(body.connectionId));
   case 'folder':return Response.json(connections.desktopRequest('folder'));
   case 'mount':if(!string(body.address,2048))throw new Error('Invalid SMB address.');return Response.json(connections.desktopRequest('mount',body.address));
   case 'desktop-report':if(!ids(body.id)||!(body.folder===null||string(body.folder,4096))||typeof body.failed!=='boolean')throw new Error('Invalid SMB request.');return Response.json(connections.desktopReport(body.id,body.folder,body.failed));
  }
 }catch(error){
  const message=error instanceof Error?error.message:'';
  const invalid=/^Invalid|^Enter a credential-free/.test(message);const conflict=/expired|already pending|Confirm creation|Wait for|already running|limit reached|not found|identity changed|destination changed|changed after/.test(message);
  const safe=/^Invalid|^A library operation|^Enter a credential-free|^The access test|^Confirm creation|^Wait for|^Synchronization destination|^Destination identity|^The SMB destination|^The macOS request|^A macOS connection|^SMB destination|^SMB signing|^A read-only|^Unsupported or corrupt/.test(message);
  return Response.json({error:safe?message:'SMB operation unavailable. Check the selected mount, access and library integrity.'},{status:invalid?400:conflict?409:503});
 }
 return new Response(null,{status:400});
}
