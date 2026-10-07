import type {MediaImportConfig,MediaImportPhase} from '../../shared/types/media-import';
import {finalRecordingResult,recordingFinalizationOptions} from './final-recording';
import {TRANSCRIPTION_SERVER,TRANSCRIPTION_HTTP_TIMEOUT_MS} from './transcription-client';
/** One authoritative pipeline, with real phase callbacks. Cancellation is owned by the job controller. */
export async function transcribeImport(wav:string,work:string,config:MediaImportConfig,onPhase:(phase:MediaImportPhase)=>void,vocabulary?:unknown){
 let terminal=false;
 try {
 const response=await fetch(`${TRANSCRIPTION_SERVER}/finalize-import`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({job_id:wav.split("/").at(-1)!.replace(/^import-/,"").replace(/\.wav$/, ""),wav_path:wav,work_directory:work,dual:false,...recordingFinalizationOptions(config.language,config.model),...(vocabulary?{vocabulary}:{})}),signal:AbortSignal.timeout(TRANSCRIPTION_HTTP_TIMEOUT_MS.finalize)});
 if(!response.ok||!response.body)throw Error('The transcription service is unavailable. Start it and retry this import.');
 const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='',event='',final:any;
 try{while(true){const next=await reader.read();if(next.done)break;buffer+=decoder.decode(next.value,{stream:true});if(buffer.length>16_000_000)throw Error('The import transcript exceeds the supported response limit.');const lines=buffer.split('\n');buffer=lines.pop()||'';for(const line of lines){if(line.startsWith('event:'))event=line.slice(6).trim();else if(line.startsWith('data:')){const value=JSON.parse(line.slice(5));if(event==='phase'&&['transcription','diarization'].includes(value.phase))onPhase(value.phase);else if(event==='result'){terminal=true;final=value;}else if(event==='error'){terminal=true;throw Object.assign(Error(value.message||'Final import transcription failed.'),value.workerUnconfirmed?{workerStillRunning:true}:{workerConfirmed:true});}}}}}
 finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
 if(!terminal)throw Error('Import connection closed before worker completion.');
 return finalRecordingResult(final,wav);
 }catch(error){if(!terminal)throw Object.assign(Error('The import worker connection was interrupted. Retry to recover its protected audio.'),{workerStillRunning:true});throw error;}
}
