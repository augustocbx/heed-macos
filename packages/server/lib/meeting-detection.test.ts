import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWriteJson } from "./atomic-json";
import { MeetingDetectionController, parseMeetingReport } from "./meeting-detection";

function fixture() {
  let now = 0;
  let snapshot = { meetingId: null as string | null, state: "idle", path: null as string | null, maintenance: false };
  const commands: string[] = [];
  const controller = new MeetingDetectionController({
    now: () => now,
    recording: {
      snapshot: () => snapshot,
      start: async () => { commands.push("start"); snapshot = { ...snapshot, meetingId: `meeting-${commands.length}`, state: "recording" }; return snapshot; },
      stop: async (_requestId, id) => { commands.push(`stop:${id}`); snapshot = { ...snapshot, state: "completed" }; return snapshot; },
    },
  });
  let seq = 0;
  const report = (app: "slack" | "zoom" | "teams" | "meet", state: "active" | "inactive" | "unknown", callId = "call-1", detectorId = `native:${app}`) => controller.report({app, state, callId: state === "inactive" ? null : callId, detectorId, sequence: ++seq, capability: state === "unknown" ? "degraded" : "ready"});
  return { controller, commands, report, advance: async (ms: number) => { now += ms; await controller.tick(); }, setSnapshot: (patch: Partial<typeof snapshot>) => { snapshot = { ...snapshot, ...patch }; }, manual: (state: string, id = "manual") => { snapshot = { ...snapshot, state, meetingId: id }; controller.recordingChanged(); } };
}

describe("meeting recording ownership", () => {
  test("confirms a join then finalizes once without a browser", async () => {
    const f = fixture(); f.report("slack", "active"); await f.advance(2999); expect(f.commands).toEqual([]);
    await f.advance(1); expect(f.commands).toEqual(["start"]);
    f.report("slack", "inactive"); await f.advance(4999); expect(f.commands).toHaveLength(1);
    await f.advance(1); await f.advance(10000); expect(f.commands).toEqual(["start", "stop:meeting-1"]);
  });
  test("missing heartbeat, unknown UI, minimize, and transient disconnect never confirm end", async () => {
    const f = fixture(); f.report("slack", "active"); await f.advance(3000);
    f.report("slack", "inactive"); await f.advance(4000); f.report("slack", "unknown"); await f.advance(60000);
    expect(f.commands).toEqual(["start"]); expect(f.controller.status().sources[0].state).toBe("unknown");
    f.report("slack", "active"); await f.advance(3000); expect(f.commands).toEqual(["start"]);
  });
  test("manual recordings and manual stop are never overridden", async () => {
    const f = fixture(); f.manual("recording"); f.report("slack", "active"); await f.advance(3000);
    f.manual("completed"); await f.advance(3000); expect(f.commands).toEqual([]);
    f.report("slack", "inactive"); await f.advance(5000); f.report("slack", "active", "call-2"); await f.advance(3000); expect(f.commands).toEqual(["start"]);
    f.manual("stopping", "meeting-1"); f.manual("completed", "meeting-1"); await f.advance(3000); expect(f.commands).toEqual(["start"]);
  });
  test("overlapping apps and two tabs share a recording until all calls positively end", async () => {
    const f = fixture(); f.controller.configure({ zoom: true, meet: true });
    f.report("zoom", "active"); await f.advance(3000);
    f.report("meet", "active", "tab-1", "browser:tab-1"); f.report("meet", "active", "tab-2", "browser:tab-2"); await f.advance(3000);
    f.report("zoom", "inactive"); f.report("meet", "inactive", "", "browser:tab-1"); await f.advance(5000); expect(f.commands).toEqual(["start"]);
    f.report("meet", "inactive", "", "browser:tab-2"); await f.advance(5000); expect(f.commands).toEqual(["start", "stop:meeting-1"]);
  });
  test("disabled apps cannot start; disabling an owned source does not silently stop capture", async () => {
    const f = fixture(); f.report("zoom", "active"); await f.advance(3000); expect(f.commands).toEqual([]);
    f.controller.configure({ zoom: true }); await f.advance(3000); expect(f.commands).toEqual(["start"]);
    f.controller.configure({ zoom: false }); await f.advance(5000); expect(f.commands).toEqual(["start"]);
    expect(f.controller.status().ownerMeetingId).toBeNull();
    f.report("zoom", "inactive"); await f.advance(5000); expect(f.commands).toEqual(["start"]);
  });
  test("stale sequences and capability loss cannot end a newer call", async () => {
    const f = fixture(); f.report("slack", "active"); await f.advance(3000);
    expect(f.controller.report({ app: "slack", detectorId: "native:slack", sequence: 0, state: "inactive", callId: null, capability: "ready" })).toBe(false);
    await f.advance(5000); expect(f.commands).toEqual(["start"]);
  });
  test("maintenance blocks automatic starts and recoverable failures preserve audio", async () => {
    const f = fixture(); f.setSnapshot({ maintenance: true }); f.report("slack", "active"); await f.advance(3000); expect(f.commands).toEqual([]);
    f.setSnapshot({ maintenance: false, state: "failed", path: "/retained.wav" }); await f.advance(3000); expect(f.commands).toEqual([]);
    f.setSnapshot({ path: null }); await f.advance(3000); expect(f.commands).toEqual([]);
    f.report("slack","inactive");await f.advance(5000);f.report("slack","active","after-recovery");await f.advance(3000);expect(f.commands).toEqual(["start"]);
  });
});

