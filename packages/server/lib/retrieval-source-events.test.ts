import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionTags, atomicWrite, transcriptGuard } from "./session-tags";
import type { Session } from "../../shared/types/session";
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
 const dir = mkdtempSync(join(tmpdir(), "heed-retrieval-events-")); dirs.push(dir); let fail = false;
 const store = new SessionTags(dir, { writeAtomic(path, data) { if (fail) throw new Error("Synthetic failed write"); atomicWrite(path, data); } });
 const meeting = { id: "a", title: "Synthetic", createdAt: "2026-10-07", duration: 1, language: "en", transcript: "Accepted", segments: [], speakers: [], transcriptFinalized: true, tags: ["Work"], aiNotes: "", summary: "", pinned: false } as Session;
 writeFileSync(join(dir, "a.json"), JSON.stringify(meeting));
 return { dir, store, meeting, fail: () => { fail = true; } };
}
function listen(store: SessionTags, listener: (value: any) => void, onError: (error: unknown) => void = () => {}) {
 expect(typeof (store as any).subscribeCommitted).toBe("function"); return (store as any).subscribeCommitted(listener, onError);
}
test("committed source notifications observe persisted hash/version before acknowledgment", () => {
 const f = fixture(), events: any[] = [];
 listen(f.store, change => { events.push(change); expect(JSON.parse(readFileSync(join(f.dir, "a.json"), "utf8")).transcriptVersion).toBe(change.session.transcriptVersion); });
 const current = f.store.read("a")!;
 const saved = f.store.commitSource("a", transcriptGuard(current), session => ({ ...session!, transcript: "Corrected" }));
 expect(events).toHaveLength(1); expect(events[0]).toMatchObject({ kind: "upsert", session: { transcript: "Corrected", transcriptVersion: 1 } }); expect(saved.transcript).toBe("Corrected");
});
test("observer failures cannot turn durable source success into a failed save or mutate returned state", () => {
 const f = fixture(), errors: unknown[] = [];
 const stop = listen(f.store, change => { change.session.transcript = "Mutated observer copy"; throw new Error("Observer failure"); }, error => { errors.push(error); throw new Error("Error observer failed"); });
 const saved = f.store.commitSource("a", transcriptGuard(f.store.read("a")!), current => ({ ...current!, transcript: "Corrected" }));
 expect(saved.transcript).toBe("Corrected"); expect(f.store.read("a")!.transcript).toBe("Corrected"); expect(errors).toHaveLength(1);
 stop(); f.store.save({ ...saved, title: "Changed title" }); expect(errors).toHaveLength(1);
});
test("failed source and metadata writes emit no tentative upserts", () => {
 const f = fixture(), events: any[] = []; listen(f.store, value => events.push(value)); const current = f.store.read("a")!; f.fail();
 expect(() => f.store.commitSource("a", transcriptGuard(current), session => ({ ...session!, transcript: "Lost" }))).toThrow();
 expect(() => f.store.save({ ...current, title: "Lost title" })).toThrow(); expect(events.every(value => value.kind === "invalidate")).toBe(true); expect(f.store.read("a")!.transcript).toBe("Accepted");
});
test("metadata and candidate commits notify current state without changing source stamps", () => {
 const f = fixture(), events: any[] = []; listen(f.store, value => events.push(value)); const current = f.store.read("a")!;
 f.store.save({ ...current, title: "Latest", aiNotes: "Generated note" });
 f.store.commitTranscriptState("a", session => ({ ...session }));
 expect(events).toHaveLength(2); expect(events.every(change => change.session.transcriptRevision === current.transcriptRevision && change.session.transcriptVersion === current.transcriptVersion)).toBe(true);
});
test("delete emits only after the authoritative file is removed, and missing delete is idempotent", () => {
 const f = fixture(), events: any[] = []; listen(f.store, value => { events.push(value); expect(f.store.read("a")).toBeNull(); });
 f.store.remove("a"); f.store.remove("a"); expect(events).toEqual([{ kind: "delete", sessionId: "a" }]);
});
test("tag transactions emit only after committed journal durability, rollback emits invalidation", () => {
 const f = fixture(); writeFileSync(join(f.dir, "b.json"), JSON.stringify({ ...f.meeting, id: "b" })); const events: any[] = [];
 let failed = false;
 const store = new SessionTags(f.dir, { writeAtomic(path, data) { if (path.endsWith("b.json") && !failed) { failed = true; throw new Error("Synthetic tag failure"); } atomicWrite(path, data); } });
 listen(store, value => events.push(value)); const revision = store.snapshot().revision;
 expect(() => store.mutate({ action: "rename", tag: "Work", name: "Team", expectedRevision: revision })).toThrow();
 expect(events.filter(value => value.kind === "upsert")).toEqual([]); expect(events.some(value => value.kind === "invalidate")).toBe(true);
 events.length = 0; store.mutate({ action: "rename", tag: "Work", name: "Team", expectedRevision: store.snapshot().revision });
 expect(events.map(value => value.kind)).toEqual(["upsert", "upsert"]); expect(events.every(value => value.session.tags[0] === "Team")).toBe(true);
});
test("restart recovery of a durable committed tag journal publishes committed records only", () => {
 const f = fixture(), after = JSON.stringify({ ...f.meeting, tags: ["Recovered"] });
 writeFileSync(join(f.dir, "a.json"), after); writeFileSync(join(f.dir, ".tag-transaction"), JSON.stringify({ committed: true, entries: [{ id: "a", before: JSON.stringify(f.meeting), after }] }));
 const events: any[] = []; listen(f.store, value => events.push(value)); f.store.recover();
 expect(events).toHaveLength(1); expect(events[0]).toMatchObject({ kind: "upsert", session: { tags: ["Recovered"] } });
});
test("bounded raw reads admit the exact UTF-8 size and reject the next byte before parsing", () => {
 const f = fixture(), raw = JSON.stringify({ ...f.meeting, transcript: "Ação" }); writeFileSync(join(f.dir, "a.json"), raw);
 const size = Buffer.byteLength(raw); expect(f.store.read("a", size)!.transcript).toBe("Ação");
 expect(() => f.store.read("a", size - 1)).toThrow("Source record exceeds");
 writeFileSync(join(f.dir, "a.json"), "{".repeat(size)); expect(() => f.store.read("a", size - 1)).toThrow("Source record exceeds");
});
test("source enumeration has an enforced capacity and releases its directory on early stop", () => {
 const f = fixture(); writeFileSync(join(f.dir, "b.json"), JSON.stringify({ ...f.meeting, id: "b" }));
 expect(() => [...f.store.sourceIds(1)]).toThrow("Source discovery capacity");
 expect(() => [...f.store.sourceIds(NaN)]).toThrow("Invalid source discovery budget");
 const iterator = f.store.sourceIds(2); expect(iterator.next().done).toBe(false); iterator.return?.();
 expect([...f.store.sourceIds(2)].sort()).toEqual(["a", "b"]);
});
