import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Session } from "@heed/shared";
import { atomicWriteJson } from "./atomic-json";
import { RecordingCoordinator, type RecordingAdapter } from "./recording-coordinator";
import { AutomaticNotesService } from "./automatic-notes";
import { transcriptGuard } from "./session-tags";

const directories: string[] = [];
const finalDiagnostics = () => {
 const channel={rawRms:0.04,rawPeak:0.8,cleanedRms:0.03,asrSegments:3,diarizationSegments:1,usableEmbeddings:1,retainedSegments:2,discardedSegments:1,discardReasons:{"echo-text-and-time":1},fallbackSegments:1,diarizationFailed:false};
 return {version:1 as const,channels:{mic:{...channel},sys:{...channel}},aecApplied:true,warnings:["microphone-attribution-fallback" as const]};
};
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function setup(overrides: Partial<RecordingAdapter> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "heed-coordinator-")); directories.push(directory);
  const manifestPath = join(directory, "manifest.json");
  const capture = { path: join(directory,"capture.wav"),duration:17,language:"pt" as const,model:"final",turns:[{speaker:"Speaker 1",text:"Vamos entregar sexta.",start:2,end:6,channel:"sys" as const}] };
  const saved: Partial<Session>[] = [];
  const adapter: RecordingAdapter = {
    start: async (_mode,_id,attach) => { attach(capture.path);return {path:capture.path}; },
    stop: async stopped => {stopped();return capture;},
    finalize: async () => capture,
    save: session => {saved.push(session);return {...session,id:session.id || "saved"} as Session;},
    ...overrides,
  };
  return {coordinator:new RecordingCoordinator({manifestPath,adapter}),adapter,manifestPath,capture,saved};
}
describe("backend recording lifecycle", () => {
  test("recovery after a completed-manifest fault returns an already corrected atomic session", async () => {
    const directory = mkdtempSync(join(tmpdir(), "heed-coordinator-source-")); directories.push(directory);
    const notes = new AutomaticNotesService({ sessionsDir: join(directory, "sessions"), getSettings: () => ({ enabled: false, templateId: "meeting", model: null, language: "meeting" }), loadTemplate: () => undefined, generate: async () => "", isBusy: () => false });
    const base = setup({ save: session => notes.create(session) }); let failed = false;
    const coordinator = new RecordingCoordinator({ manifestPath: base.manifestPath, adapter: base.adapter, write(path, value) {
      if ((value as any).snapshot.state === "completed" && !failed) { failed = true; throw Error("Synthetic completed-manifest fault"); }
      atomicWriteJson(path, value);
    } });
    const active = await coordinator.start("source-start", "both");
    await expect(coordinator.stop("source-stop", active.meetingId!)).rejects.toThrow("Synthetic completed-manifest fault");
    const saved = notes.get(active.meetingId!)!; expect(saved.transcriptVersion).toBe(1);
    const corrected = notes.commitTranscript(saved.id, { ...transcriptGuard(saved), requestId: "correction", action: "edit", target: { kind: "segment", index: 0 }, text: "Vamos entregar na sexta-feira." });
    const recovered = new RecordingCoordinator({ manifestPath: base.manifestPath, adapter: base.adapter });
    const completed = await recovered.retry("recover-source", active.meetingId!);
    expect(completed.session).toEqual(corrected); expect(completed.session?.transcriptVersion).toBe(2); expect(notes.list()).toHaveLength(1);
  });
  test("diagnostics and fallback attribution survive checkpoint recovery without losing manual names",async()=>{
    let fail=true;let finalizations=0;
    const base=setup({save:s=>{if(fail)throw new Error("disk full");return {...s,id:s.id!} as Session;},finalize:async()=>{finalizations++;return base.capture;}});
    const diagnostics=finalDiagnostics();
    Object.assign(base.capture,{transcriptionDiagnostics:diagnostics});
    Object.assign(base.capture.turns[0],{attribution:"fallback"});
    const active=await base.coordinator.start("diagnostic-start");
    base.coordinator.live("turn",{id:1,speaker:"Speaker 1",text:"Preview",start:2,end:6,channel:"sys"});
    base.coordinator.rename(active.meetingId!,base.coordinator.snapshot().revision,{"Speaker 1":"Ana"});
    await expect(base.coordinator.stop("diagnostic-stop",active.meetingId!)).rejects.toThrow("disk full");
    expect(JSON.parse(readFileSync(base.manifestPath,"utf8")).snapshot.finalCapture.transcriptionDiagnostics).toEqual(diagnostics);
    fail=false;const recovered=new RecordingCoordinator({manifestPath:base.manifestPath,adapter:base.adapter});
    const completed=await recovered.retry("diagnostic-retry",active.meetingId!);
    expect(finalizations).toBe(0);expect(completed.session!.transcriptionDiagnostics).toEqual(diagnostics);
    expect(completed.session!.segments[0]).toMatchObject({speaker:"Ana",auto:false,attribution:"fallback"});
    expect(JSON.parse(readFileSync(base.manifestPath,"utf8")).snapshot.session.transcriptionDiagnostics).toEqual(diagnostics);
  });
  test("recording checkpoint excludes unrecognized diagnostic contents",async()=>{
    const base=setup();const diagnostics=finalDiagnostics();
    Object.assign(base.capture,{transcriptionDiagnostics:{...diagnostics,workerError:"private error",channels:{...diagnostics.channels,mic:{...diagnostics.channels.mic,transcript:"private transcript"}}}});
    const active=await base.coordinator.start("safe-start");const completed=await base.coordinator.stop("safe-stop",active.meetingId!);
    expect(completed.session!.transcriptionDiagnostics).toEqual(diagnostics);
    expect(JSON.stringify(JSON.parse(readFileSync(base.manifestPath,"utf8")).snapshot.finalCapture.transcriptionDiagnostics)).not.toContain("private");
  });
  test("invalid diagnostics are omitted from the recording checkpoint and saved meeting",async()=>{
    const base=setup();Object.assign(base.capture,{transcriptionDiagnostics:{version:2,workerError:"private error"}});
    const active=await base.coordinator.start("invalid-start");const completed=await base.coordinator.stop("invalid-stop",active.meetingId!);
    expect(completed.session).not.toHaveProperty("transcriptionDiagnostics");
    expect(JSON.parse(readFileSync(base.manifestPath,"utf8")).snapshot.finalCapture).not.toHaveProperty("transcriptionDiagnostics");
  });
  test("preview model provenance survives restart and recovery",async()=>{
    const base=setup({start:async (_m,_id,attach)=>{attach(base.capture.path);return {path:base.capture.path,liveModel:"preview-v3"};}});
    const active=await base.coordinator.start("start","both");
    const recovered=new RecordingCoordinator({manifestPath:base.manifestPath,adapter:base.adapter});
    const done=await recovered.retry("retry",active.meetingId!);
    expect(done.session!.liveModel).toBe("preview-v3");
  });
  test("startup helper failure cannot be overwritten by a later writer readiness response",async()=>{
    const base=setup({start:async(_m,_id,attach)=>{attach(base.capture.path);base.coordinator.captureFailed("helper exited");return {path:base.capture.path};}});
    await expect(base.coordinator.start("start","both")).rejects.toThrow("helper exited");
    expect(base.coordinator.snapshot().state).toBe("failed");
  });
  test("denied start without an audio file can be retried after permission is granted",async()=>{
    let deny=true;const base=setup({start:async (_m,_id,attach)=>{attach(base.capture.path);if(deny)throw new Error("permission denied");return {path:base.capture.path};}});
    await expect(base.coordinator.start("denied","both")).rejects.toThrow("permission denied");
    deny=false;expect((await base.coordinator.start("granted","both")).state).toBe("recording");
  });
  test("saves a finalized meeting without any browser subscriber", async () => {
    const {coordinator,saved,manifestPath}=setup();
    const active=await coordinator.start("start-1","both");
    const completed=await coordinator.stop("stop-1",active.meetingId!);
    expect(completed.state).toBe("completed");expect(completed.seconds).toBe(17);
    expect(saved).toHaveLength(1);expect(saved[0].transcriptFinalized).toBe(true);
    expect(saved[0].transcript).toBe("Vamos entregar sexta.");
    expect(saved[0]).not.toHaveProperty("transcriptionDiagnostics");
    expect(JSON.parse(readFileSync(manifestPath,"utf8")).snapshot.session.id).toBe(completed.session!.id);
  });
  test("concurrent starts cannot create duplicate capture and duplicate stops save once", async () => {
    let starts=0; const {coordinator,capture,saved}=setup({start:async (_m,_id,attach)=>{starts++;attach(capture.path);await Promise.resolve();return {path:capture.path};}});
    const [a,b]=await Promise.all([coordinator.start("start-a","both"),coordinator.start("start-b","both")]);
    expect(a.meetingId).toBe(b.meetingId);expect(starts).toBe(1);
    const [x,y]=await Promise.all([coordinator.stop("stop-a",a.meetingId!),coordinator.stop("stop-b",a.meetingId!)]);
    expect(x.session!.id).toBe(y.session!.id);expect(saved).toHaveLength(1);
  });
  test("coalesced start receipts survive restart and cannot start a later recording",async()=>{
    const base=setup();const [first]=await Promise.all([base.coordinator.start("first","both"),base.coordinator.start("duplicate","both")]);
    await base.coordinator.stop("stop",first.meetingId!);
    const recovered=new RecordingCoordinator({manifestPath:base.manifestPath,adapter:base.adapter});
    const replay=await recovered.start("duplicate","both");
    expect(replay.state).toBe("completed");expect(replay.meetingId).toBe(first.meetingId);
  });
  test("a delayed stop targeting an earlier meeting cannot stop new capture", async () => {
    const {coordinator}=setup();const a=await coordinator.start("a","both");await coordinator.stop("b",a.meetingId!);
    const next=await coordinator.start("c","both");
    await expect(coordinator.stop("d",a.meetingId!)).rejects.toThrow("meeting");
    expect(coordinator.snapshot().meetingId).toBe(next.meetingId);expect(coordinator.snapshot().state).toBe("recording");
  });
  test("failed save retains final ASR checkpoint across restart and retry does not rerun ASR", async () => {
    let fail=true;let finalizations=0;const base=setup({save:s=>{if(fail)throw new Error("disk full");return {...s,id:s.id!} as Session;},finalize:async()=>{finalizations++;return base.capture;}});
    const active=await base.coordinator.start("a","both");await expect(base.coordinator.stop("b",active.meetingId!)).rejects.toThrow("disk full");
    fail=false;const recovered=new RecordingCoordinator({manifestPath:base.manifestPath,adapter:base.adapter});
    expect(recovered.snapshot().state).toBe("failed");
    const completed=await recovered.retry("retry",active.meetingId!);
    expect(completed.state).toBe("completed");expect(finalizations).toBe(0);
  });
  test("restart turns interrupted capture into recoverable failure preserving path and manual names", async () => {
    const {coordinator,adapter,manifestPath,capture}=setup();const active=await coordinator.start("a","both");
    coordinator.live("turn",{id:1,speaker:"Speaker 1",text:"Live",start:2,end:6,channel:"sys"});
    coordinator.rename(active.meetingId!,coordinator.snapshot().revision,{"Speaker 1":"Ana"});
    const recovered=new RecordingCoordinator({manifestPath,adapter});expect(recovered.snapshot().state).toBe("failed");expect(recovered.snapshot().path).toBe(capture.path);
    const final=await recovered.retry("r",active.meetingId!);expect(final.session!.speakers).toEqual(["Ana"]);
  });
  test("maintenance rejects new start and cannot be acquired during recording", async () => {
    const {coordinator}=setup();coordinator.setMaintenance(true);
    await expect(coordinator.start("a","both")).rejects.toThrow("maintenance");
    coordinator.setMaintenance(false);await coordinator.start("b","both");expect(()=>coordinator.setMaintenance(true)).toThrow("active");
  });
  test("another installer cannot release or replace an acquired maintenance guard",()=>{
    const {coordinator}=setup();coordinator.setMaintenance(true,"installer-one");
    expect(()=>coordinator.setMaintenance(true,"installer-two")).toThrow("owner");
    expect(()=>coordinator.setMaintenance(false,"installer-two")).toThrow("owner");
    expect(coordinator.snapshot().maintenance).toBe(true);
    coordinator.setMaintenance(false,"installer-one");expect(coordinator.snapshot().maintenance).toBe(false);
  });
  test("speaker mapping is revision checked and provisional turns replay without a subscriber", async () => {
    const {coordinator}=setup();const active=await coordinator.start("a","both");
    coordinator.live("turn",{id:3,speaker:"Me",text:"hello",start:0,end:1,channel:"mic"});
    expect(coordinator.snapshot().segments[0].text).toBe("hello");
    expect(()=>coordinator.rename(active.meetingId!,active.revision,{Me:"Ana"})).toThrow("changed");
    const revision=coordinator.snapshot().revision;coordinator.rename(active.meetingId!,revision,{Me:"Ana"});
    expect(coordinator.snapshot().speakerNames).toEqual({Me:"Ana"});
  });
  test("different contents cannot reuse a command idempotency key", async () => {
    const {coordinator}=setup();await coordinator.start("same","both");
    await expect(coordinator.start("same","mic")).rejects.toThrow("reused");
  });
});

