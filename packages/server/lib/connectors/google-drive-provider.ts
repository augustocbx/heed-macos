import type {PortableCommit,PortableMeeting} from '@heed/shared';import type {LibraryProvider} from '../portable-provider';import {providerPath} from '../portable-provider';
import {encode,MAX_ARTIFACT_BYTES,revisionPath,sha256,validateBundle,validateCommit,validateManifest,validateMeeting} from '../portable-schema';import {GoogleDriveStore} from './google-drive-store';
export class GoogleDriveProvider implements LibraryProvider {
 readonly id:string;readonly name:string;readonly readOnly:boolean;readonly capabilities:{read:true;write:boolean;transportSecurity:'encrypted';remoteDeletion:false;durability:'provider-receipt'};readonly transport='authenticated-network' as const;
 private active=new Map<AbortController,Promise<unknown>>();
 private async execute<T>(signal:AbortSignal|undefined,run:(signal:AbortSignal)=>Promise<T>):Promise<T>{this.options.assertAvailable?.();const controller=new AbortController();const combined=signal?AbortSignal.any([signal,controller.signal]):controller.signal;const job=Promise.resolve().then(()=>{this.options.assertAvailable?.();return run(combined);});this.active.set(controller,job);try{return await job;}finally{this.active.delete(controller);}}
 async preempt(){const jobs=[...this.active];for(const [controller] of jobs)controller.abort();await Promise.allSettled(jobs.map(([,job])=>job));}
 constructor(private options:{id:string;name:string;store:GoogleDriveStore;assertAvailable?:()=>void;readOnly?:boolean;onConfirmed?:(marker:PortableCommit,payload:PortableMeeting,signal?:AbortSignal)=>Promise<void>}){this.id=options.id;this.name=options.name;this.readOnly=options.readOnly===true;this.capabilities={read:true,write:!this.readOnly,transportSecurity:'encrypted',remoteDeletion:false,durability:'provider-receipt'};}
 list(cursor:string|null,limit:number,signal?:AbortSignal){return this.execute(signal,s=>this.listCore(cursor,limit,s));}
 acknowledgeDiscovery(signal?:AbortSignal){return this.execute(signal,s=>this.acknowledgeDiscoveryCore(s));}
 read(path:string,maxBytes:number,signal?:AbortSignal){return this.execute(signal,s=>this.readCore(path,maxBytes,s));}
 writeObjectImmutable(path:string,bytes:number,hash:string,source:AsyncIterable<Uint8Array>,signal?:AbortSignal){return this.execute(signal,s=>this.writeObjectImmutableCore(path,bytes,hash,source,s));}
 writeImmutable(path:string,bytes:Uint8Array,signal?:AbortSignal){return this.execute(signal,s=>this.writeImmutableCore(path,bytes,s));}
 confirm(raw:PortableCommit,signal?:AbortSignal){return this.execute(signal,s=>this.confirmCore(raw,s));}
 private async listCore(cursor:string|null,limit:number,signal?:AbortSignal){
  if(!Number.isSafeInteger(limit)||limit<1||limit>1000)throw new Error('Invalid Drive discovery page size');const entries=(await this.options.store.discover(signal)).filter(file=>file.path.startsWith('commits/'));const identity=sha256(encode(entries));let offset=0;
  if(cursor){const match=/^([a-f0-9]{64}):(\d+)$/.exec(cursor);if(!match||match[1]!==identity)throw new Error('Drive listing changed; refresh to retry');offset=Number(match[2]);if(!Number.isSafeInteger(offset)||offset<0||offset>=entries.length)throw new Error('Invalid Drive discovery cursor');}
  const commits:PortableCommit[]=[];for(const entry of entries.slice(offset,offset+limit)){const marker=validateCommit(JSON.parse(Buffer.from(await this.options.store.read(entry.path,65536,signal)).toString('utf8')));if(entry.path!==`commits/${marker.deviceId}/${marker.revisionId}.json`)throw new Error('Invalid Drive commit path');commits.push(marker);}
  return {commits,next:offset+limit<entries.length?`${identity}:${offset+limit}`:null,complete:true};
 }
 private acknowledgeDiscoveryCore(signal?:AbortSignal){return this.options.store.acknowledgeDiscovery(signal);}
 private readCore(path:string,maxBytes:number,signal?:AbortSignal){return this.options.store.read(providerPath(path),maxBytes,signal);}
 async *stream(path:string,maxBytes:number,signal?:AbortSignal){this.options.assertAvailable?.();const controller=new AbortController();const combined=signal?AbortSignal.any([signal,controller.signal]):controller.signal;let complete!:()=>void;const done=new Promise<void>(resolve=>{complete=resolve;});this.active.set(controller,done);try{for await(const chunk of this.options.store.stream(providerPath(path),maxBytes,combined))yield chunk;}finally{complete();this.active.delete(controller);}}
 private async writeObjectImmutableCore(path:string,bytes:number,hash:string,source:AsyncIterable<Uint8Array>,signal?:AbortSignal){if(providerPath(path)!==`objects/${hash}`)throw new Error('Invalid Drive content-addressed object');await this.options.store.write(path,bytes,hash,source,signal);}
 private async required(marker:PortableCommit,signal?:AbortSignal){
  const manifest=validateManifest(JSON.parse(Buffer.from(await this.read(marker.manifestPath,65536,signal)).toString('utf8'))),prefix=revisionPath(marker.meetingId,marker.revisionId);const meetingBytes=await this.read(`${prefix}/meeting.json`,MAX_ARTIFACT_BYTES,signal),payload=validateBundle(marker,manifest,meetingBytes);
  await this.options.store.verify(marker.manifestPath,encode(manifest).length,marker.manifestHash,signal);await this.options.store.verify(`${prefix}/meeting.json`,manifest.artifacts[0]!.bytes,manifest.artifacts[0]!.sha256,signal);
  if(payload.audio)await this.options.store.verify(payload.audio.objectPath,payload.audio.bytes,payload.audio.sha256,signal);return payload;
 }
 private async writeImmutableCore(path:string,bytes:Uint8Array,signal?:AbortSignal){
  providerPath(path);if(bytes.length>MAX_ARTIFACT_BYTES)throw new Error('Drive metadata artifact exceeds its limit');const value=JSON.parse(Buffer.from(bytes).toString('utf8'));
  if(path.startsWith('commits/')){const marker=validateCommit(value);if(path!==`commits/${marker.deviceId}/${marker.revisionId}.json`)throw new Error('Invalid Drive commit path');await this.required(marker,signal);}
  else if(path.endsWith('/manifest.json')){const manifest=validateManifest(value);if(path!==`${revisionPath(manifest.meetingId,manifest.revisionId)}/manifest.json`)throw new Error('Invalid Drive manifest path');const prefix=revisionPath(manifest.meetingId,manifest.revisionId),meetingBytes=await this.read(`${prefix}/meeting.json`,manifest.artifacts[0]!.bytes,signal);if(meetingBytes.length!==manifest.artifacts[0]!.bytes||sha256(meetingBytes)!==manifest.artifacts[0]!.sha256)throw new Error('Drive meeting integrity verification failed');const payload=validateMeeting(JSON.parse(Buffer.from(meetingBytes).toString('utf8')));if(payload.meetingId!==manifest.meetingId)throw new Error('Drive meeting identity changed');if(payload.audio)await this.options.store.verify(payload.audio.objectPath,payload.audio.bytes,payload.audio.sha256,signal);}
  else if(path.endsWith('/meeting.json')){const payload=validateMeeting(value);if(!path.startsWith(`meetings/${payload.meetingId}/revisions/`))throw new Error('Invalid Drive meeting path');if(payload.audio)await this.options.store.verify(payload.audio.objectPath,payload.audio.bytes,payload.audio.sha256,signal);}
  else throw new Error('Unsupported Drive metadata artifact');
  async function* chunks(){for(let offset=0;offset<bytes.length;offset+=524288)yield bytes.subarray(offset,offset+524288);}
  await this.options.store.write(path,bytes.length,sha256(bytes),chunks(),signal);
 }
 private async confirmCore(raw:PortableCommit,signal?:AbortSignal):Promise<'remote-confirmed'>{
  const marker=validateCommit(raw);const payload=await this.required(marker,signal);const path=`commits/${marker.deviceId}/${marker.revisionId}.json`,bytes=encode(marker);await this.options.store.verify(path,bytes.length,sha256(bytes),signal);await this.options.onConfirmed?.(marker,payload,signal);return 'remote-confirmed';
 }
}
