import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Session, NotesJob } from "../../shared/types";

let directory: string;
let app: ReturnType<typeof Bun.spawn>;
let transport: ReturnType<typeof Bun.serve>;
let base: string;
let paused = false;
let available = true;
let generationStarts = 0;
let releases = 0;
let finishTranscription: (() => void) | undefined;
let lastPrompt = "";

async function until<T>(read: () => Promise<T>, check: (value: T) => boolean, milliseconds = 8000): Promise<T> {
 const deadline = Date.now() + milliseconds;
 while (Date.now() < deadline) {
  const value = await read();
  if (check(value)) return value;
  await Bun.sleep(30);
 }
 throw new Error("Timed out waiting for the isolated server");
}
const jsonRequest = async (path:string, body?:unknown, method = "POST", headers: Record<string,string> = {}) => {
 const response = await fetch(`${base}${path}`,{method,headers:{"Content-Type":"application/json",...headers},body:body === undefined ? undefined : JSON.stringify(body)});
 return {status:response.status,body:response.status === 403 ? null : await response.json()};
};
const list = async ():Promise<Session[]> => (await fetch(`${base}/api/sessions`)).json();
const currentJob = (session:Session):NotesJob|undefined => Object.values(session.notesJobs || {}).find(job => job.sourceRevision === session.transcriptRevision);
const get = async (id:string) => (await list()).find(session => session.id === id)!;

beforeAll(async () => {
 directory = mkdtempSync(join(tmpdir(),"heed-auto-http-"));
 transport = Bun.serve({hostname:"127.0.0.1",port:0,async fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === "/api/tags") return available ? Response.json({models:[{name:"fixture:1b"},{name:"remote:cloud"}]}) : new Response(null,{status:503});
  if (path === "/api/show") return Response.json({details:{family:"fixture"},capabilities:["completion"]});
  if (path === "/api/generate") {
   const input = await request.json() as {prompt:string;system:string;model:string};
   if (!input.prompt) { releases++; return Response.json({done:true}); }
   generationStarts++; lastPrompt = `${input.system}\n${input.prompt}`;
   if (paused) return new Response(new ReadableStream({start(controller) {controller.enqueue(new TextEncoder().encode('{"response":"Partial","done":false}\n'));}}));
   return new Response('{"response":"Grounded meeting notes","done":true}\n');
  }
  if (path === "/finalize") {
   await new Promise<void>(resolve => {finishTranscription=resolve;});
   return Response.json({finalized:true,language:"pt",model:"small",turns:[{speaker:"Ana",channel:"sys",text:"Bom dia",start:0,end:2}]});
  }
  return Response.json({whisper:true});
 }});
 const reservation = Bun.serve({hostname:"127.0.0.1",port:0,fetch:()=>new Response()});
 base = `http://127.0.0.1:${reservation.port}`;
 reservation.stop(true);
 app = Bun.spawn([process.execPath,resolve(import.meta.dir,"../server.ts")],{cwd:resolve(import.meta.dir,"../../.."),env:{...process.env,PORT:base.split(":").at(-1)!,HEED_APP_DIR:directory,OLLAMA_HOST:`http://127.0.0.1:${transport.port}`,HEED_TRANSCRIPTION_URL:`http://127.0.0.1:${transport.port}`},stdout:"ignore",stderr:"pipe"});
 await until(async () => { try {return (await fetch(`${base}/api/notes/settings`)).status;} catch {return 0;} },status=>status===200);
},10000);
afterAll(async () => {
 finishTranscription?.();
 app?.kill();
 if (app) await app.exited;
 transport?.stop(true);
 if (directory) rmSync(directory,{recursive:true,force:true});
});