function faultFixture() {
 const directory=mkdtempSync(join(tmpdir(),"heed-coordinator-fault-"));directories.push(directory);
 const manifestPath=join(directory,"manifest.json");let failWrite=false;let failManifest=false;let capturing=false;let starts=0;let stops=0;
 const writes:Array<{snapshot: {state:string};receipts:Record<string,unknown>}>=[];
 const capture={path:join(directory,"capture.wav"),duration:2,language:"en" as const,model:"final",turns:[]};
 const adapter:RecordingAdapter={start:async(_mode,_id,attach)=>{starts++;capturing=true;attach(capture.path);return{path:capture.path};},stop:async stopped=>{stops++;capturing=false;stopped();return capture;},finalize:async()=>capture,save:session=>({...session,id:session.id!} as Session)};
 const write=(path:string,value:unknown)=>{if(failWrite || (failManifest && path===manifestPath))throw new Error("synthetic disk full");atomicWriteJson(path,value);writes.push(structuredClone(value) as typeof writes[number]);};
 const coordinator=new RecordingCoordinator({manifestPath,adapter,write});
 return {coordinator,adapter,capture,directory,manifestPath,writes,write,get capturing(){return capturing;},get starts(){return starts;},get stops(){return stops;},fail:()=>{failWrite=true;},restore:()=>{failWrite=false;failManifest=false;},failManifest:()=>{failManifest=true;}};
}

