import {lstatSync,readdirSync,realpathSync,rmSync,unlinkSync,fsyncSync,openSync,closeSync} from 'node:fs';
import {dirname,isAbsolute,relative,resolve,sep} from 'node:path';
import type {Session} from '@heed/shared';

export interface OwnedMeetingAudio {audioPath:string;workDirectory:string;recordingsRoots:string[];stagingRoot:string}
const within=(root:string,path:string)=>{const child=relative(resolve(root),resolve(path));return !!child&&child!=='..'&&!child.startsWith(`..${sep}`)&&!isAbsolute(child);};
function info(path:string){try{return lstatSync(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}}
function ownedPaths(options:OwnedMeetingAudio):string[]{
 const {audioPath,workDirectory,recordingsRoots,stagingRoot}=options;
 if(!isAbsolute(audioPath)||!audioPath.endsWith('.wav')||!recordingsRoots.some(root=>within(root,audioPath))||!within(stagingRoot,workDirectory)||dirname(resolve(workDirectory))!==resolve(stagingRoot))throw Error('Cleanup requires exact managed meeting audio paths');
 const root=recordingsRoots.find(root=>within(root,audioPath))!;
 const paths=[audioPath,audioPath.replace(/\.wav$/,'-mic.wav'),audioPath.replace(/\.wav$/,'-sys.wav')];
 // Validate every target before deleting any member. Symbolic links never grant ownership.
 for(const path of paths){const stat=info(path);if(stat&&(stat.isSymbolicLink()||!stat.isFile()))throw Error('Cleanup refuses symbolic or non-file audio');if(realpathSync(dirname(path))!==realpathSync(root)&&!within(realpathSync(root),realpathSync(dirname(path))))throw Error('Audio escaped its managed root');}
 const walk=(path:string)=>{const stat=info(path);if(!stat)return;if(stat.isSymbolicLink())throw Error('Cleanup refuses symbolic staging paths');if(stat.isDirectory())for(const child of readdirSync(path))walk(resolve(path,child));else if(!stat.isFile())throw Error('Cleanup refuses non-file staging data');};
 if(realpathSync(dirname(workDirectory))!==realpathSync(stagingRoot))throw Error('Cleanup staging escaped its managed root');walk(workDirectory);
 return paths;
}
/** Caller holds the existing managed quota claim until deletion and its durable receipt succeed. */
export function discardOwnedMeetingAudio(options:OwnedMeetingAudio):void {
 const paths=ownedPaths(options);
 for(const path of paths)if(info(path))unlinkSync(path);
 if(info(options.workDirectory))rmSync(options.workDirectory,{recursive:true});
 for(const path of [...paths,options.workDirectory])if(info(path))throw Error('Temporary meeting audio cleanup is still pending');
 for(const directory of new Set([dirname(options.audioPath),options.stagingRoot])){const descriptor=openSync(directory,'r');try{fsyncSync(descriptor);}finally{closeSync(descriptor);}}
}
export interface MeetingAudioCleanupOptions extends OwnedMeetingAudio {sessionId:string;readSession:(id:string)=>Session|null|undefined;saveSession:(session:Session)=>Session;now?:()=>string}
/** Read the canonical saved meeting, never a provisional/checkpoint copy, before deleting audio. */
export function cleanupMeetingAudio(options:MeetingAudioCleanupOptions):Session {
 const current=options.readSession(options.sessionId);
 if(!current||current.id!==options.sessionId||!current.transcriptFinalized||current.meetingMode!=='transcript-only'||!current.audioCleanup)throw Error('Cleanup requires a durably saved finalized transcript-only meeting');
 if(current.audioCleanup.status==='completed')return current;
 if(current.audioCleanup.status!=='pending'||current.files?.wav!==options.audioPath)throw Error('Saved meeting audio cleanup intent changed');
 discardOwnedMeetingAudio(options);
 const next={...current,files:{...current.files,wav:''},audioArchived:false,audioUnavailableReason:'transcript-only' as const,audioCleanup:{...current.audioCleanup,status:'completed' as const,completedAt:options.now?.()??new Date().toISOString()}};
 const saved=options.saveSession(next);
 if(saved.audioCleanup?.status!=='completed'||saved.files?.wav)throw Error('Temporary meeting audio cleanup receipt was not durably saved');
 return saved;
}