test("strict report schema never accepts page content, generic app names, or claimed unsupported signals", () => {
  const valid = { app: "meet", detectorId: "browser:tab-1", sequence: 1, state: "active", callId: "uuid", capability: "ready" };
  expect(parseMeetingReport(valid)).toEqual(valid);
  for (const patch of [{ app: "chrome" }, { detectorId: "native:meet" }, { sequence: -1 }, { callId: null }, { state: "maybe" }, { capability: "permission-required" }, { title: "private transcript" }]) expect(() => parseMeetingReport({ ...valid, ...patch })).toThrow();
});


test("settings and manual-stop suppression survive backend restart without resurrecting calls", async () => {
 const dir = mkdtempSync(join(tmpdir(), "heed-detection-"));
 const journalPath = join(dir, "detection.json");
 let state = "recording", meetingId = "manual", starts = 0;
 const recording = { snapshot: () => ({state, meetingId}), start: async () => { starts++; return {state:"recording", meetingId:"auto"}; }, stop: async () => ({state:"completed", meetingId:"auto"}) };
 try {
  const first = new MeetingDetectionController({ recording, journalPath, now: () => 0 });
  first.configure({ zoom: true }); first.report({ app:"zoom", detectorId:"native:zoom", sequence:1, state:"active", callId:"stable-id", capability:"ready" });
  state = "completed"; first.recordingChanged();
  const second = new MeetingDetectionController({ recording, journalPath, now: () => 10000 });
  second.report({ app:"zoom", detectorId:"native:zoom", sequence:2, state:"active", callId:"stable-id", capability:"ready" });
  await second.tick(); expect(starts).toBe(0); expect(second.status().enabled.zoom).toBe(true); expect(second.status().sources[0].suppressed).toBe(true);
  expect(readFileSync(journalPath,"utf8")).not.toContain("private");
 } finally { rmSync(dir, {recursive:true,force:true}); }
});

test("rapid rejoin cancels end debounce, and a fully confirmed new room gets a new recording", async () => {
 const f = fixture(); f.report("slack", "active"); await f.advance(3000);
 f.report("slack", "inactive"); await f.advance(4000); f.report("slack", "active"); await f.advance(3000); expect(f.commands).toEqual(["start"]);
 f.report("slack", "inactive"); await f.advance(5000); f.report("slack", "active", "new-room"); await f.advance(3000); expect(f.commands).toEqual(["start", "stop:meeting-1", "start"]);
});


test("readiness waiting spends no retry attempts and ended calls never start late", async () => {
 let now = 0, ready = false, starts = 0;
 const controller = new MeetingDetectionController({now:()=>now,isReady:()=>ready,recording:{snapshot:()=>({state:"idle",meetingId:null}),start:async()=>{starts++;return {state:"recording",meetingId:"ready"};},stop:async()=>({state:"completed",meetingId:"ready"})}});
 const report = (state:"active"|"inactive",sequence:number) => controller.report({app:"slack",detectorId:"native:slack",state,sequence,callId:state==="active"?"ready-call":null,capability:"ready"});
 for(let sequence=1;sequence<=10;sequence++){report("active",sequence);now+=4000;await controller.tick();} expect(starts).toBe(0);expect(controller.status().error).toContain("waiting");
 report("inactive",11);ready=true;now+=6000;await controller.tick();expect(starts).toBe(0);
});


test("sleep or an observation gap before end confirmation cannot finalize stale evidence", async () => {
 const f=fixture();f.report("slack","active");await f.advance(3000);f.report("slack","inactive");await f.advance(60000);expect(f.commands).toEqual(["start"]);expect(f.controller.status().sources[0].state).toBe("unknown");
});

test("manual takeover during an in-flight automatic start cannot later acquire automatic ownership", async () => {
 let now=0,resolve!: (value:{state:string;meetingId:string})=>void;
 const controller=new MeetingDetectionController({now:()=>now,recording:{snapshot:()=>({state:"idle",meetingId:null}),start:()=>new Promise(done=>{resolve=done;}),stop:async()=>({state:"completed",meetingId:"capture"})}});
 controller.report({app:"slack",detectorId:"native:slack",sequence:1,state:"active",callId:"call",capability:"ready"});now=3000;
 const pending=controller.tick();controller.manualOverride();resolve({state:"recording",meetingId:"capture"});await pending;
 expect(controller.status().ownerMeetingId).toBeNull();expect(controller.status().sources[0].suppressed).toBe(true);
});