test("startup commits its request receipt together with state before capture starts",async()=>{
 const f=faultFixture();f.fail();await expect(f.coordinator.start("failed-start")).rejects.toThrow("disk full");expect(f.coordinator.snapshot().state).toBe("idle");expect(f.starts).toBe(0);
 f.restore();await f.coordinator.start("start-atomic");expect(f.writes[0].snapshot.state).toBe("starting");expect(f.writes[0].receipts["start-atomic"]).toBeDefined();
});

test("failed stop transaction leaves actual capture recording and stoppable",async()=>{
 const f=faultFixture();const active=await f.coordinator.start("start");f.fail();await expect(f.coordinator.stop("failed-stop",active.meetingId!)).rejects.toThrow("disk full");
 expect(f.coordinator.snapshot().state).toBe("recording");expect(f.capturing).toBe(true);expect(f.stops).toBe(0);
 f.restore();const writeIndex=f.writes.length;const completed=await f.coordinator.stop("stop-atomic",active.meetingId!);expect(completed.state).toBe("completed");expect(f.writes[writeIndex].snapshot.state).toBe("stopping");expect(f.writes[writeIndex].receipts["stop-atomic"]).toBeDefined();expect(JSON.parse(readFileSync(f.manifestPath,"utf8")).receipts["failed-stop"]).toBeUndefined();
});

