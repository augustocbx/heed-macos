import {createHash,randomUUID} from 'node:crypto';import {mkdtempSync,readFileSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {GoogleDriveStore} from './google-drive-store';import type {SecretVault} from './keychain-vault';
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
interface File {id:string;name:string;mimeType:string;parents:string[];size?:string;sha256Checksum?:string;md5Checksum?:string;properties?:Record<string,string>;capabilities:{canDownload:boolean;canAddChildren?:boolean};bytes?:Uint8Array}
export function driveFixture(){
 const root=mkdtempSync(join(tmpdir(),'heed-google-store-')),destinationId=randomUUID(),folder={id:'library-folder',name:'Synthetic library',destinationId,canUpload:true};const files=new Map<string,File>(),secrets=new Map<string,unknown>(),sessions=new Map<string,{file:File;chunks:Uint8Array[];offset:number}>();const requests:URL[]=[];let generated=0,sessionNumber=0,failChunk=false,expired=false,quotaError=false,changed=true;
 const add=(path:string,bytes:Uint8Array,parent=folder.id,id=`file-${files.size}`)=>{const file:File={id,name:path.replaceAll('/','__'),mimeType:'application/octet-stream',parents:[parent],size:String(bytes.length),sha256Checksum:hash(bytes),properties:{heedPath:path,heedDestination:destinationId},capabilities:{canDownload:true},bytes};files.set(id,file);return file;};
 files.set(folder.id,{id:folder.id,name:folder.name,mimeType:'application/vnd.google-apps.folder',parents:[],capabilities:{canDownload:true,canAddChildren:true}});const header=Buffer.from(JSON.stringify({format:'heed-portable-library',schemaVersion:1,destinationId}));files.set('header',{id:'header',name:'heed-library.json',mimeType:'application/json',parents:[folder.id],size:String(header.length),sha256Checksum:hash(header),capabilities:{canDownload:true},bytes:header});
 const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request:Request):Promise<Response>{
  const u=new URL(request.url);requests.push(u);
  if(u.pathname==='/drive/v3/changes/startPageToken')return Response.json({startPageToken:'START'});
  if(u.pathname==='/drive/v3/changes'){if(u.searchParams.get('pageToken')==='EXPIRED')return Response.json({error:{code:410}},{status:410});const all=changed?[...files.values()].filter(f=>f.properties).map(file=>({fileId:file.id,file})):[];const offset=u.searchParams.get('pageToken')?.startsWith('PAGE_')?Number(u.searchParams.get('pageToken')!.slice(5)):0;return Response.json({changes:all.slice(offset,offset+2),...(offset+2<all.length?{nextPageToken:`PAGE_${offset+2}`}:{newStartPageToken:'NEXT'})});}
  if(u.pathname==='/drive/v3/files/generateIds')return Response.json({ids:Array.from({length:Number(u.searchParams.get('count')||1)},()=>`generated-${++generated}`)});
  if(u.pathname==='/drive/v3/about')return Response.json({storageQuota:{limit:'2000000000',usage:'1000'}});
  if(u.pathname==='/drive/v3/files'&&request.method==='POST'){const file=await request.json() as File;files.set(file.id,{...file,capabilities:{canAddChildren:true,canDownload:true}});return Response.json(files.get(file.id));}
  if(u.pathname==='/upload/drive/v3/files'&&u.searchParams.get('uploadType')==='multipart'){const body=await request.text();const boundary=request.headers.get('Content-Type')!.split('boundary=')[1]!;const parts=body.split(`--${boundary}`).filter(p=>p.includes('Content-Type'));const metadata=JSON.parse(parts[0]!.split('\r\n\r\n')[1]!.trim());const bytes=Buffer.from(parts[1]!.split('\r\n\r\n')[1]!.replace(/\r\n$/,''));const file={...metadata,bytes,size:String(bytes.length),sha256Checksum:hash(bytes),capabilities:{canDownload:true}};files.set(file.id,file);const {bytes:ignored,...result}=file;return Response.json(result);}
  if(u.pathname==='/drive/v3/files'&&request.method==='GET'){
   const parent=/'([^']+)' in parents/.exec(u.searchParams.get('q')||'')?.[1];const list=[...files.values()].filter(f=>parent?f.parents.includes(parent):f.mimeType==='application/vnd.google-apps.folder');const offset=Number(u.searchParams.get('pageToken')||0);return Response.json({files:list.slice(offset,offset+2).map(({bytes,...file})=>file),...(offset+2<list.length?{nextPageToken:String(offset+2)}:{})});
  }
  if(u.pathname.startsWith('/drive/v3/files/')){const id=u.pathname.split('/').at(-1)!,f=files.get(id);if(!f)return Response.json({error:{code:404}},{status:404});if(u.searchParams.get('alt')==='media')return new Response(new Uint8Array(f.bytes!).buffer);const {bytes,...metadata}=f;return Response.json(metadata);}
  if(u.pathname==='/upload/drive/v3/files'&&request.method==='POST'){
   if(quotaError)return Response.json({error:{errors:[{reason:'storageQuotaExceeded'}]}},{status:403});const metadata=await request.json() as File;const id=`SECRET_SESSION_${++sessionNumber}`;sessions.set(id,{file:{...metadata,capabilities:{canDownload:true}},chunks:[],offset:0});return new Response(null,{status:200,headers:{Location:`https://www.googleapis.com/upload/drive/v3/files?upload_id=${id}`}});
  }
  if(u.pathname==='/upload/drive/v3/files'&&request.method==='PUT'){
   const id=u.searchParams.get('upload_id')!,session=sessions.get(id);if(!session||expired){expired=false;sessions.delete(id);return new Response(null,{status:404});}
   const range=request.headers.get('Content-Range')!;if(range.startsWith('bytes */'))return new Response(null,{status:308,headers:session.offset?{Range:`bytes=0-${session.offset-1}`}:{}});
   const bytes=new Uint8Array(await request.arrayBuffer());session.chunks.push(bytes);session.offset+=bytes.length;if(failChunk){failChunk=false;return new Response(null,{status:503});}
   const total=Number(range.split('/').at(-1));if(session.offset<total)return new Response(null,{status:308,headers:{Range:`bytes=0-${session.offset-1}`}});
   const data=Buffer.concat(session.chunks);const file={...session.file,size:String(data.length),sha256Checksum:hash(data),bytes:data};files.set(file.id,file);const {bytes:ignored,...metadata}=file;return Response.json(metadata);
  }
  return Response.json({error:{code:404}},{status:404});
 }});
 const vault:SecretVault={async put(value,ref=randomUUID()){secrets.set(ref,value);return ref;},async get<T>(ref:string){return (secrets.get(ref)??null) as T|null;},async remove(ref){secrets.delete(ref);}};
 const auth={snapshot:()=>({connected:true,authorizing:false,generation:1,folder}),request:async(url:string,init?:RequestInit,signal?:AbortSignal)=>{const u=new URL(url);return fetch(new URL(u.pathname+u.search,server.url),{...init,redirect:'manual',signal});}};
 const path=join(root,'provider.json');const store=()=>new GoogleDriveStore({path,auth,vault,folder,generation:1});
 return {store,path,root,auth,vault,files,folder,add,requests,secrets,sessions,setFail(){failChunk=true;},expire(){expired=true;},quota(){quotaError=true;},unchanged(){changed=false;},cleanup(){server.stop(true);rmSync(root,{recursive:true,force:true});}};
}
