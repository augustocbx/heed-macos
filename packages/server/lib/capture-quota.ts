import {existsSync,lstatSync} from 'node:fs';
import {ManagedQuota} from './managed-quota';
export interface CaptureAllocation {maxCaptureBytes:number;reservedBytes:number;metadataHeadroom:number}
const metadataSize=(paths:string[])=>[...new Set(paths)].reduce((sum,path)=>sum+(existsSync(path)?lstatSync(path).size:0),0);
const mediaPaths=(path:string,work:string)=>[path,work,path.replace(/\.wav$/,'-mic.wav'),path.replace(/\.wav$/,'-sys.wav')];
/** Media and final metadata have separate durable promises; another job cannot spend either. */
export function reserveCapture(quota:ManagedQuota,meetingId:string,path:string,workDirectory:string,metadataPaths:string[]):CaptureAllocation{
 const id=`capture-${meetingId}`,metaId=`capture-meta-${meetingId}`,existing=quota.allocation(id),existingMetadata=quota.allocation(metaId);
 if(existing && existingMetadata)return {maxCaptureBytes:Math.floor(existing.bytes/4),reservedBytes:existing.bytes+existingMetadata.bytes,metadataHeadroom:existingMetadata.bytes};
 const available=quota.snapshot().availableBytes;
 const headroom=Math.min(16_000_000,Math.max(1_000_000,Math.floor(available*0.05)));
 const maxCaptureBytes=existing?Math.floor(existing.bytes/4):Math.floor((available-headroom)/4);
 if(maxCaptureBytes<64_000)throw new Error('Managed meeting quota has insufficient space for capture and finalization. Increase the limit or remove eligible local media.');
 const mediaBytes=existing?.bytes ?? maxCaptureBytes*4;
 if(!existing)quota.reserve(id,mediaBytes,mediaPaths(path,workDirectory));
 const metadataHeadroom=headroom+metadataSize(metadataPaths);
 try{quota.reserve(metaId,metadataHeadroom,metadataPaths);}catch(error){if(!existing)quota.release(id);throw error;}
 return {maxCaptureBytes,reservedBytes:mediaBytes+metadataHeadroom,metadataHeadroom};
}
export function reserveFinalization(quota:ManagedQuota,meetingId:string,path:string,workDirectory:string,metadataPaths:string[]):void{
 const id=`capture-${meetingId}`,metaId=`capture-meta-${meetingId}`;
 const existing=quota.allocation(id);
 if(!existing)quota.reserve(id,Math.max(lstatSync(path).size*4,256_000),mediaPaths(path,workDirectory));
 try{if(!quota.allocation(metaId))quota.reserve(metaId,Math.min(16_000_000,Math.max(1_000_000,Math.floor(quota.snapshot().availableBytes*0.05)))+metadataSize(metadataPaths),metadataPaths);}
 catch(error){if(!existing)quota.release(id);throw error;}
}
export function releaseCapture(quota:ManagedQuota,meetingId:string):void{quota.release(`capture-${meetingId}`);quota.release(`capture-meta-${meetingId}`);}
