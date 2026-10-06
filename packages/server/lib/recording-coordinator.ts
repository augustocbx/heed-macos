import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Session, Segment } from "@heed/shared";
import type { CaptureMode, FinalCapture, RecordingSnapshot } from "../../shared/types/recording-coordinator";
import { atomicWriteJson } from "./atomic-json";
import { applySpeakerNames, reconcileSpeakerNames } from "../../shared/lib/speaker-names";

export interface RecordingAdapter {
  start(mode: CaptureMode, meetingId: string, attachPath: (path: string) => void): Promise<{ path: string; liveModel?: string }>;
  stop(onCaptureStopped: () => void): Promise<FinalCapture>;
  finalize(path: string): Promise<FinalCapture>;
  save(session: Partial<Session>): Session;
}
interface Receipt { signature: string; meetingId: string | null }
interface Manifest { version: 1; snapshot: RecordingSnapshot; receipts: Record<string, Receipt>; maintenanceOwner?:string }
const busy = new Set(["starting", "recording", "stopping", "finalizing"]);
const initial = (): RecordingSnapshot => ({meetingId:null,state:"idle",revision:0,startedAt:null,path:null,seconds:0,mode:"both",segments:[],speakerNames:{},session:null,error:null,maintenance:false});

/** Owns recording lifetime independently of HTTP clients and browser subscriptions. */
export class RecordingCoordinator {
  private value: RecordingSnapshot = initial();
  private receipts: Record<string, Receipt> = {};
  private operations = new Map<string, {signature:string; promise:Promise<RecordingSnapshot>}>();
  private startOperation?: Promise<RecordingSnapshot>;
  private stopOperation?: Promise<RecordingSnapshot>;
  private listeners = new Set<(snapshot: RecordingSnapshot) => void>();
  private livePersistedAt = 0;
  private maintenanceOwner:string|undefined;
  constructor(private options: {manifestPath: string; adapter: RecordingAdapter; now?: () => number; write?: typeof atomicWriteJson; maintenanceBlocked?:()=>boolean}) {
    mkdirSync(dirname(options.manifestPath),{recursive:true,mode:0o700});
    if (!existsSync(options.manifestPath)) return;
    const manifest = JSON.parse(readFileSync(options.manifestPath,"utf8")) as Manifest;
    if (manifest.version !== 1 || !manifest.snapshot || !["idle","starting","recording","stopping","finalizing","completed","failed"].includes(manifest.snapshot.state)
      || !Array.isArray(manifest.snapshot.segments) || !Number.isSafeInteger(manifest.snapshot.revision)
      || (manifest.snapshot.meetingId !== null && typeof manifest.snapshot.meetingId !== "string")) throw new Error("Invalid recording recovery manifest; preserve it for recovery");
    this.value = manifest.snapshot; this.receipts = manifest.receipts || {};
    // A maintenance guard is tied to a running server; after restart no lease remains.
    if (busy.has(this.value.state)) this.change({state:"failed",error:"Recording interrupted by backend restart. Retry finalization using the retained audio.",maintenance:false});
    else if (this.value.maintenance) this.change({maintenance:false});
  }
  private now() {return this.options.now?.() ?? Date.now();}
  snapshot(): RecordingSnapshot {
    const value=structuredClone(this.value);
    if (value.state === "recording" && value.startedAt !== null) value.seconds=Math.max(0,(this.now()-value.startedAt)/1000);
    return value;
  }
  private persist() { (this.options.write ?? atomicWriteJson)(this.options.manifestPath,{version:1,snapshot:this.value,receipts:this.receipts,maintenanceOwner:this.maintenanceOwner} satisfies Manifest); }
  private publish() { for (const listener of this.listeners) {try {listener(this.snapshot());} catch { /* A subscriber cannot interrupt capture or saving. */ }} }
  private change(patch: Partial<RecordingSnapshot>, receipt?: {id:string;signature:string}) {
    const previous=this.value,previousReceipts=this.receipts;this.value={...previous,...patch,revision:previous.revision+1};
    if(receipt)this.receipts=this.withReceipt(receipt.id,receipt.signature);
    try {this.persist();} catch(error) {this.value=previous;this.receipts=previousReceipts;throw error;}
    this.publish();
  }
  subscribe(listener: (snapshot: RecordingSnapshot) => void) {this.listeners.add(listener);listener(this.snapshot());return ()=>{this.listeners.delete(listener);};}
  private command(id:string,signature:string,run:()=>Promise<RecordingSnapshot>):Promise<RecordingSnapshot> {
    if (typeof id !== "string" || !id.trim() || id.length>128) return Promise.reject(new Error("Choose a valid command request ID"));
    const receipt=this.receipts[id];
    if(receipt && receipt.signature!==signature) return Promise.reject(new Error("Command request ID reused with different contents"));
    if(receipt && receipt.meetingId!==this.value.meetingId) return Promise.reject(new Error("Command belongs to an earlier meeting"));
    const running=this.operations.get(id);if(running){if(running.signature!==signature)return Promise.reject(new Error("Command request ID reused with different contents"));return running.promise;}
    const operation=Promise.resolve().then(run);
    this.operations.set(id,{signature,promise:operation});
    // Bound in-memory receipts; persisted receipts prevent old keys creating new capture.
    if(this.operations.size>128) this.operations.delete(this.operations.keys().next().value!);
    return operation;
  }
  private withReceipt(id:string,signature:string):Record<string,Receipt> {
    const receipts={...this.receipts,[id]:{signature,meetingId:this.value.meetingId}};
    const keys=Object.keys(receipts);for(const key of keys.slice(0,Math.max(0,keys.length-256)))delete receipts[key];
    return receipts;
  }
  private remember(id:string,signature:string) {
    const previous=this.receipts;this.receipts=this.withReceipt(id,signature);
    try{this.persist();}catch(error){this.receipts=previous;throw error;}
  }
  start(requestId:string,mode:CaptureMode="both"):Promise<RecordingSnapshot> {
    return this.command(requestId,`start:${mode}`,async()=>{
      if(!["both","mic","system"].includes(mode))throw new Error("Choose a supported capture mode");
      if(this.startOperation){this.remember(requestId,`start:${mode}`);return this.startOperation;}
      if(this.value.maintenance || this.options.maintenanceBlocked?.())throw new Error("Recording is unavailable during maintenance");
      if(this.value.state === "recording" || this.value.state === "starting"){this.remember(requestId,`start:${mode}`);return this.snapshot();}
      if(this.value.state === "failed" && this.value.path && !this.value.session)throw new Error("Recover the interrupted meeting before starting another recording");
      if(this.value.state === "stopping" || this.value.state === "finalizing")throw new Error("Wait for the active meeting to finish");
      if(this.receipts[requestId])return this.snapshot();
      this.change({...initial(),meetingId:randomUUID(),mode,revision:this.value.revision,startedAt:this.now(),state:"starting"},{id:requestId,signature:`start:${mode}`});
      this.startOperation=(async()=>{
        try {
          const result=await this.options.adapter.start(mode,this.value.meetingId!,path=>this.change({path}));
          if(this.value.state!=="starting")throw new Error(this.value.error || "Capture stopped during startup");
          if(!result.path)throw new Error("Capture did not create an audio writer");
          this.change({state:"recording",path:result.path,liveModel:result.liveModel,startedAt:this.now(),error:null});
          return this.snapshot();
        } catch(error) {
          if(this.value.path && !existsSync(this.value.path))this.change({path:null});
          this.fail(error);throw error;
        }
        finally {this.startOperation=undefined;}
      })();
      return this.startOperation;
    });
  }
  private target(meetingId:string) {if(!meetingId || meetingId!==this.value.meetingId)throw new Error("The active meeting changed; reload before issuing this command");}
  stop(requestId:string,meetingId:string):Promise<RecordingSnapshot> {
    return this.command(requestId,`stop:${meetingId}`,async()=>{
      this.target(meetingId);
      if(this.stopOperation){this.remember(requestId,`stop:${meetingId}`);return this.stopOperation;}
      if(this.value.state === "completed")return this.snapshot();
      if(this.value.state!=="recording")throw new Error("The meeting is not recording; retry recovery if needed");
      this.change({state:"stopping",seconds:this.snapshot().seconds},{id:requestId,signature:`stop:${meetingId}`});
      this.stopOperation=(async()=>{
        try {
          const result=await this.options.adapter.stop(()=>this.change({state:"finalizing"}));
          this.checkpoint(result);return this.saveFinal();
        }catch(error){this.fail(error);throw error;}
        finally{this.stopOperation=undefined;}
      })();return this.stopOperation;
    });
  }
  retry(requestId:string,meetingId:string):Promise<RecordingSnapshot> {
    return this.command(requestId,`retry:${meetingId}`,async()=>{
      this.target(meetingId);if(this.stopOperation){this.remember(requestId,`retry:${meetingId}`);return this.stopOperation;}
      if(this.value.state==="completed")return this.snapshot();
      if(this.value.state!=="failed" || !this.value.path)throw new Error("No retained recording is available for recovery");
      this.change({state:"finalizing",error:null},{id:requestId,signature:`retry:${meetingId}`});
      this.stopOperation=(async()=>{
        try {if(!this.value.finalCapture)this.checkpoint(await this.options.adapter.finalize(this.value.path!));return this.saveFinal();}
        catch(error){this.fail(error);throw error;}finally{this.stopOperation=undefined;}
      })();return this.stopOperation;
    });
  }
  abandon(requestId:string,meetingId:string):Promise<RecordingSnapshot> {
    const signature=`abandon:${meetingId}`;
    return this.command(requestId,signature,async()=>{
      if(this.receipts[requestId])return this.snapshot();
      this.target(meetingId);
      if(this.value.state!=="failed")throw new Error("Only a failed recording can be left for manual recovery");
      if(this.startOperation || this.stopOperation)throw new Error("Wait for failed recording cleanup before leaving it for recovery");
      if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(meetingId))throw new Error("Invalid recording recovery meeting ID");
      // Keep the failed checkpoint and names available for later manual recovery.
      const directory=join(dirname(this.options.manifestPath),"recording-recovery");
      mkdirSync(directory,{recursive:true,mode:0o700});
      (this.options.write ?? atomicWriteJson)(join(directory,`${meetingId}.json`),{version:1,snapshot:this.snapshot()});
      this.change({...initial(),maintenance:this.value.maintenance},{id:requestId,signature});
      return this.snapshot();
    });
  }
  private checkpoint(result:FinalCapture) {
    if(!result || !["en","pt"].includes(result.language) || !result.model || !Array.isArray(result.turns)
      || !Number.isFinite(result.duration) || result.duration<0 || result.path!==this.value.path)throw new Error("Final transcription did not return an authoritative recording result");
    const names=reconcileSpeakerNames(this.value.segments,result.turns,this.value.speakerNames);
    this.change({state:"finalizing",finalCapture:structuredClone({...result,liveModel:result.liveModel || this.value.liveModel}),speakerNames:names,seconds:result.duration});
  }
  private saveFinal():RecordingSnapshot {
    const result=this.value.finalCapture!;
    const fields=applySpeakerNames(result.turns,[...new Set(result.turns.map(s=>s.speaker))],result.embeddings || {},this.value.speakerNames);
    const transcript=fields.segments.map(s=>s.text).join("\n");const words=transcript.split(/\s+/).filter(Boolean);
    const session=this.options.adapter.save({id:this.value.meetingId!,title:words.length ? words.slice(0,8).join(" ")+(words.length>8?"...":"") : "Recording without detected speech",
      createdAt:new Date(this.value.startedAt || this.now()).toISOString(),duration:result.duration,language:result.language,transcriptionModel:result.model,liveModel:result.liveModel,
      transcript,...fields,transcriptFinalized:true,files:{wav:result.path,srt:"",txt:""},aiNotes:"",summary:"",tags:[],pinned:false});
    if(!session?.id || !session.transcriptFinalized)throw new Error("Final recording persistence did not confirm a saved meeting");
    this.change({state:"completed",session,segments:session.segments,seconds:result.duration,error:null});return this.snapshot();
  }
  private fail(error:unknown) {this.change({state:"failed",error:error instanceof Error ? error.message : String(error)});}
  captureFailed(message:string) {if(this.value.state==="recording" || this.value.state==="starting")this.fail(new Error(message));}
  setMaintenance(acquire:boolean,owner="legacy") {
    if(typeof owner!=="string" || !owner.trim() || owner.length>128)throw new Error("Choose a valid maintenance owner");
    if(this.value.maintenance && this.maintenanceOwner!==owner)throw new Error("The maintenance guard belongs to another owner");
    if(acquire && busy.has(this.value.state))throw new Error("An active meeting must finish before maintenance");
    const previous=this.maintenanceOwner;this.maintenanceOwner=acquire?owner:undefined;
    try{this.change({maintenance:acquire});}catch(error){this.maintenanceOwner=previous;throw error;}
    return this.snapshot();
  }
  rename(meetingId:string,expectedRevision:number,names:Record<string,string>) {
    this.target(meetingId);if(expectedRevision!==this.value.revision)throw new Error("Recording changed; reload before changing speaker names");
    if(!["recording","stopping","finalizing","failed"].includes(this.value.state))throw new Error("Edit saved speaker names in the meeting");
    if(!names || typeof names!=="object" || Array.isArray(names) || Object.entries(names).some(([key,value])=>!key || key.length>200 || typeof value!=="string" || !value.trim() || value.length>200))throw new Error("Choose valid speaker names");
    this.change({speakerNames:{...this.value.speakerNames,...names}});return this.snapshot();
  }
  live(event:string,data:unknown) {
    if(this.value.state!=="recording" && this.value.state!=="starting")return;
    if(!["segment","live","turn"].includes(event))return;
    const segment=data as Segment;if(!segment || typeof segment.text!=="string" || typeof segment.speaker!=="string")return;
    let segments=this.value.segments.slice();
    if(event==="turn") {const index=segments.findIndex(s=>s.id===segment.id);if(index>=0)segments[index]={...segments[index],...segment};else segments.push(segment);}
    else if(event==="live") {segments=segments.filter(s=>(s.channel || "mic")!==(segment.channel || "mic"));if(segment.text.trim())segments.push(segment);}
    else segments.push(segment);
    this.value={...this.value,segments:segments.slice(-10000),revision:this.value.revision+1};
    // Periodic provisional checkpoints avoid an fsync for every live token.
    if(this.now()-this.livePersistedAt>=1000){this.persist();this.livePersistedAt=this.now();}
    this.publish();
  }
}
