import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

let directory: string;
let app: ReturnType<typeof Bun.spawn>;
let sidecar: ReturnType<typeof Bun.serve>;
let base: string;
let finalizeCalls = 0;
let releaseFinalization: (() => void) | undefined;
let finalizationBody: any;
const request = async (path: string, body?: unknown, origin?: string, method = body === undefined ? "GET" : "POST") => {
 const response = await fetch(`${base}${path}`, { method, headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
 return { status: response.status, body: response.status === 403 ? null : await response.json() };
};

async function startApp() {
 app = Bun.spawn([process.execPath, resolve(import.meta.dir, "../server.ts")], { cwd: resolve(import.meta.dir, "../../.."), env: { ...process.env, PORT: base.split(":").at(-1)!, HEED_APP_DIR: directory, HEED_RECORDINGS_DIR: join(directory, "recordings"), HEED_TRANSCRIPTION_URL: `http://127.0.0.1:${sidecar.port}` }, stdout: "ignore", stderr: "pipe" });
 const deadline = Date.now() + 8000;
 while (Date.now() < deadline) {
  try { if ((await fetch(`${base}/api/desktop/control/status`)).ok) return; } catch {}
  await Bun.sleep(30);
 }
 throw new Error("Isolated recording server did not start");
}
async function restartApp() { app.kill(); await app.exited; await startApp(); }

beforeAll(async () => {
 directory = mkdtempSync(join(tmpdir(), "heed-recording-http-"));
 sidecar = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
  if (new URL(req.url).pathname === "/finalize") {
   finalizeCalls++; finalizationBody = await req.json();
   await new Promise<void>(resolve => { releaseFinalization = resolve; });
   return Response.json({ finalized:true, duration:2.25, language:"pt", model:"small", turns:[{speaker:"Speaker 1",channel:"sys",text:"Bom dia",start:0,end:2.25}],embeddings:{"Speaker 1":[1,2]} });
  }
  return Response.json({whisper:true,warm:true});
 }});
 const reservation = Bun.serve({hostname:"127.0.0.1",port:0,fetch:()=>new Response()});
 base = `http://127.0.0.1:${reservation.port}`; reservation.stop(true);
 await startApp();
});
afterAll(async () => { app?.kill(); if (app) await app.exited; sidecar?.stop(true); if (directory) rmSync(directory, { recursive: true, force: true }); });

test("authoritative lifecycle status is available without a browser owner", async () => {
 const state = await request("/api/recording/status");
 expect(state.status).toBe(200);
 expect(state.body).toMatchObject({ state: "idle", meetingId: null, maintenance: false, segments: [] });
 const compatibility = await request("/api/desktop/control/poll", { client: "synthetic-browser", recording: true, processing: true, seconds: 999 });
 expect(compatibility.body.command).toBeNull();
 expect(compatibility.body.status).toMatchObject({ recording: false, processing: false, seconds: 0 });
});

test("all lifecycle and legacy capture controls reject nonlocal origins", async () => {
 for (const [path, body] of [
  ["/api/recording/status", undefined], ["/api/recording/speakers", { meetingId: "missing", expectedRevision: 0, speakerNames: {} }],
  ["/api/recording/retry", { requestId: "retry", meetingId: "missing" }], ["/api/recording/maintenance", { acquire: true, owner:"http-fixture" }],
  ["/api/sysrecord/start", { requestId: "start", mode: "mic" }], ["/api/sysrecord/stop", { requestId: "stop", meetingId: "missing" }],
  ["/api/desktop/control/commands", { action: "start", language: "en", requestId: "menu" }],
 ] as const) expect((await request(path, body, "https://outside.example")).status).toBe(403);
});

