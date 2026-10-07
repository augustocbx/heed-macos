import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AutomaticNotesService, notesHash } from "./automatic-notes";
import type { AutomaticNotesSettings } from "../../shared/types/notes";
import type { Session } from "../../shared/types/session";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture(overrides: Partial<ConstructorParameters<typeof AutomaticNotesService>[0]> = {}) {
 const sessionsDir = mkdtempSync(join(tmpdir(), "heed-notes-test-")); dirs.push(sessionsDir);
 const settings: AutomaticNotesSettings = { enabled: true, templateId: "meeting", model: "local:latest", language: "meeting" };
 const service = new AutomaticNotesService({ sessionsDir, getSettings: () => settings, loadTemplate: id => id === "meeting" ? { id, name: "Meeting", description: "", prompt: "Report only supported decisions." } : undefined, generate: async () => "## Decisions\nShip the agreed feature.", isBusy: () => false, ...overrides });
 return { service, settings, sessionsDir };
}
function meeting(extra: Partial<Session> = {}): Partial<Session> {
 return { title: "Synthetic meeting", language: "pt", transcript: "Vamos publicar a funcionalidade.", segments: [{ speaker: "Ana", start: 0, end: 2, text: "Vamos publicar a funcionalidade." }], speakers: ["Ana"], transcriptFinalized: true, files: { wav: "synthetic.wav" }, ...extra };
}
function job(session: Session) { return Object.values(session.notesJobs || {})[0]!; }
function deferred() { let resolve!: (value: string) => void; const promise = new Promise<string>(r => { resolve = r; }); return { promise, resolve }; }