test("HTTP settings default off, validate installed models, and block external origins", async () => {
 expect((await jsonRequest("/api/notes/settings",undefined,"GET")).body.enabled).toBe(false);
 expect((await jsonRequest("/api/notes/models",undefined,"GET")).body.models).toEqual(["fixture:1b"]);
 const chosen = {enabled:true,model:"fixture:1b",templateId:"general",language:"meeting"};
 expect((await jsonRequest("/api/notes/settings",{...chosen,model:"missing"},"PATCH")).status).toBe(400);
 expect((await jsonRequest("/api/notes/settings",chosen,"PATCH",{Origin:"https://outside.example"})).status).toBe(403);
 expect((await jsonRequest("/api/notes/settings",chosen,"PATCH")).status).toBe(200);
});

test("final speaker commit creates one durable job, using the final Portuguese input", async () => {
 const first = await jsonRequest("/api/sessions",{files:{wav:join(directory,"capture.wav")},transcriptFinalized:false,language:"pt",transcript:"Bom dia",speakers:["Speaker 1"],segments:[{speaker:"Speaker 1",channel:"sys",text:"Bom dia",start:0,end:2}]});
 expect(currentJob(first.body)).toBeUndefined();
 const final = await jsonRequest(`/api/sessions?id=${first.body.id}`,{transcriptFinalized:true,speakers:["Ana"],segments:[{speaker:"Ana",channel:"sys",text:"Bom dia",start:0,end:2}]},"PATCH");
 expect(Object.values(final.body.notesJobs)).toHaveLength(1);
 const complete = await until(()=>get(first.body.id),session=>currentJob(session)?.status === "completed");
 expect(complete.notesMetadata).toMatchObject({origin:"automatic",language:"pt",model:"fixture:1b",stale:false});
 expect(lastPrompt).toContain("Brazilian Portuguese");expect(lastPrompt).toContain("[Ana] Bom dia");
 const duplicate = await jsonRequest("/api/sessions",{...first.body,aiNotes:""});
 expect(duplicate.body.aiNotes).toBe(complete.aiNotes);
 expect(Object.values(duplicate.body.notesJobs)).toHaveLength(1);
});

test("recording transcription preempts and unloads notes, then resumes after its resource hold", async () => {
 paused = true;
 const initial = await jsonRequest("/api/sessions",{id:"preempt",transcriptFinalized:true,language:"en",transcript:"Keep this meeting",speakers:["Ana"],segments:[]});
 await until(()=>get(initial.body.id),session=>currentJob(session)?.status === "running" && currentJob(session)!.generatedCharacters > 0);
 const started = generationStarts;
 const processing = fetch(`${base}/api/transcribe`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({url:join(directory,"capture.wav"),recording_finalize:true})}).then(response=>response.text());
 await until(async()=>!!finishTranscription,Boolean);
 expect(releases).toBeGreaterThan(0);
 await Bun.sleep(1100);
 expect(generationStarts).toBe(started);
 expect(currentJob(await get("preempt"))?.status).toBe("waiting");
 paused = false;
 finishTranscription!();
 expect(await processing).toContain('"finalized":true');
 const complete = await until(()=>get("preempt"),session=>currentJob(session)?.status === "completed");
 expect(complete.aiNotes).toBe("Grounded meeting notes");
 expect(Object.values(complete.notesJobs || {})).toHaveLength(1);
});

test("manual edits reject stale saves and preserve notes after retranscription", async () => {
 const existing = await get("preempt");
 const manual = await jsonRequest("/api/sessions?id=preempt",{aiNotes:"Edited notes",expectedTranscriptRevision:existing.transcriptRevision,expectedNotes:existing.aiNotes},"PATCH");
 expect(manual.body.notesMetadata.origin).toBe("manual");
 expect((await jsonRequest("/api/sessions?id=preempt",{aiNotes:"Late result",expectedNotes:existing.aiNotes},"PATCH")).status).toBe(409);
 const changed = await jsonRequest("/api/sessions?id=preempt",{transcript:"Revised meeting"},"PATCH");
 expect(changed.body.aiNotes).toBe("Edited notes");expect(changed.body.notesMetadata.stale).toBe(true);
 expect(currentJob(changed.body)?.reason).toBe("existing-notes");
 const job = currentJob(changed.body)!;
 expect((await jsonRequest("/api/notes/jobs",{sessionId:"preempt",jobId:job.id,action:"retry"})).status).toBe(409);
 expect((await jsonRequest("/api/notes/jobs",{sessionId:"preempt",jobId:job.id,action:"retry",replaceExisting:true,expectedNotes:"Edited notes"})).status).toBe(200);
 await until(()=>get("preempt"),session=>currentJob(session)?.status === "completed");
});