test("coalesced receipt failure cannot leak an uncommitted receipt into later progress",async()=>{
 const f=faultFixture();let finish:(value:{path:string})=>void=()=>{};
 f.adapter.start=async(_mode,_id,attach)=>{attach(f.capture.path);return new Promise(resolve=>{finish=resolve;});};
 const first=f.coordinator.start("first");await new Promise(resolve=>setTimeout(resolve,0));f.fail();try {await expect(Promise.race([f.coordinator.start("uncommitted-duplicate"),new Promise((_,reject)=>setTimeout(()=>reject(new Error("duplicate did not fail persistence")),50))])).rejects.toThrow("disk full");}
 finally {f.restore();finish({path:f.capture.path});await first;}expect(JSON.parse(readFileSync(f.manifestPath,"utf8")).receipts["uncommitted-duplicate"]).toBeUndefined();
});

test("recovery commits its request receipt atomically with finalizing state",async()=>{
 const f=faultFixture();f.adapter.stop=async()=>{throw new Error("final ASR unavailable");};const active=await f.coordinator.start("first");await expect(f.coordinator.stop("stop",active.meetingId!)).rejects.toThrow("unavailable");
 f.fail();await expect(f.coordinator.retry("failed-retry",active.meetingId!)).rejects.toThrow("disk full");expect(f.coordinator.snapshot().state).toBe("failed");f.restore();
 const index=f.writes.length;await f.coordinator.retry("retry-atomic",active.meetingId!);expect(f.writes[index].snapshot.state).toBe("finalizing");expect(f.writes[index].receipts["retry-atomic"]).toBeDefined();
});

