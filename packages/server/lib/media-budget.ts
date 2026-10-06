import {ManagedQuota} from './managed-quota';
/** A file-import job owns its source, normalized media and processing copies before disk I/O. */
export function reserveMediaWork(quota:ManagedQuota,id:string,path:string,work:string,knownSize?:number){
 const available=quota.snapshot().availableBytes;
 const headroom=Math.min(16_000_000,Math.max(1_000_000,Math.floor(available*0.05)));
 const maxSourceBytes=Math.floor((available-headroom)/4);
 if(maxSourceBytes<64_000 || (knownSize!==undefined && (!Number.isSafeInteger(knownSize)||knownSize<=0||knownSize>maxSourceBytes)))throw new Error('Managed meeting quota cannot fit the media import and its working copies. Increase the configured storage limit.');
 const reservedBytes=maxSourceBytes*4;
 const key=`media-${id}`;
 quota.reserve(key,reservedBytes,[path,work,path.replace(/\.wav$/,'-mic.wav'),path.replace(/\.wav$/,'-sys.wav')]);
 let released=false;
 return {maxSourceBytes,reservedBytes,release(){if(!released){quota.release(key);released=true;}}};
}
