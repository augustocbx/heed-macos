import { expect, test } from "bun:test";
import { MeetingDetectionController } from "./meeting-detection";
import { meetingDetectionRoute } from "./meeting-detection-http";

test("real HTTP detection controls enforce origin, scope, sequencing and ownership", async () => {
 let now = 0, state = "idle", meetingId: string | null = null;
 const commands: string[] = [];
 const controller = new MeetingDetectionController({ now: () => now, recording: {
  snapshot: () => ({ state, meetingId }),
  start: async () => { commands.push("start"); state = "recording"; meetingId = "automatic"; return { state, meetingId }; },
  stop: async (_request, id) => { commands.push(`stop:${id}`); state = "completed"; return { state, meetingId }; },
 }});
 const server = Bun.serve({hostname: "127.0.0.1", port: 0, fetch: req => meetingDetectionRoute(req, controller, server.port)});
 const base = `http://127.0.0.1:${server.port}/api/meeting-detection`;
 const post = (route: string, body: unknown, origin?: string) => fetch(base + route, {method: "POST", headers: {"Content-Type":"application/json", ...(origin ? {Origin: origin} : {})}, body: JSON.stringify(body)});
 const report = {app:"slack", detectorId:"native:slack", sequence:1, callId:"call", state:"active", capability:"ready"};
 try {
  expect((await post("/report", report, "https://evil.example")).status).toBe(403);
  expect((await post("/settings", {zoom:true}, "http://localhost:48101")).status).toBe(200);
  expect((await post("/settings", {private: true})).status).toBe(400);
  expect((await post("/report", {...report, title:"private content"})).status).toBe(400);
  expect((await post("/report", report)).status).toBe(200);
  now = 3000; await controller.tick(); expect(commands).toEqual(["start"]);
  expect((await post("/report", {...report, sequence:0, state:"inactive", callId:null})).status).toBe(409);
  now += 3000; await controller.tick(); expect(commands).toHaveLength(1);
  expect((await post("/report", {...report, sequence:2, state:"inactive", callId:null})).status).toBe(200);
  now += 5000; await controller.tick(); expect(commands).toEqual(["start", "stop:automatic"]);
  expect((await (await fetch(base + "/status")).json()).ownerMeetingId).toBeNull();
  state = "recording"; meetingId = "manual"; controller.recordingChanged();
  await post("/report", {...report, sequence:3, callId:"new-call"}); now += 3000; await controller.tick();
  await post("/report", {...report, sequence:4, state:"inactive", callId:null}); now += 5000; await controller.tick(); expect(commands).toHaveLength(2);
  expect((await fetch(base + "/status", {headers:{Origin:"null"}})).status).toBe(403);
  expect((await fetch(base + "/report")).status).toBe(405);
 } finally { server.stop(true); }
});

// Exercise the actual durable coordinator behind real HTTP detection routes.
// The adapter is synthetic: no physical capture, model, or private session.
import { RecordingCoordinator } from "./recording-coordinator";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Session } from "@heed/shared";
test("HTTP call end persists exactly one final meeting without a browser, then manual stop suppresses restart", async () => {
 const dir = mkdtempSync(join(tmpdir(), "heed-detection-http-"));
 let now = 0, saves = 0, captures = 0;
 const audio = join(dir,"synthetic.wav"), sessionPath = join(dir,"session.json");
 const capture = {path:audio,duration:9,language:"pt" as const,model:"synthetic-final",turns:[{speaker:"Speaker 1",text:"Vamos entregar amanhã.",start:0,end:2}]};
 const coordinator = new RecordingCoordinator({manifestPath:join(dir,"recording.json"),now:()=>now,adapter:{
  start: async (_mode,_id,attach) => {captures++;attach(audio);writeFileSync(audio,"synthetic fixture, not real audio");return {path:audio,liveModel:"synthetic-English-preview"};},
  stop: async stopped => {stopped();return capture;}, finalize: async () => capture,
  save: value => {saves++;const saved=value as Session;writeFileSync(sessionPath,JSON.stringify(saved));return saved;},
 }});
 const controller = new MeetingDetectionController({recording:coordinator,now:()=>now,journalPath:join(dir,"detection.json")});
 const unsubscribe=coordinator.subscribe(()=>controller.recordingChanged());
 const server=Bun.serve({hostname:"127.0.0.1",port:0,fetch:req=>meetingDetectionRoute(req,controller,server.port)});
 const base=`http://127.0.0.1:${server.port}/api/meeting-detection`;
 const post=(sequence:number,state:"active"|"inactive",callId:string|null)=>fetch(base+"/report",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({app:"slack",detectorId:"native:slack",sequence,state,callId,capability:"ready"})});
 try {
  await post(1,"active","first");now=3000;await Promise.all([controller.tick(),controller.tick()]);expect(captures).toBe(1);
  await post(2,"inactive",null);now+=5000;await Promise.all([controller.tick(),controller.tick()]);expect(saves).toBe(1);
  expect(JSON.parse(readFileSync(sessionPath,"utf8"))).toMatchObject({transcriptFinalized:true,transcript:"Vamos entregar amanhã.",language:"pt",liveModel:"synthetic-English-preview"});
  await post(3,"active","second");now+=3000;await controller.tick();const active=coordinator.snapshot();expect(captures).toBe(2);
  await coordinator.stop("manual-stop",active.meetingId!);expect(saves).toBe(2);
  now+=3000;await controller.tick();await post(4,"active","second");now+=3000;await controller.tick();expect(captures).toBe(2);
  const restarted=new MeetingDetectionController({recording:coordinator,journalPath:join(dir,"detection.json"),now:()=>now});
  restarted.report({app:"slack",detectorId:"native:slack",sequence:5,state:"active",callId:"second",capability:"ready"});now+=3000;await restarted.tick();expect(captures).toBe(2);
 } finally {unsubscribe();server.stop(true);rmSync(dir,{recursive:true,force:true});}
});
