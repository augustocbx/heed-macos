import {track} from './process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import type {LibraryProvider} from './portable-provider';
import type {PortableCommit} from '@heed/shared';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const HASH=/^[a-f0-9]{64}$/;
const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const encode=(value:unknown)=>Buffer.from(JSON.stringify(value));
export interface SmbIdentity {type:'smbfs';fsid:string;sourceHash:string;mountPath:string;readOnly:boolean}
export interface SmbProbe {identity:SmbIdentity;security:'signed'|'encrypted'|'unknown';dialect:string;authentication:'macOS-session'}
export interface SmbBinding {id:string;name:string;root:string;identity:SmbIdentity;destinationId:string;readOnly:boolean;security:'signed'|'encrypted'|'unknown'}
export interface SmbRequest {action:'probe'|'library'|'header'|'prepare'|'create'|'test-write'|'list'|'read'|'write';root:string;identity?:SmbIdentity;destinationId?:string;stagingId?:string;path?:string;maxBytes?:number;bytes?:number;sha256?:string;header?:unknown}
export interface SmbNative {
 json(request:SmbRequest,signal?:AbortSignal):Promise<unknown>;
 read(request:SmbRequest,max:number,signal?:AbortSignal):Promise<Uint8Array>;
 stream(request:SmbRequest,max:number,signal?:AbortSignal):AsyncIterable<Uint8Array>;
 write(request:SmbRequest,source:AsyncIterable<Uint8Array>,signal?:AbortSignal):Promise<void>;
}
function failure(){return new Error('SMB operation unavailable. Check the mounted destination, access and library integrity.');}
function path(value:string){if(typeof value!=='string'||value.length>512||! /^(meetings|commits|objects)\/[A-Za-z0-9_./-]+$/.test(value)||value.split('/').some(p=>!p||p==='.'||p==='..'))throw new Error('Invalid SMB library path.');return value;}
function count(value:unknown):value is number{return typeof value==='number'&&Number.isSafeInteger(value)&&value>=0&&value<=8_000_000_000_000;}
export function smbProbe(value:unknown):SmbProbe {
 const p=value as SmbProbe;
 if(!p||typeof p!=='object'||Object.keys(p).sort().join(',')!=='authentication,dialect,identity,security'||!p.identity||Object.keys(p.identity).sort().join(',')!=='fsid,mountPath,readOnly,sourceHash,type'||p.identity.type!=='smbfs'||typeof p.identity.fsid!=='string'||!p.identity.fsid.length||!HASH.test(p.identity.sourceHash)||typeof p.identity.mountPath!=='string'||!p.identity.mountPath.startsWith('/')||typeof p.identity.readOnly!=='boolean'||!['signed','encrypted','unknown'].includes(p.security)||typeof p.dialect!=='string'||p.authentication!=='macOS-session')throw failure();
 return structuredClone(p);
}
export function destinationHeader(value:unknown):{format:'heed-portable-library';schemaVersion:1;destinationId:string}|null {
 if(value===null)return null;
 const h=value as {format:string;schemaVersion:number;destinationId:string};
 if(!h||typeof h!=='object'||Object.keys(h).sort().join(',')!=='destinationId,format,schemaVersion'||h.format!=='heed-portable-library'||h.schemaVersion!==1||!UUID.test(h.destinationId))throw new Error('Unsupported or corrupt SMB library.');
 return h as {format:'heed-portable-library';schemaVersion:1;destinationId:string};
}

