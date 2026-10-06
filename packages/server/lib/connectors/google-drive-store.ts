import {createHash,randomUUID} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync} from 'node:fs';import {dirname} from 'node:path';
import {atomicWriteJson} from '../atomic-json';
import {GoogleConnectionError,readGoogleJson,type GoogleAuth,type GoogleFolder} from './google-auth';
import type {SecretVault} from './keychain-vault';
const API='https://www.googleapis.com/drive/v3',UPLOAD='https://www.googleapis.com/upload/drive/v3/files';
const FOLDER='application/vnd.google-apps.folder',MAX_FILES=20000,CHUNK=524288;
const FILE_FIELDS='id,name,mimeType,parents,size,sha256Checksum,md5Checksum,version,properties,capabilities,driveId,trashed';
const HASH=/^[0-9a-f]{64}$/,ID=/^[-A-Za-z0-9_]{1,256}$/;
export interface DriveEntry {path:string;id:string;parentId:string;bytes:number;sha256?:string;version?:string}
interface RemoteFile {id:string;name:string;mimeType:string;parents?:string[];size?:string;sha256Checksum?:string;version?:string;properties?:Record<string,string>;capabilities?:{canDownload?:boolean;canAddChildren?:boolean};driveId?:string;trashed?:boolean}
interface Job {id:string;bytes:number;hash:string;uploadRef:string;offset:number;done?:boolean}
interface Candidate {checkpoint:string;files:Record<string,DriveEntry>;directories:Record<string,string>;nonce:string}
interface State {version:1;folderId:string;destinationId:string;files:Record<string,DriveEntry>;directories:Record<string,string>;jobs:Record<string,Job>;checkpoint?:string;candidate?:Candidate}
interface Options {path:string;auth:Pick<GoogleAuth,'snapshot'|'request'>;vault:SecretVault;folder:GoogleFolder;generation:number;write?:typeof atomicWriteJson}
function artifactPath(value:string):string{
 if(typeof value!=='string'||value.length>512||!(/^(objects|meetings|commits)\/[A-Za-z0-9_./-]+$/.test(value))||value.split('/').some(p=>!p||p==='.'||p==='..'))throw new Error('Invalid Drive artifact path');return value;
}
function size(file:RemoteFile){if(typeof file.size!=='string'||!/^\d+$/.test(file.size))throw new Error('Invalid Drive object metadata');const bytes=Number(file.size);if(!Number.isSafeInteger(bytes)||bytes<0)throw new Error('Invalid Drive object metadata');return bytes;}
function metadata(value:unknown):RemoteFile{
 const file=value as RemoteFile;if(!file||!ID.test(file.id)||typeof file.name!=='string'||file.name.length>512||typeof file.mimeType!=='string'||file.trashed||file.mimeType==='application/vnd.google-apps.shortcut'||(file.parents&&(!Array.isArray(file.parents)||file.parents.length>1||file.parents.some(p=>!ID.test(p)))))throw new Error('Invalid Drive object metadata');return file;
}
function url(path:string,parameters:Record<string,string>={}){const u=new URL(`${API}/${path}`);for(const [key,value] of Object.entries(parameters))u.searchParams.set(key,value);u.searchParams.set('supportsAllDrives','true');return u.toString();}
function sha(bytes:Uint8Array){return createHash('sha256').update(bytes).digest('hex');}
/** Stable Drive IDs implement immutable logical paths; only the chosen library is read or mutated. */
export class GoogleDriveStore {
 private state:State;
 constructor(private options:Options){
  if(!ID.test(options.folder.id))throw new Error('Invalid Drive folder');mkdirSync(dirname(options.path),{recursive:true,mode:0o700});
  this.state=existsSync(options.path)?JSON.parse(readFileSync(options.path,'utf8')):{version:1,folderId:options.folder.id,destinationId:options.folder.destinationId,files:{},directories:{},jobs:{}};
  if(this.state.version!==1||this.state.folderId!==options.folder.id||this.state.destinationId!==options.folder.destinationId||!this.state.files||!this.state.directories||!this.state.jobs||Object.keys(this.state.jobs).length>10000)throw new Error('Invalid Drive provider state; preserve it for recovery');
 }
 private persist(next:State){(this.options.write||atomicWriteJson)(this.options.path,next);this.state=next;}
 private edit(change:(next:State)=>void){const next=structuredClone(this.state);change(next);this.persist(next);}
 private binding(write=false){const current=this.options.auth.snapshot();
  if(!current.connected||current.authorizing||current.generation!==this.options.generation||current.folder?.id!==this.options.folder.id||current.folder.destinationId!==this.options.folder.destinationId)throw new GoogleConnectionError('connection-changed','Google library connection changed');
  if(write&&(!this.options.folder.canUpload||current.accessMode==='existing-readonly'))throw new GoogleConnectionError('read-only','Google library is read-only');
 }
 private async responseError(response:Response):Promise<never>{
  let reason='';try{const body=await readGoogleJson(response);const error=body.error as {errors?:Array<{reason?:string}>}|undefined;reason=error?.errors?.[0]?.reason||'';}catch{}
  if(['storageQuotaExceeded','teamDriveFileLimitExceeded'].includes(reason))throw new GoogleConnectionError('remote-quota','Google Drive quota is exhausted');
  if(response.status===429||['rateLimitExceeded','userRateLimitExceeded','dailyLimitExceeded'].includes(reason))throw new GoogleConnectionError('rate-limited','Google Drive rate limit reached; retry later');
  if(response.status===403)throw new GoogleConnectionError('permission-denied','Google Drive permission denied');
  if(response.status===404)throw new GoogleConnectionError('remote-unavailable','Google Drive object is unavailable');
  throw new GoogleConnectionError('provider-response','Google Drive request failed');
 }
 private async json(path:string,parameters:Record<string,string>={},init:RequestInit={},signal?:AbortSignal){
  this.binding();const response=await this.options.auth.request(url(path,parameters),init,signal);if(!response.ok)return this.responseError(response);return readGoogleJson(response,2097152);
 }
 private async file(id:string,signal?:AbortSignal){if(!ID.test(id))throw new Error('Invalid Drive file ID');return metadata(await this.json(`files/${id}`,{fields:FILE_FIELDS},{},signal));}
 private async children(parent:string,signal?:AbortSignal):Promise<RemoteFile[]>{
  if(!ID.test(parent))throw new Error('Invalid Drive parent ID');const files:RemoteFile[]=[];const seen=new Set<string>();let page:string|undefined;
  for(let index=0;index<100;index++){
   const result=await this.json('files',{q:`'${parent}' in parents and trashed = false`,pageSize:'1000',fields:`nextPageToken,incompleteSearch,files(${FILE_FIELDS})`,includeItemsFromAllDrives:'true',corpora:this.options.folder.driveId?'drive':'user',...(this.options.folder.driveId?{driveId:this.options.folder.driveId}:{}),...(page?{pageToken:page}:{})},{},signal);
   if(result.incompleteSearch===true||!Array.isArray(result.files)||result.files.length>1000)throw new Error('Drive discovery is incomplete');
   for(const raw of result.files){const file=metadata(raw);if(!file.parents?.includes(parent))throw new Error('Drive object is outside the selected library');files.push(file);if(files.length>MAX_FILES)throw new Error('Drive discovery limit reached');}
   if(!result.nextPageToken)return files;if(typeof result.nextPageToken!=='string'||seen.has(result.nextPageToken))throw new Error('Invalid Drive pagination');seen.add(result.nextPageToken);page=result.nextPageToken;
  }throw new Error('Drive discovery page limit reached');
 }
 private async download(file:RemoteFile,maxBytes:number,signal?:AbortSignal):Promise<Uint8Array>{
  const bytes=size(file);if(bytes>maxBytes||maxBytes>16777216||file.capabilities?.canDownload!==true)throw new Error('Drive object exceeds the read limit or is restricted');
  const response=await this.options.auth.request(url(`files/${file.id}`,{alt:'media'}),{},signal);if(!response.ok)return this.responseError(response);if(!response.body)throw new Error('Drive object is unavailable');
  const chunks:Uint8Array[]=[];let count=0;const reader=response.body.getReader();try{while(true){const item=await reader.read();if(item.done)break;count+=item.value.length;if(count>maxBytes||count>bytes)throw new Error('Drive integrity verification failed');chunks.push(item.value);}if(count!==bytes)throw new Error('Drive integrity verification failed');return Buffer.concat(chunks);}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
 }
 private async root(write=false,signal?:AbortSignal){
  this.binding(write);const folder=await this.file(this.options.folder.id,signal);if(folder.mimeType!==FOLDER||(write&&folder.capabilities?.canAddChildren!==true)||folder.driveId!==this.options.folder.driveId)throw new Error('Drive library permissions or identity changed');
  const headers=(await this.children(folder.id,signal)).filter(f=>f.name==='heed-library.json');if(headers.length!==1)throw new Error('Drive library identity is unavailable');
  const header=JSON.parse(Buffer.from(await this.download(headers[0]!,4096,signal)).toString('utf8'));
  if(!header||Object.keys(header).sort().join(',')!=='destinationId,format,schemaVersion'||header.format!=='heed-portable-library'||header.schemaVersion!==1||header.destinationId!==this.options.folder.destinationId)throw new Error('Drive library identity changed');
 }
 private entry(path:string,file:RemoteFile,parentId:string):DriveEntry{return {path,id:file.id,parentId,bytes:size(file),sha256:file.sha256Checksum,version:file.version};}
 private async addEntry(files:Record<string,DriveEntry>,path:string,file:RemoteFile,parentId:string,signal?:AbortSignal){
  artifactPath(path);const entry=this.entry(path,file,parentId),old=files[path];
  if(old&&old.id!==entry.id){if(old.bytes!==entry.bytes)throw new Error('Conflicting immutable Drive paths');
   if(!old.sha256||!entry.sha256){if(entry.bytes>65536)throw new Error('Ambiguous Drive objects require manual reconciliation');const oldFile=await this.file(old.id,signal);if(sha(await this.download(oldFile,65536,signal))!==sha(await this.download(file,65536,signal)))throw new Error('Conflicting immutable Drive paths');}
   else if(old.sha256!==entry.sha256)throw new Error('Conflicting immutable Drive paths');
   if(old.id.localeCompare(entry.id)<=0)return;
  }files[path]=entry;
 }
 private async scan(signal?:AbortSignal):Promise<Candidate>{
  const start=await this.json('changes/startPageToken',this.options.folder.driveId?{driveId:this.options.folder.driveId}:{},{},signal);if(typeof start.startPageToken!=='string')throw new Error('Invalid Drive checkpoint');
  const files:Record<string,DriveEntry>={},directories:Record<string,string>={};const queue=[{id:this.options.folder.id,path:''}];let requests=0;
  while(queue.length){if(++requests>300)throw new Error('Drive reconciliation limit reached');const parent=queue.shift()!;
   for(const file of await this.children(parent.id,signal)){
    if(!parent.path&&file.name==='heed-library.json')continue;
    const property=file.properties?.heedPath;const path=property||`${parent.path?`${parent.path}/`:''}${file.name}`;
    if(file.mimeType===FOLDER){if(!parent.path&&!['commits','meetings','objects'].includes(file.name))continue;if(property||file.name==='.'||file.name==='..'||file.name.includes('/')||path.split('/').length>6)throw new Error('Invalid Drive library directory');if(directories[path]&&directories[path]!==file.id)throw new Error('Ambiguous Drive library directories');directories[path]=file.id;queue.push({id:file.id,path});}
    else {if(property){if(parent.path||file.properties?.heedDestination!==this.options.folder.destinationId)throw new Error('Drive object is outside the selected library');}else if(!parent.path)continue;await this.addEntry(files,path,file,parent.id,signal);}
    if(Object.keys(files).length+Object.keys(directories).length>MAX_FILES)throw new Error('Drive library metadata limit reached');
   }
  }return {checkpoint:start.startPageToken,files,directories,nonce:randomUUID()};
 }
 private async changes(signal?:AbortSignal):Promise<Candidate>{
  const files=structuredClone(this.state.files),directories=structuredClone(this.state.directories);let page=this.state.checkpoint!;const seen=new Set<string>();
  for(let index=0;index<100;index++){
   const response=await this.options.auth.request(url('changes',{pageToken:page,fields:`nextPageToken,newStartPageToken,changes(fileId,removed,file(${FILE_FIELDS}))`,pageSize:'1000',includeItemsFromAllDrives:'true',...(this.options.folder.driveId?{driveId:this.options.folder.driveId}:{})}),{},signal);
   if(response.status===410){await response.body?.cancel();return this.scan(signal);}if(!response.ok)return this.responseError(response);const result=await readGoogleJson(response,2097152);
   if(!Array.isArray(result.changes)||result.changes.length>1000)throw new Error('Invalid Drive changes page');
   for(const raw of result.changes){const change=raw as {fileId:string;removed?:boolean;file?:RemoteFile};if(!ID.test(change.fileId))throw new Error('Invalid Drive change');const old=Object.values(files).find(f=>f.id===change.fileId);
    if(change.removed){if(old)delete files[old.path];if(Object.values(directories).includes(change.fileId))return this.scan(signal);continue;}
    const file=metadata(change.file);const parent=file.parents?.[0],parentPath=Object.keys(directories).find(path=>directories[path]===parent);
    if(file.mimeType===FOLDER){if(parent===this.options.folder.id||parentPath!==undefined||Object.values(directories).includes(file.id))return this.scan(signal);continue;}
    if(parent!==this.options.folder.id&&parentPath===undefined){if(old)delete files[old.path];continue;}
    if(parent===this.options.folder.id&&file.name==='heed-library.json')continue;
    const path=file.properties?.heedPath||(parentPath?`${parentPath}/${file.name}`:undefined);if(!path)continue;
    if(file.properties?.heedPath&&(parent!==this.options.folder.id||file.properties.heedDestination!==this.options.folder.destinationId))throw new Error('Drive object is outside the selected library');
    if(old&&old.path!==path)throw new Error('Immutable Drive path changed');await this.addEntry(files,path,file,parent!,signal);
   }
   if(typeof result.nextPageToken==='string'){if(seen.has(result.nextPageToken))throw new Error('Drive changes repeated a checkpoint');seen.add(result.nextPageToken);page=result.nextPageToken;continue;}
   if(typeof result.newStartPageToken!=='string')throw new Error('Invalid final Drive checkpoint');return {checkpoint:result.newStartPageToken,files,directories,nonce:randomUUID()};
  }throw new Error('Drive changes page limit reached');
 }
 async discover(signal?:AbortSignal):Promise<DriveEntry[]>{
  await this.root(false,signal);if(!this.state.candidate){const candidate=this.state.checkpoint?await this.changes(signal):await this.scan(signal);this.edit(next=>{next.candidate=candidate;});}
  return Object.values(this.state.candidate!.files).map(f=>structuredClone(f)).sort((a,b)=>a.path.localeCompare(b.path));
 }
 async acknowledgeDiscovery(signal?:AbortSignal):Promise<void>{signal?.throwIfAborted();await this.root(false,signal);if(!this.state.candidate)return;const candidate=this.state.candidate;this.edit(next=>{next.checkpoint=candidate.checkpoint;next.files=candidate.files;next.directories=candidate.directories;delete next.candidate;});}
 private async resolve(path:string,signal?:AbortSignal):Promise<RemoteFile>{
  artifactPath(path);const candidates=this.state.candidate?.files||this.state.files;let directories=this.state.candidate?.directories||this.state.directories;let entry=candidates[path];
  if(!entry){const discovered=await this.scan(signal);entry=discovered.files[path];directories=discovered.directories;if(!entry)throw new Error('Drive object is unavailable');}
  const file=await this.file(entry.id,signal);
  let parent=entry.parentId;let directory=path.split('/').slice(0,-1).join('/');
  for(let depth=0;parent!==this.options.folder.id;depth++){if(depth>=6||!directory||directories[directory]!==parent)throw new Error('Drive object is outside the selected library');const folder=await this.file(parent,signal);const expectedName=directory.split('/').at(-1);directory=directory.split('/').slice(0,-1).join('/');const expectedParent=directory?directories[directory]:this.options.folder.id;if(folder.mimeType!==FOLDER||folder.name!==expectedName||!expectedParent||folder.parents?.[0]!==expectedParent)throw new Error('Drive object is outside the selected library');parent=expectedParent;}
  if(file.properties?.heedPath?(file.properties.heedDestination!==this.options.folder.destinationId||entry.parentId!==this.options.folder.id):file.name!==path.split('/').at(-1))throw new Error('Drive immutable path changed');
  if(!file.parents?.includes(entry.parentId)||file.mimeType===FOLDER||(file.properties?.heedPath&&file.properties.heedPath!==path)||entry.bytes!==size(file)||(entry.sha256&&file.sha256Checksum&&entry.sha256!==file.sha256Checksum))throw new Error('Drive integrity or immutable path verification failed');return file;
 }
 async read(path:string,maxBytes:number,signal?:AbortSignal):Promise<Uint8Array>{await this.root(false,signal);return this.download(await this.resolve(path,signal),maxBytes,signal);}
 async *stream(path:string,maxBytes:number,signal?:AbortSignal):AsyncIterable<Uint8Array>{
  await this.root(false,signal);const file=await this.resolve(path,signal),bytes=size(file);if(bytes>maxBytes||file.capabilities?.canDownload!==true)throw new Error('Drive media is unavailable or exceeds its limit');
  const response=await this.options.auth.request(url(`files/${file.id}`,{alt:'media'}),{},signal);if(!response.ok)return this.responseError(response);if(!response.body)throw new Error('Drive media is unavailable');let count=0;const reader=response.body.getReader();
  try{while(true){signal?.throwIfAborted();const chunk=await reader.read();if(chunk.done)break;count+=chunk.value.length;if(count>maxBytes||count>bytes)throw new Error('Drive integrity verification failed');yield chunk.value;}if(count!==bytes)throw new Error('Drive integrity verification failed');}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
 }
 async verify(path:string,bytes:number,expectedHash:string,signal?:AbortSignal):Promise<void>{
  if(!HASH.test(expectedHash))throw new Error('Invalid expected Drive hash');await this.root(false,signal);const file=await this.resolve(path,signal);
  if(size(file)!==bytes)throw new Error('Drive integrity verification failed');if(file.sha256Checksum){if(file.sha256Checksum!==expectedHash)throw new Error('Drive integrity verification failed');return;}
  const digest=createHash('sha256');for await(const chunk of this.stream(path,bytes,signal))digest.update(chunk);if(digest.digest('hex')!==expectedHash)throw new Error('Drive integrity verification failed');
 }
 private async lookupWritable(path:string,signal?:AbortSignal):Promise<RemoteFile|null>{
  const scanned=await this.scan(signal),entry=scanned.files[path];if(!entry)return null;
  this.edit(next=>{next.files[path]=entry;next.directories={...next.directories,...scanned.directories};if(next.candidate){next.candidate.files[path]=entry;next.candidate.directories={...next.candidate.directories,...scanned.directories};}});return this.resolve(path,signal);
 }
 private uploadUrl(value:string){const target=new URL(value);if(target.origin!=='https://www.googleapis.com'||target.pathname!=='/upload/drive/v3/files'||target.username||target.password||target.hash||!target.searchParams.has('upload_id'))throw new Error('Invalid Drive resumable upload destination');return target.toString();}
 private async begin(path:string,job:Job,signal?:AbortSignal){
  this.binding(true);const response=await this.options.auth.request(`${UPLOAD}?uploadType=resumable&supportsAllDrives=true&fields=${encodeURIComponent(FILE_FIELDS)}`,{method:'POST',headers:{'Content-Type':'application/json','X-Upload-Content-Type':'application/octet-stream','X-Upload-Content-Length':String(job.bytes)},body:JSON.stringify({id:job.id,name:path.replaceAll('/','__'),parents:[this.options.folder.id],mimeType:'application/octet-stream',properties:{heedPath:path,heedDestination:this.options.folder.destinationId}})},signal);
  if(!response.ok)return this.responseError(response);const location=response.headers.get('location');await response.body?.cancel();if(!location)throw new Error('Drive did not acknowledge an upload session');await this.options.vault.put({url:this.uploadUrl(location)},job.uploadRef);this.edit(next=>{next.jobs[path]!.offset=0;});return location;
 }
 private offset(response:Response,total:number,max:number){const range=response.headers.get('range');if(!range)return 0;const match=/^bytes=0-(\d+)$/.exec(range);const offset=match?Number(match[1])+1:NaN;if(!Number.isSafeInteger(offset)||offset<0||offset>total||offset>max)throw new Error('Invalid Drive upload acknowledgment');return offset;}
 private async finish(path:string,job:Job,signal?:AbortSignal){
  const file=await this.file(job.id,signal);if(!file.parents?.includes(this.options.folder.id)||file.properties?.heedPath!==path||file.properties.heedDestination!==this.options.folder.destinationId)throw new Error('Drive upload identity changed');
  this.edit(next=>{next.files[path]=this.entry(path,file,this.options.folder.id);if(next.candidate)next.candidate.files[path]=next.files[path]!;next.jobs[path]!.done=true;});await this.verify(path,job.bytes,job.hash,signal);await this.options.vault.remove(job.uploadRef);this.edit(next=>{delete next.jobs[path];});
 }
 async write(path:string,bytes:number,expectedHash:string,source:AsyncIterable<Uint8Array>,signal?:AbortSignal):Promise<void>{
  artifactPath(path);if(!Number.isSafeInteger(bytes)||bytes<1||!HASH.test(expectedHash))throw new Error('Invalid immutable Drive object');await this.root(true,signal);
  const existing=await this.lookupWritable(path,signal);if(existing){await this.verify(path,bytes,expectedHash,signal);const old=this.state.jobs[path];if(old){await this.options.vault.remove(old.uploadRef);this.edit(next=>{delete next.jobs[path];});}return;}
  let job=this.state.jobs[path];if(job&&(job.bytes!==bytes||job.hash!==expectedHash))throw new Error('Immutable Drive upload collision');
  if(!job){if(Object.keys(this.state.jobs).length>=10000)throw new Error('Drive pending upload limit reached');const generated=await this.json('files/generateIds',{count:'1',space:'drive',type:'files'},{},signal);const id=Array.isArray(generated.ids)?generated.ids[0]:undefined;if(typeof id!=='string'||!ID.test(id))throw new Error('Invalid generated Drive file ID');job={id,bytes,hash:expectedHash,uploadRef:randomUUID(),offset:0};this.edit(next=>{next.jobs[path]=job!;});}
  let secret=await this.options.vault.get<{url:string}>(job.uploadRef),session=secret?.url?this.uploadUrl(secret.url):await this.begin(path,job,signal),offset=0;
  if(secret?.url){const probe=await this.options.auth.request(session,{method:'PUT',headers:{'Content-Range':`bytes */${bytes}`,'Content-Length':'0'}},signal);
   if(probe.ok){await probe.body?.cancel();await this.finish(path,job,signal);return;}
   if(probe.status===404){await probe.body?.cancel();session=await this.begin(path,job,signal);}
   else if(probe.status===308){offset=this.offset(probe,bytes,bytes);await probe.body?.cancel();}else return this.responseError(probe);
  }
  const digest=createHash('sha256');let consumed=0,sent=offset,pending=Buffer.alloc(0);
  const send=async(chunk:Uint8Array,final=false)=>{
   this.binding(true);const response=await this.options.auth.request(session,{method:'PUT',headers:{'Content-Range':`bytes ${sent}-${sent+chunk.length-1}/${bytes}`,'Content-Length':String(chunk.length)},body:chunk as BodyInit},signal);
   if(final){if(!response.ok)return this.responseError(response);await response.body?.cancel();sent+=chunk.length;return;}
   if(response.status!==308)return this.responseError(response);const received=this.offset(response,bytes,sent+chunk.length);await response.body?.cancel();if(received!==sent+chunk.length)throw new Error('Drive upload made incomplete progress');sent=received;this.edit(next=>{next.jobs[path]!.offset=sent;});
  };
  for await(const chunk of source){signal?.throwIfAborted();if(!(chunk instanceof Uint8Array)||chunk.length>8388608||consumed+chunk.length>bytes)throw new Error('Drive source integrity verification failed');digest.update(chunk);const from=Math.max(0,offset-consumed);consumed+=chunk.length;if(from<chunk.length)pending=Buffer.concat([pending,chunk.subarray(from)]);while(pending.length>CHUNK){await send(pending.subarray(0,CHUNK));pending=pending.subarray(CHUNK);}}
  if(consumed!==bytes||digest.digest('hex')!==expectedHash||!pending.length)throw new Error('Drive source integrity verification failed');await send(pending,true);await this.root(true,signal);await this.finish(path,job,signal);
 }
}