test("settings and manual override roll back on persistence fault and block automation", async () => {
 const dir=mkdtempSync(join(tmpdir(),"heed-detection-fault-"));let fail=false;
 const recording={snapshot:()=>({state:"idle",meetingId:null}),start:async()=>({state:"recording",meetingId:"auto"}),stop:async()=>({state:"completed",meetingId:"auto"})};
 try {
  const controller=new MeetingDetectionController({recording,journalPath:join(dir,"state.json"),write:(path,value)=>{if(fail)throw new Error("disk unavailable");atomicWriteJson(path,value);}});
  controller.configure({zoom:true});const before=readFileSync(join(dir,"state.json"),"utf8");fail=true;expect(()=>controller.configure({zoom:false})).toThrow("disk");expect(controller.status().enabled.zoom).toBe(true);expect(readFileSync(join(dir,"state.json"),"utf8")).toBe(before);
  controller.report({app:"zoom",detectorId:"native:zoom",sequence:1,state:"active",callId:"call",capability:"ready"});expect(()=>controller.manualOverride()).toThrow("disk");expect(controller.status().sources[0].suppressed).toBe(false);expect(controller.status().error).toContain("disabled");
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test("a successful capture whose ownership cannot persist stays manual and cannot auto-stop", async () => {
 const dir=mkdtempSync(join(tmpdir(),"heed-owner-fault-"));let now=0,state="idle",meetingId:string|null=null,stops=0,fail=false;
 const recording={snapshot:()=>({state,meetingId}),start:async()=>{state="recording";meetingId="capture";fail=true;return {state,meetingId};},stop:async()=>{stops++;return {state:"completed",meetingId};}};
 try{
  const controller=new MeetingDetectionController({recording,now:()=>now,journalPath:join(dir,"journal.json"),write:(path,value)=>{if(fail)throw new Error("ownership write failed");atomicWriteJson(path,value);}});
  controller.configure({zoom:true});controller.report({app:"zoom",detectorId:"native:zoom",sequence:1,state:"active",callId:"call",capability:"ready"});now=3000;await controller.tick();expect(controller.status().ownerMeetingId).toBeNull();
  controller.report({app:"zoom",detectorId:"native:zoom",sequence:2,state:"inactive",callId:null,capability:"ready"});now+=5000;await controller.tick();expect(stops).toBe(0);
  expect(JSON.parse(readFileSync(join(dir,"journal.json"),"utf8")).ownerMeetingId).toBeNull();
  const restarted=new MeetingDetectionController({recording,now:()=>now,journalPath:join(dir,"journal.json")});
  restarted.report({app:"zoom",detectorId:"native:zoom",sequence:3,state:"active",callId:"call",capability:"ready"});
  restarted.report({app:"zoom",detectorId:"native:zoom",sequence:4,state:"inactive",callId:null,capability:"ready"});now+=5000;await restarted.tick();expect(stops).toBe(0);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test("more than 128 sequential browser tabs retire after confirmed end without exhausting detection", async () => {
 let now=0,sequence=0;
 const controller=new MeetingDetectionController({now:()=>now,recording:{snapshot:()=>({state:"recording",meetingId:"manual"}),start:async()=>({state:"recording",meetingId:"auto"}),stop:async()=>({state:"completed",meetingId:"auto"})}});
 controller.configure({meet:true});
 for(let index=0;index<300;index++){
  const detectorId=`browser:tab-${index}`;
  controller.report({app:"meet",detectorId,sequence:++sequence,state:"active",callId:`call-${index}`,capability:"ready"});
  controller.report({app:"meet",detectorId,sequence:++sequence,state:"inactive",callId:null,capability:"ready"});now+=5000;await controller.tick();
 }
 expect(controller.status().sources.length).toBeLessThan(2);
});

test("reconfiguring after failed manual takeover never restores the old automatic owner",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"heed-takeover-fault-"));let now=0,fail=false,state="idle",meetingId:string|null=null,stops=0;
 const recording={snapshot:()=>({state,meetingId}),start:async()=>{state="recording";meetingId="owned";return {state,meetingId};},stop:async()=>{stops++;return {state:"completed",meetingId};}};
 try{
  const controller=new MeetingDetectionController({recording,now:()=>now,journalPath:join(dir,"journal.json"),write:(path,value)=>{if(fail)throw new Error("disk unavailable");atomicWriteJson(path,value);}});
  controller.report({app:"slack",detectorId:"native:slack",sequence:1,state:"active",callId:"call",capability:"ready"});now=3000;await controller.tick();expect(controller.status().ownerMeetingId).toBe("owned");
  fail=true;expect(()=>controller.manualOverride()).toThrow();fail=false;controller.configure({teams:false});expect(controller.status().ownerMeetingId).toBeNull();
  controller.report({app:"slack",detectorId:"native:slack",sequence:2,state:"inactive",callId:null,capability:"ready"});now+=5000;await controller.tick();expect(stops).toBe(0);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