/** Scoped child process: requests carry paths and opaque identities, never credentials. */
export class MacSmbNative implements SmbNative {
 private helper=fileURLToPath(new URL('../native/smb-filesystem.py',import.meta.url));
 private spawn(request:SmbRequest,signal?:AbortSignal){
  signal?.throwIfAborted();
  const process=track(Bun.spawn(['/usr/bin/python3',this.helper],{stdin:'pipe',stdout:'pipe',stderr:'ignore'}));
  process.stdin.write(encode(request));process.stdin.write('\n');
  const abort=()=>process.kill('SIGTERM');signal?.addEventListener('abort',abort,{once:true});
  const timeout=setTimeout(abort,120_000);
  const clean=()=>{clearTimeout(timeout);signal?.removeEventListener('abort',abort);};
  return {process,clean,abort};
 }
 async *stream(request:SmbRequest,max:number,signal?:AbortSignal){
  const {process,clean,abort}=this.spawn(request,signal);process.stdin.end();let received=0;
  try{for await(const chunk of process.stdout){signal?.throwIfAborted();received+=chunk.length;if(received>max)throw failure();yield chunk;}if(await process.exited!==0)throw failure();signal?.throwIfAborted();}
  finally{abort();await process.exited;clean();}
 }
 async read(request:SmbRequest,max:number,signal?:AbortSignal){const chunks:Uint8Array[]=[];for await(const chunk of this.stream(request,max,signal))chunks.push(chunk);return Buffer.concat(chunks);}
 async json(request:SmbRequest,signal?:AbortSignal){try{return JSON.parse(Buffer.from(await this.read(request,1_048_576,signal)).toString('utf8'));}catch{signal?.throwIfAborted();throw failure();}}
 async write(request:SmbRequest,source:AsyncIterable<Uint8Array>,signal?:AbortSignal){
  const {process,clean,abort}=this.spawn(request,signal);let written=0;const output=new Response(process.stdout).arrayBuffer();
  try{for await(const chunk of source){signal?.throwIfAborted();written+=chunk.length;if(written>(request.bytes??0))throw failure();await process.stdin.write(chunk);await process.stdin.flush();}if(written!==request.bytes)throw failure();process.stdin.end();if(await process.exited!==0)throw failure();if((await output).byteLength>4096)throw failure();signal?.throwIfAborted();}
  finally{process.stdin.end();abort();await process.exited;await output.catch(()=>{});clean();}
 }
}