test("abandon only a failed target, preserves retained audio and is idempotent across restart",async()=>{
 const f=faultFixture();writeFileSync(f.capture.path,"synthetic truncated audio");f.adapter.stop=async()=>{throw new Error("truncated WAV");};const active=await f.coordinator.start("first");
 await expect(f.coordinator.abandon("active-abandon",active.meetingId!)).rejects.toThrow("failed");
 f.coordinator.live("turn",{id:1,speaker:"Speaker 1",text:"Retained provisional turn",start:0,end:1,channel:"sys"});f.coordinator.rename(active.meetingId!,f.coordinator.snapshot().revision,{"Speaker 1":"Ana"});
 await expect(f.coordinator.stop("stop",active.meetingId!)).rejects.toThrow("truncated");
 const archivePath=join(f.directory,"recording-recovery",`${active.meetingId}.json`);
 f.fail();await expect(f.coordinator.abandon("failed-abandon",active.meetingId!)).rejects.toThrow("disk full");expect(f.coordinator.snapshot()).toMatchObject({state:"failed",path:f.capture.path});expect(existsSync(archivePath)).toBe(false);
 f.restore();const index=f.writes.length;const idle=await f.coordinator.abandon("abandon",active.meetingId!);expect(idle).toMatchObject({state:"idle",meetingId:null,path:null});expect(readFileSync(f.capture.path,"utf8")).toBe("synthetic truncated audio");expect(f.writes[index+1].receipts.abandon).toBeDefined();expect(JSON.parse(readFileSync(archivePath,"utf8"))).toMatchObject({version:1,snapshot:{state:"failed",meetingId:active.meetingId,path:f.capture.path,speakerNames:{"Speaker 1":"Ana"},segments:[{text:"Retained provisional turn"}]}});
 const restarted=new RecordingCoordinator({manifestPath:f.manifestPath,adapter:f.adapter});expect((await restarted.abandon("abandon",active.meetingId!)).state).toBe("idle");await expect(restarted.retry("late-retry",active.meetingId!)).rejects.toThrow("meeting");expect((await restarted.start("new")).state).toBe("recording");
});

 test("in-flight command keys reject different contents before a receipt exists",async()=>{
 const f=faultFixture();const first=f.coordinator.start("same-in-flight","both");const other=f.coordinator.start("same-in-flight","mic");
 await expect(other).rejects.toThrow("reused");await first;expect(f.starts).toBe(1);
});

