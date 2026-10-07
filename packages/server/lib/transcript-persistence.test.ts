import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Session } from "../../shared/types/session";
import type { TranscriptGuard, TextOnlyCommand } from "../../shared/types/transcript-editing";
import { SessionTags, atomicWrite, sessionResponse } from "./session-tags";
import { AutomaticNotesService, sourceRevision } from "./automatic-notes";
import { setAtomicWriteBudget } from "./atomic-json";
import { transcriptEvidence } from "./meeting-chat";
import { MeetingTasksService } from "./meeting-tasks";

const directories: string[] = [];
afterEach(() => { setAtomicWriteBudget(undefined); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const now = "2026-10-06T12:00:00Z";
function meeting(): Session {
 return { id: "meeting", title: "Meeting", createdAt: now, language: "pt", duration: 2, transcript: "Original\nOutro", speakers: ["Ana"],
  segments: [{ speaker: "Ana", start: 0, end: 1, text: "Original", auto: true, channel: "mic", attribution: "fallback" }, { speaker: "Ana", start: 1, end: 2, text: "Outro" }],
  embeddings: { Ana: [1, 2] }, transcriptFinalized: true, aiNotes: "", summary: "", tags: ["Work"], pinned: false, files: { wav: "synthetic.wav" } };
}
function fixture() {
 const directory = mkdtempSync(join(tmpdir(), "heed-transcript-persistence-")); directories.push(directory);
 let failed = false, writes = 0;
 const store = new SessionTags(directory, { writeAtomic(path, data) { if (failed) throw Error("Synthetic disk full"); writes++; atomicWrite(path, data); } });
 const settings = { enabled: false, templateId: "meeting", model: "local", language: "meeting" as const };
 const options = { sessionsDir: directory, sessionStore: store, getSettings: () => settings, loadTemplate: () => ({ id: "meeting", name: "Meeting", description: "", prompt: "Use evidence" }), generate: async () => "Generated", isBusy: () => false };
 const service = new AutomaticNotesService(options);
 return { directory, store, service, settings, options, fail(value = true) { failed = value; }, writes: () => writes, bytes: () => readFileSync(join(directory, "meeting.json"), "utf8") };
}
const guard = (session: Session): TranscriptGuard => ({ expectedTranscriptRevision: sourceRevision(session), expectedTranscriptVersion: session.transcriptVersion ?? 0 });
const command = (session: Session, text = "Corrected", requestId = "edit"): TextOnlyCommand => ({ ...guard(session), requestId, action: "edit", target: { kind: "segment", index: 0 }, text });

test("initial creation owns version and duplicate recovery never replaces corrections", () => {
 const f = fixture(); const original = f.service.create({ ...meeting(), transcriptVersion: 90, transcriptRevision: "forged" });
 expect(original.transcriptVersion).toBe(1); expect(original.transcriptRevision).toBe(sourceRevision(original));
 const corrected = f.service.commitTranscript(original.id, command(original));
 expect(f.service.create({ ...meeting(), transcript: "Stale recovery", id: "different-id" })).toEqual(corrected);
 expect(f.service.create(meeting())).toEqual(corrected); expect(f.store.snapshot().sessions).toHaveLength(1);
});
test("source patches require both guards while title and pin remain independent", () => {
 const f = fixture(); const original = f.service.create(meeting()); const bytes = f.bytes();
 expect(() => f.service.patch(original.id, { speakers: ["Bob"], segments: original.segments.map(s => ({ ...s, speaker: "Bob" })) })).toThrow();
 expect(() => f.service.patch(original.id, { speakers: ["Bob"], expectedTranscriptRevision: original.transcriptRevision })).toThrow();
 expect(f.bytes()).toBe(bytes);
 expect(f.service.patch(original.id, { title: "Title", pinned: true })).toMatchObject({ title: "Title", pinned: true, transcriptVersion: 1, transcript: original.transcript });
});
test("two competing source guards commit once and retain latest unrelated metadata", () => {
 const f = fixture(); const original = f.service.create(meeting()); f.service.patch(original.id, { title: "Renamed" });
 const accepted = f.service.commitTranscript(original.id, command(original));
 expect(accepted).toMatchObject({ title: "Renamed", transcript: "Corrected\nOutro", transcriptVersion: 2 });
 const bytes = f.bytes();
 expect(() => f.service.commitTranscript(original.id, command(original, "Second", "second"))).toThrow("Transcript changed");
 expect(f.bytes()).toBe(bytes); expect(accepted.transcriptEditing?.edits).toHaveLength(1);
});
test("durable journal receipts acknowledge retries after reload and ABA without duplicate edits", () => {
 const f = fixture(); const original = f.service.create(meeting()); const request = command(original);
 const first = f.service.commitTranscript(original.id, request); const reloaded = new AutomaticNotesService(f.options); const before = f.bytes();
 expect(reloaded.commitTranscript(original.id, request)).toEqual(reloaded.get(original.id)!); expect(f.bytes()).toBe(before);
 const reverted = reloaded.commitTranscript(original.id, { ...guard(first), requestId: "undo", action: "revert", editId: first.transcriptEditing!.edits[0]!.id });
 expect(reverted.transcriptRevision).toBe(original.transcriptRevision); expect(reverted.transcriptVersion).toBe(3);
 const latest = reloaded.commitTranscript(original.id, request);
 expect(latest.transcript).toBe(original.transcript); expect(latest.transcriptEditing?.edits).toHaveLength(2);
 expect(() => reloaded.commitTranscript(original.id, command(original, "Different", "other"))).toThrow("Transcript changed");
 expect(() => reloaded.commitTranscript(original.id, command(original, "Different", request.requestId))).toThrow();
 expect(JSON.stringify(latest.transcriptEditing?.edits)).not.toContain('"title"');
});
test("direct saves and generic patches cannot change server-owned recovery state", () => {
 const f = fixture(); const original = f.service.create(meeting()); const corrected = f.service.commitTranscript(original.id, command(original)); const bytes = f.bytes();
 expect(() => f.store.save({ ...original, title: "Old source snapshot" })).toThrow();
 expect(() => f.store.save({ ...corrected, transcriptEditing: undefined })).toThrow(); expect(f.bytes()).toBe(bytes);
 const patched = f.service.patch(original.id, { title: "Allowed", transcriptVersion: 100, transcriptRevision: "forged", transcriptEditing: undefined, notesMetadata: { sourceRevision: "forged", origin: "manual", stale: false }, notesJobs: {} });
 expect(patched.transcriptVersion).toBe(2); expect(patched.transcriptEditing).toEqual(corrected.transcriptEditing); expect(patched.notesMetadata).toEqual(corrected.notesMetadata);
 expect(() => f.service.patch(original.id, { ...guard(patched), transcript: "Bypass journal" })).toThrow();
 expect(() => f.service.patch(original.id, { ...guard(patched), segments: patched.segments.map(s => ({ ...s, text: "Bypass" })) })).toThrow();
});
test("speaker-only patches retain original recognition and corrections while bumping the version", () => {
 const f = fixture(); const original = f.service.create(meeting()); const corrected = f.service.commitTranscript(original.id, command(original));
 const renamed = f.service.patch(original.id, { ...guard(corrected), speakers: ["Alice"], segments: corrected.segments.map(s => ({ ...s, speaker: "Alice", auto: false })), embeddings: { Alice: [1, 2] } });
 expect(renamed.transcriptVersion).toBe(3); expect(renamed.transcript).toBe("Corrected\nOutro"); expect(renamed.transcriptEditing).toEqual(corrected.transcriptEditing);
 expect(renamed.segments[0]).toMatchObject({ speaker: "Alice", auto: false, channel: "mic", attribution: "fallback" });
});
test("metadata writers preserve history, local candidates and local version", () => {
 const f = fixture(); const original = f.service.create(meeting()); const corrected = f.service.commitTranscript(original.id, command(original));
 const staged = f.store.commitTranscriptState(original.id, current => ({ ...current, transcriptEditing: { ...current.transcriptEditing!, candidates: [{ ...current.transcriptEditing!.generations[0]!, id: "candidate", requestId: "stage", requestSignature: "stage-signature", baseGuard: guard(current) }] } }));
 f.store.mutate({ action: "add", tag: "New", sessionId: original.id, expectedRevision: f.store.snapshot().revision });
 f.service.patch(original.id, { title: "Metadata", pinned: true });
 const saved = f.store.save({ ...f.store.read(original.id)!, files: { wav: "" }, audioArchived: true });
 expect(saved.transcriptEditing).toEqual(staged.transcriptEditing); expect(saved.transcriptVersion).toBe(corrected.transcriptVersion); expect(saved.transcriptRevision).toBe(corrected.transcriptRevision);
 expect(saved).toMatchObject({ title: "Metadata", pinned: true, audioArchived: true, tags: ["Work", "New"] });
 expect(() => f.store.commitTranscriptState(original.id, current => ({ ...current, transcript: "Not metadata" }))).toThrow();
});
test("write and managed quota failures preserve exact file, history, version and active source", () => {
 const f = fixture(); const original = f.service.create(meeting()); const bytes = f.bytes(), writes = f.writes();
 f.fail(); expect(() => f.service.commitTranscript(original.id, command(original))).toThrow("Synthetic disk full"); expect(f.bytes()).toBe(bytes);
 f.fail(false); setAtomicWriteBudget(() => { throw Error("Synthetic quota exhausted"); });
 expect(() => f.service.commitTranscript(original.id, command(original))).toThrow("quota"); expect(f.bytes()).toBe(bytes);
 expect(f.service.get(original.id)).toEqual(original); expect(f.writes()).toBe(writes + 1);
});
test("one successful source commit is one atomic write and refuses monotonic overflow", () => {
 const f = fixture(); const original = f.service.create(meeting()); const before = f.writes(); f.service.commitTranscript(original.id, command(original)); expect(f.writes()).toBe(before + 1);
 const current = f.service.get(original.id)!; writeFileSync(join(f.directory, "meeting.json"), JSON.stringify({ ...current, transcriptVersion: Number.MAX_SAFE_INTEGER }));
 const bytes = f.bytes(); expect(() => f.service.commitTranscript(original.id, command(f.service.get(original.id)!, "Next", "overflow"))).toThrow(); expect(f.bytes()).toBe(bytes);
});
test("accepted portable-size overflow and changed local transcript state fail before writing", () => {
 const f = fixture(); const original = f.service.create(meeting()), bytes = f.bytes(), writes = f.writes();
 expect(() => f.service.replaceAccepted(original.id, guard(original), current => ({ ...current, language: "en", aiNotes: "x".repeat(16_000_000) }))).toThrow("size limit");
 expect(f.bytes()).toBe(bytes); expect(f.writes()).toBe(writes);
 const changed = f.service.replaceAccepted(original.id, guard(original), current => ({ ...current, transcriptionModel: "replacement-model" }));
 expect(changed.transcriptRevision).toBe(original.transcriptRevision); expect(changed.transcriptVersion).toBe(2);
 expect(() => f.service.commitTranscript(original.id, command(original))).toThrow("Transcript changed");
});
test("unchanged commands make no write and notes progress/completion preserve candidate metadata", async () => {
 const f = fixture(); f.settings.enabled = true; let complete!: (value: string) => void;
 const service = new AutomaticNotesService({ ...f.options, generate: async input => { input.onProgress(200); return new Promise<string>(resolve => { complete = resolve; }); } });
 const original = service.create(meeting()), writes = f.writes();
 const unchanged = service.commitTranscript(original.id, command(original, "Original", "noop"));
 expect(unchanged.transcriptVersion).toBe(1); expect(unchanged.transcriptEditing).toBeUndefined(); expect(f.writes()).toBe(writes);
 const corrected = service.commitTranscript(original.id, command(original));
 const staged = f.store.commitTranscriptState(original.id, current => ({ ...current, transcriptEditing: { ...current.transcriptEditing!, candidates: [{ ...current.transcriptEditing!.generations[0]!, id: "candidate", requestId: "stage", requestSignature: "stage-signature", baseGuard: guard(current) }] } }));
 const run = service.tick();
 expect(service.get(original.id)?.notesJobs?.[`notes-${corrected.transcriptRevision}`]?.generatedCharacters).toBe(200);
 service.patch(original.id, { title: "Changed during generation" }); complete("Current source notes"); await run;
 const saved = service.get(original.id)!;
 expect(saved.transcriptEditing).toEqual(staged.transcriptEditing); expect(saved.transcriptVersion).toBe(2); expect(saved.title).toBe("Changed during generation");
 expect(saved.notesMetadata).toMatchObject({ sourceRevision: corrected.transcriptRevision, stale: false, origin: "automatic" });
});
test("trusted replacement archives exact old source and keeps corrections and candidates", () => {
 const f = fixture(); const original = f.service.create(meeting()); const corrected = f.service.commitTranscript(original.id, command(original));
 const replaced = f.service.replaceAccepted(original.id, guard(corrected), current => ({ ...current, transcript: "New recognition", segments: [{ speaker: "New", start: 0, end: 2, text: "New recognition", attribution: "fallback" }], speakers: ["New"], transcriptionModel: "new-model" }));
 expect(replaced.transcriptVersion).toBe(3); expect(replaced.transcriptEditing?.generations).toHaveLength(2); expect(replaced.transcriptEditing?.edits).toEqual(corrected.transcriptEditing?.edits);
 expect(replaced.transcriptEditing?.generations[0]?.transcript).toBe(original.transcript); expect(replaced.transcriptEditing?.generations[1]?.transcript).toBe("New recognition");
 expect(() => f.store.commitSource(original.id, null, () => original)).toThrow();
});
test("legacy notes remain explicitly unknown across reads and accepted corrections", () => {
 const f = fixture(); const legacy = { ...meeting(), aiNotes: "Legacy notes" }; writeFileSync(join(f.directory, "meeting.json"), JSON.stringify(legacy)); const bytes = f.bytes();
 const loaded = f.service.get(legacy.id)!; expect(loaded.notesMetadata).toMatchObject({ sourceRevision: null, stale: true }); expect(loaded.transcriptVersion).toBe(0); expect(f.bytes()).toBe(bytes);
 const corrected = f.service.commitTranscript(legacy.id, command(loaded)); expect(corrected.notesMetadata).toMatchObject({ sourceRevision: null, stale: true }); expect(corrected.aiNotes).toBe("Legacy notes");
});
test("a failed correction does not abort a held generator or falsely publish staleness", async () => {
 const f = fixture(); f.settings.enabled = true; let complete!: (value: string) => void, signal!: AbortSignal;
 const service = new AutomaticNotesService({ ...f.options, generate: async input => { signal = input.signal; return new Promise<string>(resolve => { complete = resolve; }); } });
 const original = service.create(meeting()); const run = service.tick(); const bytes = f.bytes();
 f.fail(); expect(() => service.commitTranscript(original.id, command(original))).toThrow("Synthetic disk full"); expect(signal.aborted).toBe(false); expect(f.bytes()).toBe(bytes);
 f.fail(false); complete("Original source notes"); await run; expect(service.get(original.id)!.aiNotes).toBe("Original source notes");
});
test("correction supersedes held notes output and derived evidence stays bound to the old source", async () => {
 const f = fixture(); f.settings.enabled = true; let complete!: (value: string) => void, signal!: AbortSignal;
 const service = new AutomaticNotesService({ ...f.options, generate: async input => { signal = input.signal; return new Promise<string>(resolve => { complete = resolve; }); } });
 const original = service.create(meeting()), evidence = transcriptEvidence(original)[0]!; const run = service.tick();
 const corrected = service.commitTranscript(original.id, command(original)); expect(signal.aborted).toBe(true);
 expect(corrected.notesJobs?.[`notes-${original.transcriptRevision}`]?.status).toBe("superseded"); expect(evidence.sourceRevision).not.toBe(corrected.transcriptRevision);
 complete("Late notes must not commit"); await run; expect(service.get(original.id)!.aiNotes).toBe(""); expect(service.get(original.id)!.transcript).toBe("Corrected\nOutro");
 const tasks = new MeetingTasksService({ path: join(f.directory, "tasks.json"), getSession: () => service.get(original.id), listSessions: () => service.list(), generate: async () => "{}", isBusy: () => false });
 const tasksPath = join(f.directory, "tasks.json");
 writeFileSync(tasksPath, JSON.stringify({ version: 1, reviews: {}, decisions: {}, tasks: [{ id: "task", revision: "r", sessionId: original.id, sourceRevision: original.transcriptRevision, title: "Old task", description: "", assignee: null, dueDate: null, evidence: [], kind: "explicit", status: "open", completedAt: null, createdAt: now, updatedAt: now }] }));
 expect(tasks.snapshot().tasks[0]?.sourceState).toBe("transcript-changed");
});
test("HTTP source patch rejection leaves metadata-only requests usable", async () => {
 const f = fixture(); const original = f.service.create(meeting());
 const patch = (body: unknown) => sessionResponse(new Request(`http://localhost/api/sessions?id=${original.id}`, { method: "PATCH", body: JSON.stringify(body) }), f.store);
 expect((await patch({ speakers: ["Bob"] })).status).toBe(400); expect((await patch({ title: "HTTP title" })).status).toBe(200);
 expect(f.service.get(original.id)).toMatchObject({ transcript: original.transcript, title: "HTTP title", transcriptVersion: 1 });
});
test("the accepted-source boundary itself supersedes old work and marks unchanged notes stale", () => {
 const f = fixture(); f.settings.enabled = true; const original = f.service.create(meeting());
 const renamed = f.store.patch(original.id, { ...guard(original), speakers: ["Alice"], segments: original.segments.map(s => ({ ...s, speaker: "Alice" })) });
 expect(renamed.notesJobs?.[`notes-${original.transcriptRevision}`]?.status).toBe("superseded");
 f.store.save({ ...renamed, aiNotes: "Known notes", notesMetadata: { sourceRevision: renamed.transcriptRevision!, origin: "manual", stale: false } });
 const changed = f.store.commitSource(original.id, guard(renamed), current => ({ ...current!, language: "en" }));
 expect(changed.notesMetadata).toMatchObject({ sourceRevision: renamed.transcriptRevision, stale: true });
});
test("a nonhash source transition binds new work to its exact committed version and discards held old output", async () => {
 const f = fixture(); f.settings.enabled = true; let finish!: (value: string) => void, calls = 0;
 const service = new AutomaticNotesService({ ...f.options, generate: async () => ++calls === 1 ? new Promise<string>(resolve => { finish = resolve; }) : "New version notes" });
 const original = service.create(meeting()); const run = service.tick();
 const replaced = service.replaceAccepted(original.id, guard(original), current => ({ ...current, transcriptionModel: "new-model" }));
 expect(replaced.transcriptRevision).toBe(original.transcriptRevision); expect(replaced.transcriptVersion).toBe(2);
 expect(replaced.notesJobs?.[`notes-${replaced.transcriptRevision}`]).toMatchObject({ sourceVersion: 2, status: "queued" });
 finish("Old model notes"); await run; expect(service.get(original.id)?.aiNotes).toBe("");
 await service.tick(); expect(service.get(original.id)?.aiNotes).toBe("New version notes");
});
test("a separate writer's hash ABA cannot revive a held worker or erase history", async () => {
 const f = fixture(); f.settings.enabled = true; let finish!: (value: string) => void;
 const worker = new AutomaticNotesService({ ...f.options, generate: async () => new Promise<string>(resolve => { finish = resolve; }) });
 const original = worker.create(meeting()); const run = worker.tick(); const writer = new AutomaticNotesService(f.options);
 const corrected = writer.commitTranscript(original.id, command(original));
 const reverted = writer.commitTranscript(original.id, { ...guard(corrected), requestId: "undo", action: "revert", editId: corrected.transcriptEditing!.edits[0]!.id });
 expect(reverted.transcriptRevision).toBe(original.transcriptRevision); expect(reverted.transcriptVersion).toBe(3);
 expect(reverted.notesJobs?.[`notes-${reverted.transcriptRevision}`]).toMatchObject({ sourceVersion: 3, status: "queued" });
 finish("Late ABA output"); await run; expect(writer.get(original.id)?.aiNotes).toBe(""); expect(writer.get(original.id)?.transcriptEditing?.edits).toHaveLength(2);
});
