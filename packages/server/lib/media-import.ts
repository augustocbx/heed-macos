import {createHash} from 'node:crypto';
import {existsSync,lstatSync,mkdirSync,readdirSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import type {Session,TranscribeResult} from '../../shared/types';
import type {MediaImportConfig,MediaImportJob,MediaImportPhase} from '../../shared/types/media-import';
import {atomicWriteJson} from './atomic-json';
import type {ManagedQuota} from './managed-quota';
import {reserveMediaWork} from './media-budget';
import {discardOwnedMeetingAudio} from './meeting-audio-cleanup';

export const MAX_IMPORT_FILE_BYTES=256_000_000;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
interface RecordJob extends MediaImportJob {fingerprint:string;sourceName:string;maxSourceBytes:number;reservedBytes:number;result?:TranscribeResult;workerUnconfirmed?:boolean;cancelRequested?:boolean;normalized?:boolean;vocabulary?:unknown}
interface Options {
 jobsDirectory:string;recordingsDirectory:string;stagingDirectory:string;quota:ManagedQuota;
 isBusy:()=>boolean;vocabularySnapshot?:()=>unknown;validateVocabularySnapshot?:(value:unknown)=>unknown;
 probe:(source:string,maxBytes:number)=>Promise<{duration:number;normalizedBytes:number}>;
 normalize:(source:string,wav:string,maxBytes:number,signal:AbortSignal)=>Promise<void>;
 transcribe:(wav:string,work:string,config:MediaImportConfig,onPhase:(phase:MediaImportPhase)=>void,vocabulary?:unknown)=>Promise<TranscribeResult>;
 save:(session:Session)=>Session;readSession:(id:string)=>Session|null|undefined;cleanup:(session:Session,wav:string,work:string)=>Session;
}
function validateConfig(value:MediaImportConfig){if(!value||!['parakeet-v3','base','small','medium','large-v3'].includes(value.model)||!['auto','en','pt'].includes(value.language)||!['audio-transcript','transcript-only'].includes(value.meetingMode))throw Error('Choose a supported model, meeting language and storage mode.');}
function validateResult(result:TranscribeResult){
 if(!result||result.success!==true||result.finalized!==true||!Number.isFinite(result.duration)||result.duration!<=0||!['en','pt'].includes(result.metadata?.language)||typeof result.metadata?.model!=='string'||!result.metadata.model||typeof result.text!=='string'||!Array.isArray(result.segments)||!Array.isArray(result.speakers)||result.speakers.some(speaker=>typeof speaker!=='string'||!speaker.trim())||result.segments.some(segment=>!segment||typeof segment.text!=='string'||!result.speakers.includes(segment.speaker)||!Number.isFinite(segment.start)||!Number.isFinite(segment.end)||segment.start<0||segment.end<segment.start||segment.end>result.duration!)||(result.segments.length>0&&result.text!==result.segments.map(segment=>segment.text).join('\n'))||Buffer.byteLength(JSON.stringify(result))>8_000_000)throw Error('The final import transcript did not complete. Retry the protected recording.');
}
/** One authoritative, durable import owns only managed copies. Browser connections never own work. */
export class MediaImportController {
 private jobs=new Map<string,RecordJob>();private active?:string;private abort?:AbortController;private admitting=false;private upload?:{id:string;token:object;claim:ReturnType<typeof reserveMediaWork>};
 constructor(private options:Options){
  mkdirSync(options.jobsDirectory,{recursive:true,mode:0o700});
  const names=readdirSync(options.jobsDirectory).filter(name=>name.endsWith('.json'));if(names.length>128)throw Error('Import recovery needs attention; preserve the import journal.');
  for(const name of names){const id=name.slice(0,-5);if(!UUID.test(id))throw Error('Invalid import recovery journal; preserve it.');const path=this.path(id);if(lstatSync(path).isSymbolicLink()||lstatSync(path).size>16_000_000)throw Error('Invalid import recovery journal; preserve it.');const job=JSON.parse(readFileSync(path,'utf8')) as RecordJob;validateConfig(job.config);if(job.id!==id||typeof job.filename!=='string'||!Number.isSafeInteger(job.size)||job.size<=0||job.size>MAX_IMPORT_FILE_BYTES||!/^source\.[a-z0-9]{1,12}$/.test(job.sourceName)||!Number.isSafeInteger(job.maxSourceBytes)||job.maxSourceBytes<64_000||!Number.isSafeInteger(job.reservedBytes)||job.reservedBytes!==job.maxSourceBytes*4||typeof job.fingerprint!=='string'||!/^[a-f0-9]{64}$/.test(job.fingerprint)||!['queued','running','cancelling','failed','cancelled','completed'].includes(job.state))throw Error('Invalid import recovery journal; preserve it.');
   if(job.vocabulary!==undefined){if(!options.validateVocabularySnapshot)throw Error("Vocabulary recovery validation is unavailable. Preserve the import journal.");job.vocabulary=options.validateVocabularySnapshot(job.vocabulary);}
   this.jobs.set(id,job);
   if(['queued','running','cancelling'].includes(job.state)){if(['transcription','diarization'].includes(job.phase)&&!job.result)job.workerUnconfirmed=true;if(job.state==='cancelling')job.cancelRequested=true;job.state='failed';job.error='Import interrupted by a restart. Retry or discard its protected working copies.';this.persist(job);}
   if(['completed','cancelled'].includes(job.state))options.quota.release(this.claimId(id));
   if(job.state==='failed'&&!options.quota.allocation(this.claimId(id)))options.quota.reserve(this.claimId(id),job.reservedBytes,this.claimPaths(id));
  }
 }
 private path(id:string){return join(this.options.jobsDirectory,`${id}.json`);}
 private wav(id:string){return join(this.options.recordingsDirectory,`import-${id}.wav`);}
 private work(id:string){return join(this.options.stagingDirectory,`media-import-${id}`);}
 private source(job:RecordJob){return join(this.work(job.id),job.sourceName);}
 private claimId(id:string){return `media-import-${id}`;}
 private claimPaths(id:string){const wav=this.wav(id);return [wav,this.work(id),wav.replace(/\.wav$/,'-mic.wav'),wav.replace(/\.wav$/,'-sys.wav')];}
 private persist(job:RecordJob){job.updatedAt=new Date().toISOString();atomicWriteJson(this.path(job.id),job);}
 private require(id:string){if(!UUID.test(id)||!this.jobs.has(id))throw Error('Import job not found.');return this.jobs.get(id)!;}
 private public(job:RecordJob):MediaImportJob {const {fingerprint,sourceName,maxSourceBytes,reservedBytes,result,cancelRequested,normalized,vocabulary,...visible}=job;return structuredClone(visible);}
 get busy(){return !!this.active||this.admitting||!!this.upload||[...this.jobs.values()].some(job=>job.workerUnconfirmed);}
 beginUpload(id:string,size:number){
  if(!UUID.test(id)||!Number.isSafeInteger(size)||size<=0||size>MAX_IMPORT_FILE_BYTES)throw Error('Choose a nonempty media file smaller than 256 MB.');
  if(this.busy||this.options.isBusy())throw Error('Wait for the current recording or transcription to finish.');
  const token={};const claim=reserveMediaWork(this.options.quota,id,this.wav(id),join(this.options.stagingDirectory,`media-${id}`),size);
  this.upload={id,token,claim};let released=false;return {token,release:()=>{if(released)return;released=true;claim.release();if(this.upload?.token===token)this.upload=undefined;}};
 }
 get(id:string){return this.public(this.require(id));}
 list(){return [...this.jobs.values()].map(job=>this.public(job)).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));}
 snapshot(){return {jobs:this.list(),busy:this.busy,maxFileBytes:Math.min(MAX_IMPORT_FILE_BYTES,Math.max(0,Math.floor((this.options.quota.snapshot().availableBytes-16_000_000)/4))),availableBytes:this.options.quota.snapshot().availableBytes};}
 protectedPaths(){return [...this.jobs.values()].filter(job=>!['completed','cancelled'].includes(job.state)).flatMap(job=>this.claimPaths(job.id));}
 async submit(requestId:string,file:File,config:MediaImportConfig,uploadToken?:object){
  if(!UUID.test(requestId))throw Error('Choose a valid import submission identity.');validateConfig(config);
  if(!(file instanceof File)||file.size<=0||file.size>MAX_IMPORT_FILE_BYTES)throw Error('Choose a nonempty media file smaller than 256 MB.');
  // Duplicate receipts remain usable while audio is busy; admission is checked again before copying.
  const existingReceipt=this.jobs.get(requestId);let vocabulary=existingReceipt?existingReceipt.vocabulary:structuredClone(this.options.vocabularySnapshot?.());if(vocabulary!==undefined){if(!this.options.validateVocabularySnapshot)throw Error("Vocabulary import validation is unavailable.");vocabulary=this.options.validateVocabularySnapshot(vocabulary);}
  const bytes=Buffer.from(await file.arrayBuffer());const fingerprint=createHash('sha256').update(bytes).update(JSON.stringify({config,vocabulary})).digest('hex');
  const receipt=this.jobs.get(requestId);if(receipt){if(receipt.fingerprint!==fingerprint)throw Error('This import submission changed. Choose the file again.');return this.public(receipt);}
  const duplicate=[...this.jobs.values()].find(job=>job.fingerprint===fingerprint&&job.state!=='cancelled');if(duplicate)return this.public(duplicate);
  if((this.busy&&!(this.upload&&this.upload.token===uploadToken))||(!(this.upload&&this.upload.token===uploadToken)&&this.options.isBusy()))throw Error('Wait for the current recording or transcription to finish.');
  if(this.upload&&this.upload.id!==requestId)throw Error('The upload identity changed. Choose the file again.');
  if(this.jobs.size>=128)throw Error('The import history is full. Preserve the library and contact support before importing more files.');
  this.admitting=true;
  let job:RecordJob|undefined;
  try{
   this.upload?.claim.release();
   const claim=reserveMediaWork(this.options.quota,`import-${requestId}`,this.wav(requestId),this.work(requestId),file.size);
   const now=new Date().toISOString();const extension=file.name.split('.').pop()?.toLowerCase();job={id:requestId,filename:file.name.slice(0,255),size:file.size,config:{...config},state:'queued',phase:'copy',createdAt:now,updatedAt:now,fingerprint,sourceName:`source.${extension&&/^[a-z0-9]{1,12}$/.test(extension)?extension:'bin'}`,maxSourceBytes:claim.maxSourceBytes,reservedBytes:claim.reservedBytes,...(vocabulary!==undefined?{vocabulary}: {})};
   this.jobs.set(requestId,job);this.persist(job);mkdirSync(this.work(requestId),{recursive:true,mode:0o700});
   await Bun.write(this.source(job),bytes);this.persist(job);
   this.active=job.id;void this.run(job);return this.public(job);
  }catch(error){if(job){job.state='failed';job.error='Could not copy the recording. Retry or discard its protected working copies.';try{this.persist(job);}catch{}}else this.options.quota.release(this.claimId(requestId));throw error;}
  finally{this.admitting=false;}
 }
 private phase(job:RecordJob,phase:MediaImportPhase){job.phase=phase;this.persist(job);}
 private cancelled(job:RecordJob){if(job.state==='cancelling'||job.cancelRequested){job.state='cancelling';throw Error('Import cancelled.');}}
 private remove(job:RecordJob){discardOwnedMeetingAudio({audioPath:this.wav(job.id),workDirectory:this.work(job.id),recordingsRoots:[this.options.recordingsDirectory],stagingRoot:this.options.stagingDirectory});}
 private complete(job:RecordJob,session:Session){
  if(job.config.meetingMode==='transcript-only')this.options.cleanup(session,this.wav(job.id),this.work(job.id));else rmSync(this.work(job.id),{recursive:true,force:true});
  job.state='completed';delete job.error;this.persist(job);this.options.quota.release(this.claimId(job.id));
  // Prune recognition only after the terminal receipt is durable; a failed prune leaves recovery evidence.
  const result=job.result;delete job.result;try{this.persist(job);}catch{job.result=result;}
 }
 private async run(job:RecordJob){
  this.abort=new AbortController();
  try{
   job.state='running';delete job.error;this.persist(job);
   const saved=this.options.readSession(`import-${job.id}`);
   if(saved?.transcriptFinalized){job.sessionId=saved.id;this.phase(job,'saving');this.complete(job,saved);return;}
   if(job.workerUnconfirmed){this.phase(job,'transcription');job.result=await this.options.transcribe(this.wav(job.id),this.work(job.id),job.config,phase=>this.phase(job,phase),job.vocabulary);delete job.workerUnconfirmed;}
   this.cancelled(job);
   if(!job.result){this.phase(job,'normalization');const probe=await this.options.probe(this.source(job),job.maxSourceBytes);this.cancelled(job);if(!Number.isFinite(probe.duration)||probe.duration<=0||probe.normalizedBytes>job.maxSourceBytes)throw Error('The decoded audio exceeds the available meeting storage. Increase the storage limit or choose a shorter recording.');if(!job.normalized||!existsSync(this.wav(job.id)))await this.options.normalize(this.source(job),this.wav(job.id),job.maxSourceBytes,this.abort.signal);this.cancelled(job);const normalized=await this.options.probe(this.wav(job.id),job.maxSourceBytes);if(Math.abs(normalized.duration-probe.duration)>Math.max(.1,probe.duration*.001))throw Error("The normalized audio timeline changed. Repair the original recording and try again.");job.normalized=true;this.persist(job);this.cancelled(job);this.phase(job,'transcription');job.result=await this.options.transcribe(this.wav(job.id),this.work(job.id),job.config,phase=>this.phase(job,phase),job.vocabulary);this.cancelled(job);validateResult(job.result);this.persist(job);}
   this.cancelled(job);this.phase(job,'saving');validateResult(job.result!);const result=job.result!;const sessionId=`import-${job.id}`;
   let session=this.options.readSession(sessionId)??this.options.save({id:sessionId,title:job.filename,createdAt:job.createdAt,duration:result.duration!,language:result.metadata.language,transcriptionModel:result.metadata.model,transcript:result.text,speakers:result.speakers,segments:result.segments,embeddings:result.embeddings,aiNotes:'',summary:'',tags:[],pinned:false,transcriptFinalized:true,transcriptionDiagnostics:result.transcriptionDiagnostics,...((result.metadata as unknown as {vocabularyRun?:unknown}).vocabularyRun?{vocabularyRun:(result.metadata as unknown as {vocabularyRun:unknown}).vocabularyRun}:{}),files:{wav:this.wav(job.id)},meetingMode:job.config.meetingMode,...(job.config.meetingMode==='transcript-only'?{audioCleanup:{status:'pending' as const,requestedAt:new Date().toISOString()}}:{})});
   job.sessionId=session.id;this.persist(job);
   this.complete(job,session);
  }catch(error){if((error as {workerConfirmed?:boolean}).workerConfirmed){delete job.workerUnconfirmed;if(job.cancelRequested)job.state='cancelling';}if((error as {workerStillRunning?:boolean}).workerStillRunning)job.workerUnconfirmed=true;if(job.state==='cancelling'&&!job.sessionId&&!job.workerUnconfirmed){try{this.remove(job);job.state='cancelled';delete job.result;delete job.error;this.persist(job);this.options.quota.release(this.claimId(job.id));}catch{job.state='failed';job.error='Cancelled import cleanup is pending. Retry discard before importing again.';try{this.persist(job);}catch{/* Keep the failed owner and claim when its recovery disk is unavailable. */}}}
   else {job.state='failed';job.error=(error as Error).message?.slice(0,400)||'Import failed. Retry or discard the protected recording.';try{this.persist(job);}catch{/* The existing durable journal and protected claim remain recovery evidence. */}}}
  finally{this.active=undefined;this.abort=undefined;}
 }
 cancel(id:string){const job=this.require(id);if(['completed','cancelled'].includes(job.state))return this.public(job);if(job.sessionId)throw Error('The meeting is already saved. Retry its pending cleanup.');if(this.active!==id)return this.discard(id);job.state='cancelling';job.cancelRequested=true;this.persist(job);atomicWriteJson(join(this.work(job.id),'import-cancelled.json'),{cancelled:true});if(job.phase==='normalization')this.abort?.abort();return this.public(job);}
 retry(id:string){const job=this.require(id);if(job.state!=='failed')throw Error('Only a failed import can be retried.');if(this.active||this.admitting||this.upload||[...this.jobs.values()].some(other=>other.id!==id&&other.workerUnconfirmed)||this.options.isBusy())throw Error('Wait for the current recording or transcription to finish.');if(!job.result&&!this.options.readSession(`import-${id}`)?.transcriptFinalized&&!existsSync(this.source(job)))throw Error('The copied source is missing. Discard this job and select the original file again.');this.active=id;void this.run(job);return this.public(job);}
 discard(id:string){const job=this.require(id);if(job.workerUnconfirmed)throw Error('The worker may still be using this audio. Retry to confirm it has finished before discarding.');if(this.active===id)throw Error('Cancel the active import and wait for its worker to finish.');if(job.sessionId||this.options.readSession(`import-${id}`))throw Error('This import has a saved meeting. Retry cleanup or delete the meeting through the library.');this.remove(job);job.state='cancelled';delete job.result;delete job.error;this.persist(job);this.options.quota.release(this.claimId(id));return this.public(job);}
}