test("abandon manifest failure retains archived final checkpoint and rolls back its receipt",async()=>{
 const f=faultFixture();writeFileSync(f.capture.path,"retained audio");f.adapter.save=()=>{throw new Error("session write failed");};const active=await f.coordinator.start("first");
 await expect(f.coordinator.stop("stop",active.meetingId!)).rejects.toThrow("session write failed");const failed=f.coordinator.snapshot();expect(failed.finalCapture).toBeDefined();
 f.failManifest();await expect(f.coordinator.abandon("uncommitted-abandon",active.meetingId!)).rejects.toThrow("disk full");expect(f.coordinator.snapshot()).toEqual(failed);
 const archive=JSON.parse(readFileSync(join(f.directory,"recording-recovery",`${active.meetingId}.json`),"utf8"));expect(archive.snapshot).toEqual(failed);expect(readFileSync(f.capture.path,"utf8")).toBe("retained audio");
 f.restore();await f.coordinator.abandon("committed-abandon",active.meetingId!);const durable=JSON.parse(readFileSync(f.manifestPath,"utf8"));expect(durable.receipts["uncommitted-abandon"]).toBeUndefined();expect(durable.receipts["committed-abandon"]).toBeDefined();
});

test("snapshots the device preference at admission and preserves it through recovery and finalization", async () => {
  let enabled = false;
  const base = setup();
  const coordinator = new RecordingCoordinator({manifestPath:base.manifestPath,adapter:base.adapter,realTimeTranscription:()=>enabled});
  const active = await coordinator.start("final-only", "both");
  expect(active.realTimeTranscription).toBe(false);
  enabled = true;
  coordinator.live("segment", {speaker:"Preview",text:"Must not be admitted",start:0,end:1});
  expect(coordinator.snapshot().segments).toEqual([]);
  const recovered = new RecordingCoordinator({manifestPath:base.manifestPath,adapter:base.adapter,realTimeTranscription:()=>enabled});
  expect(recovered.snapshot().realTimeTranscription).toBe(false);
  const done = await recovered.retry("recover", active.meetingId!);
  expect(done.session).toMatchObject({transcript:"Vamos entregar sexta.",speakers:["Speaker 1"],transcriptFinalized:true});
  expect(done.realTimeTranscription).toBe(false);
  expect((await recovered.start("next", "mic")).realTimeTranscription).toBe(true);
});