test("enqueues only enabled saved final transcripts and never backfills legacy records", () => {
 const { service, settings, sessionsDir } = fixture();
 settings.enabled = false;
 expect(service.create(meeting()).notesJobs).toBeUndefined();
 settings.enabled = true;
 const live = service.create(meeting({ files: { wav: "live.wav" }, transcriptFinalized: false }));
 expect(live.notesJobs).toBeUndefined();
 const final = service.patch(live.id, { transcriptFinalized: true });
 expect(job(final)).toMatchObject({ status: "queued", language: "pt", templateName: "Meeting", attempts: 0 });
 writeFileSync(join(sessionsDir, "legacy.json"), JSON.stringify({ ...meeting(), id: "legacy", transcriptFinalized: undefined }));
 service.recover();
 expect(service.get("legacy")!.notesJobs).toBeUndefined();
 expect(service.patch("legacy", { title: "Rename" }).notesJobs).toBeUndefined();
});
test("recording identity survives duplicate POSTs and protects newer notes and transcript", async () => {
 const { service } = fixture();
 const first = service.create(meeting({ transcriptFinalized: false }));
 const final = service.patch(first.id, { transcriptFinalized: true });
 await service.tick();
 const saved = service.get(final.id)!;
 expect(service.create(meeting({ transcript: "old", aiNotes: "", transcriptFinalized: false }))).toEqual(saved);
 expect(service.list()).toHaveLength(1);
 expect(Object.keys(saved.notesJobs!)).toHaveLength(1);
});
test("completion saves provenance and metadata cannot be injected by ordinary updates", async () => {
 const { service } = fixture(); const session = service.create(meeting());
 await service.tick();
 const saved = service.get(session.id)!;
 expect(job(saved).status).toBe("completed");
 expect(saved.notesMetadata).toMatchObject({ origin: "automatic", sourceRevision: saved.transcriptRevision, templateName: "Meeting", model: "local:latest", stale: false });
 const renamed = service.patch(session.id, { title: "Rename", notesJobs: {}, notesMetadata: { origin: "manual", stale: true, sourceRevision: "forged" }, transcriptRevision: "forged" });
 expect(renamed.notesMetadata).toEqual(saved.notesMetadata);
 expect(renamed.notesJobs).toEqual(saved.notesJobs);
});
test("manual edits and speaker revisions reject late generated results", async () => {
 const pending = deferred(); const { service } = fixture({ generate: () => pending.promise });
 const session = service.create(meeting()); const run = service.tick();
 service.patch(session.id, { aiNotes: "Manually written", expectedTranscriptRevision: session.transcriptRevision, expectedNotes: "" });
 pending.resolve("Late automatic notes"); await run;
 const manual = service.get(session.id)!;
 expect(manual.aiNotes).toBe("Manually written"); expect(manual.notesMetadata!.origin).toBe("manual");
 const revised = service.patch(session.id, { speakers: ["Beatriz"], segments: [{ speaker: "Beatriz", start: 0, end: 2, text: session.transcript }] });
 expect(revised.notesMetadata!.stale).toBe(true);
 expect(Object.values(revised.notesJobs!)).toHaveLength(2);
 expect(Object.values(revised.notesJobs!).every(j => j.status !== "running")).toBe(true);
 expect(() => service.patch(session.id, { aiNotes: "Wrong source", expectedTranscriptRevision: session.transcriptRevision })).toThrow("Transcript changed");
 expect(() => service.patch(session.id, { aiNotes: "Wrong notes", expectedNotes: "other" })).toThrow("Notes changed");
});
test("existing notes require explicit replacement with matching notes hash", async () => {
 const { service } = fixture(); const session = service.create(meeting({ aiNotes: "Existing notes" }));
 expect(job(session).status).toBe("failed");
 expect(() => service.retry(session.id, { replaceExisting: true, expectedNotesHash: notesHash("wrong") })).toThrow("Notes changed");
 expect(() => service.retry(session.id)).toThrow("Existing notes");
 const retried = service.retry(session.id, { replaceExisting: true, expectedNotesHash: notesHash("Existing notes") });
 expect(job(retried).id).toBe(job(session).id);
 await service.tick(); expect(service.get(session.id)!.aiNotes).toContain("Decisions");
});
test("failed configuration is durable, retry refreshes corrected model/template, and no fallback is used", async () => {
 const { service, settings } = fixture(); settings.templateId = "removed"; settings.model = null;
 const session = service.create(meeting());
 expect(job(session)).toMatchObject({ status: "failed", retryable: true, templateId: "removed", templatePrompt: "" });
 expect(readFileSync(join(service.sessionsDir, `${session.id}.json`), "utf8")).toContain("template-missing");
 settings.templateId = "meeting"; settings.model = "fixed:latest";
 const retry = service.retry(session.id); expect(job(retry).id).toBe(job(session).id); expect(job(retry).model).toBe("fixed:latest");
 await service.tick(); expect(service.get(session.id)!.notesMetadata!.model).toBe("fixed:latest");
});
test("preemption yields resources, preserves job identity, and waits for capture to finish", async () => {
 let busy = false; let calls = 0;
 const { service } = fixture({ isBusy: () => busy, generate: ({ signal }) => { calls++; return new Promise((_r, reject) => signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true })); } });
 const session = service.create(meeting()); const run = service.tick(); busy = true; await service.preempt(); await run;
 expect(job(service.get(session.id)!)).toMatchObject({ id: job(session).id, status: "waiting", generatedCharacters: 0 });
 await service.tick(); expect(calls).toBe(1);
 busy = false; const next = service.tick(); await service.preempt(); await next; expect(calls).toBe(2);
});
test("one worker, cancellation, and restart do not duplicate jobs or commit cancelled output", async () => {
 const pending = deferred(); const { service, sessionsDir } = fixture({ generate: () => pending.promise });
 const first = service.create(meeting()); service.create(meeting({ files: { wav: "second.wav" } }));
 const run = service.tick(); await service.tick(); const running = service.list().find(s => job(s).status === "running")!; expect(job(running).attempts).toBe(1);
 service.cancel(running.id); pending.resolve("Cancelled output"); await run;
 expect(service.get(running.id)!.aiNotes).toBe(""); expect(job(service.get(running.id)!).status).toBe("cancelled");
 const stored = service.list().find(s => s.id !== running.id)!; job(stored).status = "running"; writeFileSync(join(sessionsDir, `${stored.id}.json`), JSON.stringify(stored));
 service.recover(); expect(job(service.get(stored.id)!).status).toBe("waiting");
});
test("disabled settings pause queued work, busy resources pause it, and unsafe IDs never escape storage", async () => {
 let busy = true; const { service, settings } = fixture({ isBusy: () => busy }); const session = service.create(meeting());
 await service.tick(); expect(job(service.get(session.id)!).status).toBe("waiting");
 busy = false; settings.enabled = false; await service.tick(); expect(service.get(session.id)!.aiNotes).toBe("");
 for (const id of ["../outside", "/absolute", ".", "a/b", "a\\b"]) expect(() => service.get(id)).toThrow("Invalid session id");
 expect(service.delete(session.id)).toBe(true); expect(service.get(session.id)).toBeNull();
});
test("incomplete source and unsupported language persist retryable failures independently of recording", () => {
 const { service } = fixture();
 expect(job(service.create(meeting({ transcript: "", segments: [] })))).toMatchObject({ status: "failed", reason: "transcript-empty" });
 expect(job(service.create(meeting({ files: { wav: "unsupported.wav" }, language: "es" })))).toMatchObject({ status: "failed", reason: "language-unsupported" });
});
test("speaker channel changes supersede notes and minimal legacy sessions can be renamed safely", async () => {
 const { service, sessionsDir } = fixture(); const first = service.create(meeting()); await service.tick();
 const changed = service.patch(first.id, { segments: first.segments.map(segment => ({ ...segment, channel: "mic" })) });
 expect(changed.transcriptRevision).not.toBe(first.transcriptRevision); expect(changed.notesMetadata!.stale).toBe(true);
 writeFileSync(join(sessionsDir, "minimal.json"), JSON.stringify({ id: "minimal", transcript: "Legacy", aiNotes: "", language: "en" }));
 expect(service.patch("minimal", { title: "Minimal legacy" }).title).toBe("Minimal legacy");
});
test("session reads reject symlinks outside the session directory", () => {
 const { service, sessionsDir } = fixture(); const outside = mkdtempSync(join(tmpdir(), "heed-outside-test-")); dirs.push(outside);
 const target = join(outside, "private.json"); writeFileSync(target, JSON.stringify(meeting()));
 require("node:fs").symlinkSync(target, join(sessionsDir, "linked.json"));
 expect(() => service.get("linked")).toThrow("Invalid session file"); expect(service.list()).toHaveLength(0);
});
test("transport failures are persisted with stable reasons and retry reuses the logical job", async () => {
 let unavailable = true; const { service } = fixture({ generate: async () => { if (unavailable) throw new Error("Synthetic transport private detail"); return "Successful retry"; } });
 const session = service.create(meeting()); await service.tick();
 expect(job(service.get(session.id)!)).toMatchObject({ status: "failed", reason: "generation-failed", attempts: 1, retryable: true });
 unavailable = false; const retry = service.retry(session.id); expect(job(retry).id).toBe(job(session).id);
 await service.tick(); expect(job(service.get(session.id)!)).toMatchObject({ status: "completed", attempts: 2 });
});
test("duplicate recording posts with different client IDs still return the original saved session", async () => {
 const { service } = fixture(); const original = service.create(meeting({ id: "client-original" })); await service.tick();
 const duplicate = service.create(meeting({ id: "client-retry", aiNotes: "", transcript: "Old retry" }));
 expect(duplicate.id).toBe(original.id); expect(duplicate.aiNotes).toContain("Decisions"); expect(service.list()).toHaveLength(1);
});
test("legacy notes receive revision guards without backfill and become stale after source edits", () => {
 const { service, sessionsDir } = fixture();
 const legacy = { ...meeting(), id: "legacy-notes", aiNotes: "Saved legacy notes", transcriptFinalized: undefined };
 writeFileSync(join(sessionsDir, "legacy-notes.json"), JSON.stringify(legacy));
 const loaded = service.get("legacy-notes")!;
 expect(loaded.transcriptRevision).toBeString();
 expect(loaded.notesMetadata).toMatchObject({ origin: "manual", sourceRevision: loaded.transcriptRevision, stale: false });
 expect(loaded.notesJobs).toBeUndefined();
 const changed = service.patch(loaded.id, { transcript: "Updated authoritative transcript" });
 expect(changed.notesMetadata!.stale).toBe(true); expect(changed.notesJobs).toBeUndefined();
 expect(() => service.patch(loaded.id, { aiNotes: "Late manual result", expectedTranscriptRevision: loaded.transcriptRevision, expectedNotes: loaded.aiNotes })).toThrow("Transcript changed");
 expect(service.get(loaded.id)!.aiNotes).toBe("Saved legacy notes");
});
test("restart completes the recovered job and rejects the previous worker result", async () => {
 const pending = deferred(); const initial = fixture({ generate: () => pending.promise });
 const saved = initial.service.create(meeting()); const oldRun = initial.service.tick();
 const recovered = new AutomaticNotesService({ sessionsDir: initial.sessionsDir, getSettings: () => initial.settings, loadTemplate: id => ({ id, name: "Meeting", description: "", prompt: "Saved prompt" }), generate: async () => "Recovered complete notes", isBusy: () => false });
 recovered.recover(); await recovered.tick();
 pending.resolve("Old interrupted worker output"); await oldRun;
 const result = recovered.get(saved.id)!;
 expect(result.aiNotes).toBe("Recovered complete notes"); expect(job(result)).toMatchObject({ id: job(saved).id, status: "completed", attempts: 2 }); expect(Object.values(result.notesJobs!)).toHaveLength(1);
});
test("queued custom prompts remain immutable while output language respects every supported preference", async () => {
 for (const language of ["en", "pt", "fr", "de"] as const) {
  let prompt = "Use custom headings and distinguish uncertainty.";
  const observed: { prompt: string; language: string }[] = [];
  const { service, settings } = fixture({ loadTemplate: id => ({ id, name: "Custom", description: "", prompt }), generate: async ({ job }) => { observed.push({ prompt: job.templatePrompt, language: job.language }); return `Generated notes in ${job.language}`; } });
  settings.language = language;
  const saved = service.create(meeting()); prompt = "Modified after enqueue"; await service.tick();
  expect(observed).toEqual([{ prompt: "Use custom headings and distinguish uncertainty.", language }]);
  expect(service.get(saved.id)!.notesMetadata).toMatchObject({ templateName: "Custom", templateHash: notesHash("Use custom headings and distinguish uncertainty."), language });
 }
});
test("undoing a speaker revision requeues the same superseded job identity", async () => {
 const { service } = fixture(); const initial = service.create(meeting());
 service.patch(initial.id, { speakers: ["Beatriz"], segments: initial.segments.map(segment => ({ ...segment, speaker: "Beatriz" })) });
 const undo = service.patch(initial.id, { speakers: initial.speakers, segments: initial.segments });
 expect(undo.transcriptRevision).toBe(initial.transcriptRevision);
 expect(undo.notesJobs![job(initial).id]!.status).toBe("queued");
 await service.tick(); expect(service.get(initial.id)!.aiNotes).toContain("Decisions");
 expect(service.get(initial.id)!.notesJobs![job(initial).id]!.status).toBe("completed");
});
test("undoing source edits restores freshness when saved notes match their source revision", async () => {
 const { service } = fixture(); const initial = service.create(meeting()); await service.tick();
 const before = service.get(initial.id)!;
 expect(service.patch(initial.id, { transcript: "New source" }).notesMetadata!.stale).toBe(true);
 const undone = service.patch(initial.id, { transcript: initial.transcript });
 expect(undone.notesMetadata!.stale).toBe(false); expect(undone.aiNotes).toBe(before.aiNotes);
 expect(undone.notesJobs![job(initial).id]!.status).toBe("completed");
});

test('notes waiting status reflects resource changes without changing durable source or job data',()=>{
 let blocker:'tasks'|'recording'='tasks';const {service,sessionsDir}=fixture({isBusy:()=>true,waitingReason:()=>blocker});const source=service.create(meeting());
 const file=join(sessionsDir,`${source.id}.json`),bytes=readFileSync(file,'utf8');expect(job(service.get(source.id)!)).toMatchObject({waitingReason:'tasks'});
 blocker='recording';const next=service.get(source.id)!;expect(job(next)).toMatchObject({waitingReason:'recording'});expect(next.transcriptRevision).toBe(source.transcriptRevision);expect(readFileSync(file,'utf8')).toBe(bytes);
});
