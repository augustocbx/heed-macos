import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AutomaticNotesService, type NotesGenerationInput } from "./automatic-notes";
import { SessionTags, atomicWrite, tagResponse } from "./session-tags";

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true })));
function fixture(generate: (input: NotesGenerationInput) => Promise<string> = async () => "Generated notes") {
 const directory = mkdtempSync(join(tmpdir(), "heed-notes-tags-")); directories.push(directory);
 let fail = false;
 const tags = new SessionTags(directory, { writeAtomic: (path, data) => { if (fail) throw new Error("Synthetic storage failure"); atomicWrite(path, data); } });
 const notes = new AutomaticNotesService({ sessionsDir: directory, sessionStore: tags, getSettings: () => ({ enabled: true, templateId: "meeting", model: "local", language: "meeting" }), loadTemplate: id => ({ id, name: "Meeting", description: "", prompt: "Summarize" }), isBusy: () => false, generate });
 const meeting = notes.create({ id: "meeting", title: "Meeting", transcript: "Agreed decision", language: "en", transcriptFinalized: true, tags: ["Planning"] });
 return { directory, notes, tags, meeting, fail: () => { fail = true; }, restore: () => { fail = false; } };
}
test("note progress and completion retain global tag renames and deletions", async () => {
 let finish!: (text: string) => void;
 let progress!: NotesGenerationInput["onProgress"];
 const f = fixture(input => { progress = input.onProgress; return new Promise(resolve => { finish = resolve; }); });
 const run = f.notes.tick();
 f.tags.mutate({ action: "rename", tag: "Planning", name: "Décisions", expectedRevision: f.tags.snapshot().revision });
 progress(20);
 expect(f.notes.get("meeting")!.tags).toEqual(["Décisions"]);
 f.tags.mutate({ action: "delete", tag: "Décisions", expectedRevision: f.tags.snapshot().revision });
 const revision = f.tags.read("meeting")!.tagsRevision;
 finish("Generated notes"); await run;
 expect(f.notes.get("meeting")).toMatchObject({ tags: [], tagsRevision: revision, aiNotes: "Generated notes" });
 expect(JSON.parse(readFileSync(join(f.directory, "meeting.json"), "utf8")).tagsRevision).toBeUndefined();
});
test("missing and stale tag revisions fail before notes jobs are superseded", () => {
 const f = fixture();
 for (const tagsRevision of [undefined, "stale"]) {
  expect(() => f.notes.patch("meeting", { tags: ["Changed"], tagsRevision, aiNotes: "Manual" })).toThrow("Tags changed");
  expect(f.notes.get("meeting")!.aiNotes).toBe("");
  expect(Object.values(f.notes.get("meeting")!.notesJobs!)[0].status).toBe("queued");
 }
 expect(f.notes.patch("meeting", { tags: [" Décisions "], tagsRevision: f.meeting.tagsRevision }).tags).toEqual(["Décisions"]);
 expect(f.notes.patch("meeting", { aiNotes: "Manual" }).aiNotes).toBe("Manual");
});
test("notes reads recover interrupted tag transactions before queue writes", async () => {
 const f = fixture();
 const path = join(f.directory, "meeting.json"); const before = readFileSync(path, "utf8");
 writeFileSync(path, JSON.stringify({ ...f.meeting, tags: ["Partial rename"] }));
 writeFileSync(join(f.directory, ".tag-transaction"), JSON.stringify({ committed: false, entries: [{ id: "meeting", before, after: readFileSync(path, "utf8") }] }));
 f.notes.recover(); await f.notes.tick();
 expect(f.notes.list()[0]).toMatchObject({ tags: ["Planning"], aiNotes: "Generated notes" });
});
test("failed tag recovery blocks notes list, edits, deletion and queue writes", async () => {
 const f = fixture(); const path = join(f.directory, "meeting.json"); const before = readFileSync(path, "utf8");
 writeFileSync(join(f.directory, ".tag-transaction"), JSON.stringify({ committed: false, entries: [{ id: "meeting", before, after: before }] }));
 f.fail();
 expect(() => f.notes.list()).toThrow("Synthetic storage failure");
 expect(() => f.notes.patch("meeting", { title: "Changed" })).toThrow("Synthetic storage failure");
 expect(() => f.notes.delete("meeting")).toThrow("Synthetic storage failure");
 await expect(f.notes.tick()).rejects.toThrow("Synthetic storage failure");
 expect(readFileSync(path, "utf8")).toBe(before);
});
test("deleting a meeting aborts generation and late results cannot restore it", async () => {
 let finish!: (text: string) => void; let signal!: AbortSignal;
 const f = fixture(input => { signal = input.signal; return new Promise(resolve => { finish = resolve; }); });
 const run = f.notes.tick(); f.notes.delete("meeting");
 expect(signal.aborted).toBe(true); finish("Late notes"); await run;
 expect(f.notes.get("meeting")).toBeNull(); expect(f.tags.snapshot().sessions).toEqual([]);
});
test("tag snapshots include the same legacy note guards as meeting reads", async () => {
 const f = fixture();
 writeFileSync(join(f.directory, "legacy.json"), JSON.stringify({ id: "legacy", tags: ["Planning"], transcript: "Legacy transcript", language: "en", aiNotes: "Saved notes" }));
 const response = await tagResponse(new Request("http://localhost/api/tags"), f.tags, session => f.notes.normalize(session));
 const saved = (await response.json()).sessions.find((session: { id: string }) => session.id === "legacy");
 expect(saved).toEqual(f.notes.get("legacy"));
 expect(saved.notesMetadata).toMatchObject({ origin: "manual", stale: false });
 expect(saved.tagsRevision).toBeString();
});
test("a worker interrupted by storage recovery resumes after storage becomes available", async () => {
 let finish!: (text: string) => void; let calls = 0;
 const f = fixture(() => ++calls === 1 ? new Promise(resolve => { finish = resolve; }) : Promise.resolve("Recovered generation"));
 const run = f.notes.tick();
 const path = join(f.directory, "meeting.json"); const before = readFileSync(path, "utf8");
 writeFileSync(join(f.directory, ".tag-transaction"), JSON.stringify({ committed: false, entries: [{ id: "meeting", before, after: before }] }));
 f.fail(); finish("Interrupted output");
 await expect(run).rejects.toThrow("Synthetic storage failure");
 f.restore(); await f.notes.tick();
 expect(f.notes.get("meeting")!.aiNotes).toBe("Recovered generation");
 expect(Object.values(f.notes.get("meeting")!.notesJobs!)[0]).toMatchObject({ status: "completed", attempts: 2 });
});