/** Immutable SMB publications acknowledge verified share read-back, not server power-loss durability. */
export class SmbProvider implements LibraryProvider {
 readonly transport='authenticated-network' as const;
 readonly id:string;readonly name:string;readonly readOnly:boolean;
 readonly capabilities:{read:boolean;write:boolean;transportSecurity:'signed'|'encrypted'|'unknown';remoteDeletion:false;durability:'share-readback'};
 constructor(private binding:SmbBinding,private native:SmbNative=new MacSmbNative()){
  this.id=binding.id;this.name=binding.name;this.readOnly=binding.readOnly;
  this.capabilities={read:binding.security!=='unknown',write:!binding.readOnly&&binding.security!=='unknown',transportSecurity:binding.security,remoteDeletion:false,durability:'share-readback'};
 }
 private request(action:SmbRequest['action'],extra:Partial<SmbRequest>={}):SmbRequest{return {action,root:this.binding.root,identity:this.binding.identity,destinationId:this.binding.destinationId,stagingId:this.binding.id,...extra};}
 private async access(write:boolean,signal?:AbortSignal){
  signal?.throwIfAborted();const probe=smbProbe(await this.native.json(this.request('probe'),signal));
  if(probe.security==='unknown'||(this.binding.security==='encrypted'&&probe.security!=='encrypted')||['fsid','sourceHash','mountPath'].some(k=>probe.identity[k as keyof SmbIdentity]!==this.binding.identity[k as keyof SmbIdentity]))throw failure();
  const header=destinationHeader(await this.native.json(this.request('header'),signal));if(header?.destinationId!==this.binding.destinationId)throw new Error('SMB destination identity changed. Test and confirm the connection again.');
  if(write&&(this.readOnly||probe.identity.readOnly))throw new Error('SMB library is read-only. Import remains available.');
 }
 async list(cursor:string|null,limit:number,signal?:AbortSignal){
  if(!Number.isInteger(limit)||limit<1||limit>100)throw new Error('Invalid SMB discovery limit.');await this.access(false,signal);
  const result=await this.native.json(this.request('list'),signal);if(!Array.isArray(result)||result.length>10000||result.some(p=>typeof p!=='string'||!/^commits\/[a-f0-9-]{36}\/[a-f0-9-]{36}\.json$/.test(p)))throw failure();
  const paths=(result as string[]).sort();const identity=sha(encode(paths));let offset=0;
  if(cursor){const pieces=cursor.split(':');if(pieces.length!==2||pieces[0]!==identity||!/^\d+$/.test(pieces[1]!))throw new Error('SMB listing changed. Refresh the library to retry.');offset=Number(pieces[1]);if(offset<0||offset>=paths.length)throw failure();}
  const commits:PortableCommit[]=[];
  for(const file of paths.slice(offset,offset+limit)){signal?.throwIfAborted();const marker=JSON.parse(Buffer.from(await this.native.read(this.request('read',{path:file,maxBytes:16384}),16384,signal)).toString('utf8')) as PortableCommit;
   if(!marker||marker.schemaVersion!==1||![marker.libraryId,marker.meetingId,marker.revisionId,marker.deviceId].every(id=>typeof id==='string'&&UUID.test(id))||!HASH.test(marker.manifestHash)||file!==`commits/${marker.deviceId}/${marker.revisionId}.json`||marker.manifestPath!==`meetings/${marker.meetingId}/revisions/${marker.revisionId}/manifest.json`)throw new Error('Unsupported or corrupt SMB commit.');commits.push(marker);}
  return {commits,next:offset+limit<paths.length?`${identity}:${offset+limit}`:null,complete:true};
 }
 async read(file:string,max:number,signal?:AbortSignal){if(!count(max))throw failure();path(file);await this.access(false,signal);const value=await this.native.read(this.request('read',{path:file,maxBytes:max}),max,signal);if(value.length>max)throw failure();return value;}
 async *stream(file:string,max:number,signal?:AbortSignal){if(!count(max))throw failure();path(file);await this.access(false,signal);let received=0;for await(const chunk of this.native.stream(this.request('read',{path:file,maxBytes:max}),max,signal)){signal?.throwIfAborted();received+=chunk.length;if(received>max)throw failure();yield chunk;}}
 async writeImmutable(file:string,value:Uint8Array,signal?:AbortSignal){path(file);await this.access(true,signal);await this.native.write(this.request('write',{path:file,bytes:value.length,sha256:sha(value)}),(async function*(){yield value;})(),signal);}
 async writeObjectImmutable(file:string,size:number,digest:string,source:AsyncIterable<Uint8Array>,signal?:AbortSignal){if(!count(size)||!HASH.test(digest)||file!==`objects/${digest}`)throw failure();path(file);await this.access(true,signal);const hash=createHash('sha256');let received=0;
  const verified=(async function*(){for await(const chunk of source){signal?.throwIfAborted();received+=chunk.length;if(received>size)throw failure();hash.update(chunk);yield chunk;}if(received!==size||hash.digest('hex')!==digest)throw failure();})();await this.native.write(this.request('write',{path:file,bytes:size,sha256:digest}),verified,signal);
 }
 async confirm(marker:PortableCommit,signal?:AbortSignal):Promise<'remote-confirmed'>{
  await this.access(true,signal);const prefix=`meetings/${marker.meetingId}/revisions/${marker.revisionId}`;
  if(marker.manifestPath!==`${prefix}/manifest.json`||![marker.meetingId,marker.revisionId,marker.deviceId].every(id=>UUID.test(id))||!HASH.test(marker.manifestHash))throw failure();
  const stored=await this.read(`commits/${marker.deviceId}/${marker.revisionId}.json`,16384,signal);if(sha(stored)!==sha(encode(marker)))throw failure();
  const manifestBytes=await this.read(marker.manifestPath,65536,signal);if(sha(manifestBytes)!==marker.manifestHash)throw failure();
  const manifest=JSON.parse(Buffer.from(manifestBytes).toString('utf8'));
  if(manifest.libraryId!==marker.libraryId||manifest.meetingId!==marker.meetingId||manifest.revisionId!==marker.revisionId||!Array.isArray(manifest.artifacts)||manifest.artifacts.length!==1)throw failure();
  const artifact=manifest.artifacts[0];if(artifact.path!=='meeting.json'||!count(artifact.bytes)||artifact.bytes>16*1024*1024||!HASH.test(artifact.sha256))throw failure();
  const meetingBytes=await this.read(`${prefix}/meeting.json`,artifact.bytes,signal);if(meetingBytes.length!==artifact.bytes||sha(meetingBytes)!==artifact.sha256)throw failure();
  const meeting=JSON.parse(Buffer.from(meetingBytes).toString('utf8'));if(meeting.audio){const audio=meeting.audio;if(!count(audio.bytes)||!HASH.test(audio.sha256)||audio.objectPath!==`objects/${audio.sha256}`)throw failure();let received=0;const hash=createHash('sha256');for await(const chunk of this.stream(audio.objectPath,audio.bytes,signal)){received+=chunk.length;hash.update(chunk);}if(received!==audio.bytes||hash.digest('hex')!==audio.sha256)throw failure();}
  return 'remote-confirmed';
 }
}