test("maintenance atomically blocks capture until explicitly released", async () => {
 expect((await request("/api/recording/maintenance", { acquire: true, owner:"http-fixture" })).body.maintenance).toBe(true);
 const start = await request("/api/sysrecord/start", { requestId: "blocked-start", mode: "mic" });
 expect(start.status).toBe(409);
 expect((await request("/api/recording/status")).body.state).toBe("idle");
 expect((await request("/api/recording/maintenance",{acquire:false,owner:"other-owner"})).status).toBe(409);
 expect((await request("/api/recording/maintenance",{acquire:true,owner:"other-owner"})).status).toBe(409);
 expect((await request("/api/recording/maintenance",{acquire:false})).status).toBe(400);
 expect((await request("/api/recording/status")).body.maintenance).toBe(true);
 expect((await request("/api/recording/maintenance", { acquire: false, owner:"http-fixture" })).body.maintenance).toBe(false);
 for (const action of ["acquire","release"]) {
  const guard = Bun.spawn(["python3",resolve(import.meta.dir,"../../desktop/guard-lifecycle.py"),action,"--base-url",base,"--owner","guard-fixture"],{stdout:"pipe",stderr:"pipe"});
  expect(await guard.exited).toBe(0);
  expect((await request("/api/recording/status")).body.maintenance).toBe(action === "acquire");
 }
});


test("restart recovery finalizes and saves once without any browser, preserving speaker names", async () => {
 await app.kill(); await app.exited;
 const wav = join(directory,"recordings","capture-recovery.wav");
 mkdirSync(join(directory,"recordings"),{recursive:true});
 writeFileSync(wav,"Synthetic retained audio; duration is provided by the fixture ASR");
 writeFileSync(join(directory,"recording-manifest.json"),JSON.stringify({version:1,receipts:{},snapshot:{meetingId:"recovery-fixture",state:"finalizing",revision:5,startedAt:1000,path:wav,seconds:2,mode:"both",segments:[{speaker:"Speaker 1",channel:"sys",text:"Bom dia",start:0,end:2.25}],speakerNames:{"Speaker 1":"Ana"},session:null,error:null,maintenance:false}}));
 await startApp();
 expect((await request("/api/recording/status")).body).toMatchObject({state:"failed",path:wav,speakerNames:{"Speaker 1":"Ana"}});
 const first = request("/api/recording/retry",{requestId:"first-retry",meetingId:"recovery-fixture"});
 while (!releaseFinalization) await Bun.sleep(10);
 const second = request("/api/recording/retry",{requestId:"second-retry",meetingId:"recovery-fixture"});
 expect((await request("/api/desktop/control/status")).body).toMatchObject({recording:false,processing:true,state:"finalizing"});
 expect((await request("/api/recording/maintenance",{acquire:true,owner:"http-fixture"})).status).toBe(409);
 const installerGuard = Bun.spawn(["python3",resolve(import.meta.dir,"../../desktop/guard-lifecycle.py"),"acquire","--base-url",base,"--owner","guard-fixture"],{stdout:"pipe",stderr:"pipe"});
 expect(await installerGuard.exited).toBe(1);
 expect(await new Response(installerGuard.stderr).text()).toContain("An active meeting");
 releaseFinalization!();
 const responses = await Promise.all([first,second]);
 expect(responses.every(result=>result.status === 200)).toBe(true);
 expect(finalizeCalls).toBe(1);
 expect(finalizationBody).toMatchObject({wav_path:wav,language:"auto",allowed_languages:["en","pt"]});
 const saved = responses[0].body.session;
 expect(saved).toMatchObject({id:"recovery-fixture",duration:2.25,language:"pt",transcript:"Bom dia",speakers:["Ana"],transcriptFinalized:true,files:{wav}});
 expect(saved.segments[0].speaker).toBe("Ana");
 expect(saved.embeddings).toEqual({Ana:[1,2]});
 expect((await request("/api/sessions")).body).toHaveLength(1);
 await restartApp();
 expect((await request("/api/recording/status")).body).toMatchObject({state:"completed",session:{id:saved.id}});
 expect((await request("/api/recording/retry",{requestId:"first-retry",meetingId:saved.id})).body.session.id).toBe(saved.id);
 expect(finalizeCalls).toBe(1);
 expect((await request("/api/sysrecord/stop",{requestId:"untargeted-stop"})).status).toBe(409);
 expect((await request("/api/desktop/control/commands",{action:"stop",requestId:"untargeted-menu-stop"})).status).toBe(409);
});