describe('transcript-only lifecycle',()=>{
 test('freezes archival preference and saves authoritative text before confirmed cleanup',async()=>{
  let preference='transcript-only';const events:string[]=[];
  const base=setup({save:(s:Partial<Session>)=>{events.push('save');return {...s,id:s.id!} as Session;},cleanup:(s:Session)=>{events.push('cleanup');expect(s.transcriptFinalized).toBe(true);expect(s.audioCleanup?.status).toBe('pending');return {...s,files:{...s.files,wav:''},audioCleanup:{...s.audioCleanup!,status:'completed'}};}} as any);
  const coordinator=new RecordingCoordinator({manifestPath:base.manifestPath,adapter:base.adapter,meetingMode:()=>preference as any});
  const active=await coordinator.start('archive-start');preference='audio-transcript';
  const completed=await coordinator.stop('archive-stop',active.meetingId!);
  expect(events).toEqual(['save','cleanup']);expect(completed.meetingMode).toBe('transcript-only');expect(completed.session).toMatchObject({meetingMode:'transcript-only',audioUnavailableReason:'transcript-only',audioCleanup:{status:'completed'},files:{wav:''}});
 });
 test('save failure retains the bounded capture checkpoint and cannot abandon transcript-only audio',async()=>{
  let fail=true,cleanups=0;const base=setup({save:(s:Partial<Session>)=>{if(fail)throw Error('Synthetic save fault');return {...s,id:s.id!} as Session;},cleanup:(s:Session)=>{cleanups++;return {...s,audioCleanup:{...s.audioCleanup!,status:'completed'},files:{wav:''}};}} as any);
  const coordinator=new RecordingCoordinator({manifestPath:base.manifestPath,adapter:base.adapter,meetingMode:()=> 'transcript-only'});
  const active=await coordinator.start('save-fault-start');await expect(coordinator.stop('save-fault-stop',active.meetingId!)).rejects.toThrow('Synthetic save fault');
  expect(cleanups).toBe(0);expect(coordinator.snapshot().audioCleanup?.status).toBe('pending');
  await expect(coordinator.abandon('archive',active.meetingId!)).rejects.toThrow('transcript-only');await expect(coordinator.start('another')).rejects.toThrow('Recover');
  fail=false;expect((await coordinator.retry('save-retry',active.meetingId!)).session?.audioCleanup?.status).toBe('completed');
 });
 test('cleanup failure resumes after restart without retranscription or duplicate save',async()=>{
  let fail=true,saved:Session|null=null,saves=0,finalizes=0;
  const base=setup({save:(s:Partial<Session>)=>{saves++;saved={...s,id:s.id!} as Session;return saved;},read:(id:string)=>saved?.id===id?saved:null,finalize:async()=>{finalizes++;return base.capture;},cleanup:(s:Session)=>{if(fail)throw Error('Synthetic deletion fault');saved={...s,files:{wav:''},audioCleanup:{...s.audioCleanup!,status:'completed'}};return saved;}} as any);
  const coordinator=new RecordingCoordinator({manifestPath:base.manifestPath,adapter:base.adapter,meetingMode:()=> 'transcript-only'});
  const active=await coordinator.start('delete-start');await expect(coordinator.stop('delete-stop',active.meetingId!)).rejects.toThrow('Synthetic deletion fault');expect((saved as Session|null)?.audioCleanup?.status).toBe('pending');
  fail=false;const recovered=new RecordingCoordinator({manifestPath:base.manifestPath,adapter:base.adapter});const result=await recovered.resumeCleanup();
  expect(result.state).toBe('completed');expect(saves).toBe(1);expect(finalizes).toBe(0);expect(result.session?.audioCleanup?.status).toBe('completed');
 });
 test('confirmed discard deletes owned temporary audio before resetting the failed slot',async()=>{
  let discarded=false;const base=setup({stop:async()=>{throw Error('Synthetic transcription fault');},discard:()=>{discarded=true;}} as any);
  const coordinator=new RecordingCoordinator({manifestPath:base.manifestPath,adapter:base.adapter,meetingMode:()=> 'transcript-only'});
  const active=await coordinator.start('discard-start');await expect(coordinator.stop('discard-stop',active.meetingId!)).rejects.toThrow();
  const result=await coordinator.discard('discard',active.meetingId!);expect(discarded).toBe(true);expect(result.state).toBe('idle');
 });
});
test('a new meeting clears prior authoritative cleanup checkpoints before any recovery',async()=>{const base=setup();const first=await base.coordinator.start('first');await base.coordinator.stop('first-stop',first.meetingId!);const second=await base.coordinator.start('second');expect(second.finalCapture).toBeUndefined();expect(second.audioCleanup).toBeUndefined();expect(second.audioDiscardRequested).toBeUndefined();});
test('a crashed confirmed discard resumes exact cleanup before releasing the failed capture slot',async()=>{let discarded=0,fail=true;const base=setup({stop:async()=>{throw Error('Synthetic processing fault');},discard:()=>{discarded++;}} as any);const coordinator=new RecordingCoordinator({manifestPath:base.manifestPath,adapter:base.adapter,meetingMode:()=> 'transcript-only',write(path,value){if((value as any).snapshot.state==='idle'&&fail){fail=false;throw Error('Synthetic discard receipt fault');}atomicWriteJson(path,value);}});const active=await coordinator.start('discard-restart-start');await expect(coordinator.stop('discard-restart-stop',active.meetingId!)).rejects.toThrow();await expect(coordinator.discard('confirmed-discard',active.meetingId!)).rejects.toThrow('receipt');expect(coordinator.snapshot().audioDiscardRequested).toBe(true);const recovered=new RecordingCoordinator({manifestPath:base.manifestPath,adapter:base.adapter});expect((await recovered.resumeCleanup()).state).toBe('idle');expect(discarded).toBe(2);});