test("unavailable Ollama fails only the notes and can be disabled while offline", async () => {
 available = false;
 const created = await jsonRequest("/api/sessions",{id:"offline",transcriptFinalized:true,language:"en",transcript:"Saved meeting",files:{wav:join(directory,"offline.wav")},speakers:[],segments:[]});
 expect(created.status).toBe(200);
 const failed = await until(()=>get("offline"),session=>currentJob(session)?.status === "failed");
 expect(failed.transcript).toBe("Saved meeting");expect(failed.files?.wav).toBe(join(directory,"offline.wav"));
 expect(currentJob(failed)?.reason).toBe("ollama-unavailable");expect(currentJob(failed)?.retryable).toBe(true);
 expect((await jsonRequest("/api/notes/settings",{enabled:false,model:"fixture:1b",templateId:"general",language:"meeting"},"PATCH")).status).toBe(200);
});

test("HTTP meeting and tag endpoints preserve notes guards and reject stale assignment patches", async () => {
 const created = await jsonRequest("/api/sessions", { id: "tags-http", transcript: "Synthetic source", aiNotes: "Manual notes", tags: [" Planning "] });
 expect(created.body.tags).toEqual(["Planning"]);
 expect(created.body.tagsRevision).toBeString();
 const tags = await jsonRequest("/api/tags", undefined, "GET");
 const loaded = tags.body.sessions.find((session: Session) => session.id === "tags-http");
 expect(loaded).toEqual(await get("tags-http"));
 expect(loaded.notesMetadata).toMatchObject({ origin: "manual", stale: false });
 expect((await jsonRequest("/api/sessions?id=tags-http", { tags: ["Changed"], aiNotes: "Lost" }, "PATCH")).status).toBe(409);
 const renamed = await jsonRequest("/api/tags", { action: "rename", tag: "Planning", name: "Décisions", expectedRevision: tags.body.revision });
 expect(renamed.status).toBe(200);
 expect((await get("tags-http"))).toMatchObject({ tags: ["Décisions"], aiNotes: "Manual notes", transcriptRevision: loaded.transcriptRevision });
 expect((await jsonRequest("/api/sessions?id=tags-http", { tags: [], tagsRevision: created.body.tagsRevision }, "PATCH")).status).toBe(409);
 const current = await get("tags-http");
 expect((await jsonRequest("/api/sessions?id=tags-http", { tags: [], tagsRevision: current.tagsRevision }, "PATCH")).status).toBe(200);
 expect((await jsonRequest("/api/sessions?id=tags-http", { aiNotes: "Edited notes", expectedNotes: "Manual notes", expectedTranscriptRevision: current.transcriptRevision }, "PATCH")).status).toBe(200);
});

test("HTTP session reads and writes fail closed when tag recovery cannot proceed", async () => {
 const journal = join(directory, "sessions", ".tag-transaction");
 mkdirSync(journal);
 try {
  expect((await jsonRequest("/api/sessions", undefined, "GET")).status).toBe(500);
  expect((await jsonRequest("/api/tags", undefined, "GET")).status).toBe(500);
  expect((await jsonRequest("/api/sessions?id=tags-http", { title: "Lost edit" }, "PATCH")).status).toBe(500);
  expect((await jsonRequest("/api/sessions?id=tags-http", undefined, "DELETE")).status).toBe(500);
 } finally { rmSync(journal, { recursive: true }); }
 expect((await get("tags-http")).title).not.toBe("Lost edit");
});
