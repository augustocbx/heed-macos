import {readdirSync, lstatSync, unlinkSync, readFileSync, writeFileSync, existsSync} from 'node:fs';
import {join, basename} from 'node:path';

export const AUDIO_LIMIT_BYTES = 2_000_000_000;
const AUDIO = /\.(wav|mp3|m4a|aac|flac|ogg|opus|aiff|aif|webm|mp4|mov)$/i;
function group(name:string) {return name.replace(/-(mic|sys)(?=\.wav$)/,'').replace(/\.[^.]+$/,'');}

/** Only regular audio files in this directory are eligible. Text/session history survives. */
export function enforceAudioRetention(directory:string, sessions:string, limit=AUDIO_LIMIT_BYTES, protectedPaths:string[]=[]){
 const protectedGroups=new Set(protectedPaths.map(p=>group(basename(p))));
 const groups=new Map<string,{paths:string[];bytes:number;oldest:number}>();
 let bytes=0; const removed:string[]=[];
 for(const name of readdirSync(directory)) {
  if(!AUDIO.test(name))continue;
  const path=join(directory,name);const stat=lstatSync(path);if(!stat.isFile())continue;
  const key=group(name);const item=groups.get(key)||{paths:[],bytes:0,oldest:stat.mtimeMs};
  item.paths.push(path);item.bytes+=stat.size;item.oldest=Math.min(item.oldest,stat.mtimeMs);groups.set(key,item);bytes+=stat.size;
 }
 for(const [key,item] of [...groups].sort((a,b)=>a[1].oldest-b[1].oldest)) {
  if(bytes<=limit)break;if(protectedGroups.has(key))continue;
  for(const path of item.paths){const size=lstatSync(path).size;unlinkSync(path);bytes-=size;removed.push(path);}
 }
 if(removed.length && existsSync(sessions))for(const name of readdirSync(sessions).filter(n=>n.endsWith('.json'))) {
  const path=join(sessions,name);
  if(!lstatSync(path).isFile())continue;
  let session;try{session=JSON.parse(readFileSync(path,'utf8'));}catch{continue;}
  if(removed.includes(session.files?.wav)) {
   session.files.wav='';session.audioExpired=true;session.audioRemovedAt=new Date().toISOString();
   writeFileSync(path,JSON.stringify(session,null,2));
  }
 }
 return {bytes,limitBytes:limit,removed,overLimit:bytes>limit};
}

export function removeChannelCopies(path:string) {
 if(!/dual-capture-\d+\.wav$/.test(basename(path)))return;
 for(const channel of ['mic','sys']) {
  const copy=path.replace(/\.wav$/,`-${channel}.wav`);
  if(existsSync(copy)&&lstatSync(copy).isFile())unlinkSync(copy);
 }
}
