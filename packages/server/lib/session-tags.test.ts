import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionTags, atomicWrite, tagResponse, sessionResponse } from "./session-tags";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture(tags = ["Planning"]) {
  const dir = mkdtempSync(join(tmpdir(), "heed-tags-")); dirs.push(dir);
  const a = { id: "a", title: "Alpha", transcript: "Private synthetic text", tags, speakers: ["Ana"], files: { wav: "retained.wav" }, aiNotes: "notes" };
  const b = { ...a, id: "b", title: "Beta", tags: ["Planning", "Client"] };
  for (const session of [a, b]) writeFileSync(join(dir, `${session.id}.json`), JSON.stringify(session));
  return { dir, a, b, store: new SessionTags(dir) };
}
test("creates normalized Unicode tags and reuses a case-insensitive existing label", () => {
  const { store } = fixture();
  let snapshot = store.mutate({ action: "add", sessionId: "a", tag: "  Reunia\u0303o   semanal-Équipe ", expectedRevision: store.snapshot().revision });
  expect(snapshot.sessions.find(s => s.id === "a")?.tags).toEqual(["Planning", "Reunião semanal-Équipe"]);
  snapshot = store.mutate({ action: "add", sessionId: "a", tag: "CLIENT", expectedRevision: snapshot.revision });
  expect(snapshot.sessions.find(s => s.id === "a")?.tags).toContain("Client");
  snapshot = store.mutate({ action: "add", sessionId: "a", tag: "client", expectedRevision: snapshot.revision });
  expect(snapshot.sessions.find(s => s.id === "a")?.tags.filter(t => t.toLowerCase() === "client")).toHaveLength(1);
});
test("detaching a tag preserves other meetings, while rename and deletion are global", () => {
  const { dir, a, b, store } = fixture();
  let snapshot = store.mutate({ action: "remove", sessionId: "a", tag: "Planning", expectedRevision: store.snapshot().revision });
  expect(snapshot.sessions.find(s => s.id === "a")?.tags).toEqual([]);
  expect(snapshot.sessions.find(s => s.id === "b")?.tags).toContain("Planning");
  snapshot = store.mutate({ action: "rename", tag: "planning", name: "Weekly planning", expectedRevision: snapshot.revision });
  expect(snapshot.tags).toContainEqual({ name: "Weekly planning", meetingCount: 1 });
  snapshot = store.mutate({ action: "delete", tag: "Weekly planning", expectedRevision: snapshot.revision });
  expect(snapshot.sessions.find(s => s.id === "b")?.tags).toEqual(["Client"]);
  const savedA = JSON.parse(readFileSync(join(dir, "a.json"), "utf8"));
  const savedB = JSON.parse(readFileSync(join(dir, "b.json"), "utf8"));
  expect(savedA).toMatchObject({ ...a, tags: [] });
  expect(savedB).toMatchObject({ ...b, tags: ["Client"] });
  expect(new SessionTags(dir).snapshot().tags).toEqual([{ name: "Client", meetingCount: 1 }]);
});
test("renames legacy case variants together without merging into another tag", () => {
  const { store } = fixture(["planning", "Client"]);
  const revision = store.snapshot().revision;
  expect(() => store.mutate({ action: "rename", tag: "Planning", name: " client ", expectedRevision: revision })).toThrow("Tag already exists");
  expect(() => store.mutate({ action: "add", sessionId: "a", tag: " \n ", expectedRevision: revision })).toThrow("Enter a tag name");
  expect(store.snapshot().revision).toBe(revision);
  const snapshot = store.mutate({ action: "rename", tag: "Planning", name: "PLANNING", expectedRevision: revision });
  expect(snapshot.sessions.map(s => s.tags)).toEqual([["PLANNING", "Client"], ["PLANNING", "Client"]]);
});
test("stale tag edits fail, while metadata-only edits preserve the tag revision", () => {
  const { store } = fixture();
  const first = store.snapshot();
  store.patch("a", { aiNotes: "new notes", transcript: "corrected", speakers: ["Bob"] });
  expect(store.snapshot().revision).toBe(first.revision);
  store.mutate({ action: "add", sessionId: "a", tag: "New", expectedRevision: first.revision });
  expect(() => store.mutate({ action: "delete", tag: "Planning", expectedRevision: first.revision })).toThrow("Tags changed");
  expect(() => store.patch("a", { tags: [], tagsRevision: first.sessions[0].tagsRevision })).toThrow("Tags changed");
  expect(() => store.patch("a", { tags: [] })).toThrow("Tags changed");
  expect(store.read("a")?.aiNotes).toBe("new notes");
});
test("filesystem failure restores every original and leaves unrelated files unchanged", () => {
  const { dir, store } = fixture();
  const before = store.snapshot();
  let failed = false;
  const broken = new SessionTags(dir, { writeAtomic(path, data) {
    if (path.endsWith("b.json") && !failed) { failed = true; throw new Error("disk full"); }
    atomicWrite(path, data);
  } });
  expect(() => broken.mutate({ action: "rename", tag: "Planning", name: "Renamed", expectedRevision: before.revision })).toThrow("disk full");
  expect(new SessionTags(dir).snapshot()).toEqual(before);
});
test("unfinished transactions recover on restart before reading or editing metadata", () => {
  const { dir, store } = fixture();
  const before = store.snapshot();
  let failure = false;
  const broken = new SessionTags(dir, { writeAtomic(path, data) {
    if (path.endsWith("b.json")) failure = true;
    if (failure) throw new Error("disk unavailable");
    atomicWrite(path, data);
  } });
  expect(() => broken.mutate({ action: "rename", tag: "Planning", name: "Renamed", expectedRevision: before.revision })).toThrow();
  expect(() => broken.snapshot()).toThrow();
  const recovered = new SessionTags(dir);
  recovered.patch("a", { aiNotes: "after recovery" });
  expect(recovered.snapshot().revision).toBe(before.revision);
  expect(recovered.read("a")?.tags).toEqual(["Planning"]);
  expect(recovered.read("a")?.aiNotes).toBe("after recovery");
});
test("rejects traversal, symlinks and missing meetings without altering the library", () => {
  const { dir, store } = fixture();
  const revision = store.snapshot().revision;
  expect(() => store.patch("../outside", { tags: [] })).toThrow();
  expect(() => store.mutate({ action: "add", sessionId: "missing", tag: "New", expectedRevision: revision })).toThrow("Meeting not found");
  symlinkSync(join(dir, "a.json"), join(dir, "link.json"));
  expect(() => store.snapshot()).toThrow("Invalid meeting file");
});
test("HTTP operations expose committed tags and distinguish collisions from stale saves", async () => {
  const { store } = fixture();
  const first = await (await tagResponse(new Request("http://localhost/api/tags"), store)).json();
  const request = (body: unknown) => new Request("http://localhost/api/tags", { method: "POST", body: JSON.stringify(body) });
  expect((await tagResponse(request({ action: "rename", tag: "Planning", name: "Client", expectedRevision: first.revision }), store)).status).toBe(409);
  expect((await tagResponse(request({ action: "delete", tag: "Planning", expectedRevision: "stale" }), store)).status).toBe(409);
  const patched = await sessionResponse(new Request("http://localhost/api/sessions?id=a", { method: "PATCH", body: JSON.stringify({ aiNotes: "HTTP notes" }) }), store);
  expect(patched.status).toBe(200);
  expect((await patched.json()).tags).toEqual(["Planning"]);
  const stale = await sessionResponse(new Request("http://localhost/api/sessions?id=a", { method: "PATCH", body: JSON.stringify({ tags: [] }) }), store);
  expect(stale.status).toBe(409);
});