test("completed status hydrates current meeting edits and never resurrects a deleted meeting",async()=>{
 const manifest = join(directory,"recording-manifest.json");
 const persisted = readFileSync(manifest,"utf8");
 const updated = await request("/api/sessions?id=recovery-fixture",{speakers:["Ana Silva"],segments:[{speaker:"Ana Silva",channel:"sys",text:"Bom dia",start:0,end:2.25}],aiNotes:"User-edited notes"},undefined,"PATCH");
 expect(updated.status).toBe(200);
 for (const snapshot of [
  (await request("/api/recording/status")).body,
  (await request("/api/desktop/control/poll",{client:"new-browser"})).body.status.snapshot,
  (await request("/api/recording/retry",{requestId:"completed-retry",meetingId:"recovery-fixture"})).body,
 ]) expect(snapshot).toMatchObject({state:"completed",session:{speakers:["Ana Silva"],aiNotes:"User-edited notes"},segments:[{speaker:"Ana Silva"}]});
 const abort = new AbortController();
 const stream = await fetch(`${base}/api/sysrecord/live`,{signal:abort.signal});
 const reader = stream.body!.getReader();
 const frame = new TextDecoder().decode((await reader.read()).value).split("\n\n")[0];
 const replay = JSON.parse(frame.split("\ndata: ")[1]);
 expect(replay.session).toMatchObject({speakers:["Ana Silva"],aiNotes:"User-edited notes"});
 abort.abort();
 expect(readFileSync(manifest,"utf8")).toBe(persisted);
 expect((await request("/api/sessions?id=recovery-fixture",undefined,undefined,"DELETE")).status).toBe(200);
 await restartApp();
 for (const snapshot of [(await request("/api/recording/status")).body,(await request("/api/desktop/control/poll",{client:"new-browser"})).body.status.snapshot]) {
  expect(snapshot).toMatchObject({state:"completed",session:null,segments:[],path:null});
  expect(snapshot.finalCapture).toBeUndefined();
 }
 expect((await request("/api/sessions")).body).toHaveLength(0);
 expect(readFileSync(manifest,"utf8")).toBe(persisted);
});

test('unrecoverable audio can be kept and released from the active recovery lifecycle',async()=>{
 app.kill();await app.exited;const wav=join(directory,'recordings','capture-unrecoverable.wav');writeFileSync(wav,'Synthetic truncated audio');
 writeFileSync(join(directory,'recording-manifest.json'),JSON.stringify({version:1,receipts:{},snapshot:{meetingId:'unrecoverable-fixture',state:'failed',revision:50,startedAt:1000,path:wav,seconds:0,mode:'both',segments:[{speaker:'Speaker 1',text:'Synthetic',start:0,end:1,channel:'sys'}],speakerNames:{'Speaker 1':'Ana'},session:null,error:'Invalid WAV',maintenance:false}}));
 await startApp();
 expect((await request('/api/sysrecord/start',{requestId:'blocked-by-recovery',mode:'mic'})).status).toBe(409);
 expect((await request(`/api/recovery/discard?path=${encodeURIComponent(wav)}`,undefined,undefined,'DELETE')).status).toBe(409);
 expect((await request('/api/recording/abandon',{requestId:'foreign-abandon',meetingId:'unrecoverable-fixture'},'https://outside.example')).status).toBe(403);
 expect((await request('/api/recording/abandon',{requestId:'stale-abandon',meetingId:'earlier-meeting'})).status).toBe(409);
 const abandoned=await request('/api/recording/abandon',{requestId:'keep-audio',meetingId:'unrecoverable-fixture'});
 expect(abandoned.status).toBe(200);expect(abandoned.body).toMatchObject({state:'idle',path:null,meetingId:null});expect(abandoned.body.revision).toBeGreaterThan(50);
 expect(readFileSync(wav,'utf8')).toBe('Synthetic truncated audio');
 const orphan=(await request('/api/recovery/list')).body.recordings.find((recording:any)=>recording.path===wav);
 expect(orphan).toMatchObject({path:wav,recoveryMeetingId:'unrecoverable-fixture',speakerNames:{'Speaker 1':'Ana'},segments:[{speaker:'Speaker 1'}]});
 expect((await request('/api/recording/retry',{requestId:'late-retry',meetingId:'unrecoverable-fixture'})).status).toBe(409);
 await restartApp();expect((await request('/api/recording/status')).body.state).toBe('idle');expect(readFileSync(wav,'utf8')).toBe('Synthetic truncated audio');
});
