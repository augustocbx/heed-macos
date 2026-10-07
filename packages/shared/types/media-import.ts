import type {Session} from './session';
export type MediaImportPhase='copy'|'normalization'|'transcription'|'diarization'|'saving';
export type MediaImportState='queued'|'running'|'cancelling'|'failed'|'cancelled'|'completed';
export interface MediaImportConfig {model:'parakeet-v3'|'base'|'small'|'medium'|'large-v3';language:'auto'|'en'|'pt';meetingMode:'audio-transcript'|'transcript-only'}
export interface MediaImportJob {id:string;filename:string;size:number;config:MediaImportConfig;state:MediaImportState;phase:MediaImportPhase;createdAt:string;updatedAt:string;error?:string;sessionId?:string;workerUnconfirmed?:boolean}
export interface MediaImportSnapshot {jobs:MediaImportJob[];busy:boolean;maxFileBytes:number;availableBytes:number}
export interface MediaImportCompletion {job:MediaImportJob;session?:Session}
