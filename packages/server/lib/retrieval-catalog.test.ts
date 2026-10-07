import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionTags, atomicWrite, transcriptGuard } from "./session-tags";
import { createRetrievalPolicy } from "./retrieval-policy";
import type { RetrievalScope } from "./retrieval-catalog";
const module = await import("./retrieval-catalog").catch(() => null);
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture(count = 2, overrides: any = {}) {
 expect(module).not.toBeNull(); const dir = mkdtempSync(join(tmpdir(), "heed-retrieval-catalog-")); dirs.push(dir);
 const store = new SessionTags(dir); let busy = false;
 for (let i = 0; i < count; i++) writeFileSync(join(dir, `meeting-${i}.json`), JSON.stringify({ id: `meeting-${i}`, title: `Fixture ${i}`, createdAt: "2026-10-07", transcript: `Synthetic ${i}`, segments: [], speakers: [], language: "en", duration: 1, transcriptFinalized: true, tags: i % 2 ? ["WORK", "Team"] : ["Work"] }));
 const catalog = new module!.RetrievalCatalog({ store, policy: createRetrievalPolicy(overrides), isBusy: () => busy, now: () => 0 });
 return { dir, store, catalog, busy: (value: boolean) => { busy = value; } };
}
const all: RetrievalScope = { kind: "library", scope: { mode: "all", labels: [], match: "any" } };
test("initial discovery completes consecutive yielding slices rather than a timer per meeting", async () => {
 const f = fixture(100); expect(f.catalog.state()).toBe("discovering"); expect(() => f.catalog.resolve(all)).toThrow();
 await f.catalog.reconcile(); expect(f.catalog.state()).toBe("ready"); expect(f.catalog.resolve(all).descriptors).toHaveLength(100); f.catalog.close();
});
test("scope resolution normalizes any/all labels before stamps and excludes unusable current text", async () => {
 const f = fixture(3), current = f.store.read("meeting-2")!;
 f.store.commitSource("meeting-2", transcriptGuard(current), session => ({ ...session!, transcript: "" })); await f.catalog.reconcile();
 expect(f.catalog.resolve({ kind: "library", scope: { mode: "labels", match: "all", labels: ["work", "TEAM"] } }).snapshot.sources.map((value: any) => value.sessionId)).toEqual(["meeting-1"]);
 expect(f.catalog.resolve({ kind: "library", scope: { mode: "labels", match: "any", labels: ["Team", "work"] } }).descriptors).toHaveLength(2);
 expect(f.catalog.resolve({ kind: "library", scope: { mode: "labels", match: "any", labels: [] } }).descriptors).toEqual([]);
 expect(f.catalog.resolve({ kind: "meeting", sessionId: "meeting-0" }).snapshot.sources.map((value: any) => value.sessionId)).toEqual(["meeting-0"]);
 expect(JSON.stringify(f.catalog.resolve(all).descriptors)).not.toContain("Synthetic"); f.catalog.close();
});
test("source version ABA and title/tag changes invalidate captured scope snapshots", async () => {
 const f = fixture(); await f.catalog.reconcile(); const before = f.catalog.resolve(all).snapshot, original = f.store.read("meeting-0")!;
 f.store.commitSource("meeting-0", transcriptGuard(original), current => ({ ...current!, transcript: "Changed" }));
 const changed = f.store.read("meeting-0")!; f.store.commitSource("meeting-0", transcriptGuard(changed), current => ({ ...current!, transcript: original.transcript }));
 expect(() => f.catalog.validate(before)).toThrow(); const restored = f.catalog.resolve(all).snapshot; expect(restored.sources[0].transcriptVersion).toBe(2);
 f.store.save({ ...f.store.read("meeting-0")!, title: "Latest title" }); expect(() => f.catalog.validate(restored)).toThrow(); f.catalog.close();
});
test("excluded source changes preserve eligible scope fingerprint and validation", async () => {
 const f = fixture(); await f.catalog.reconcile(); const snapshot = f.catalog.resolve({ kind: "meeting", sessionId: "meeting-0" }).snapshot;
 f.store.save({ ...f.store.read("meeting-1")!, title: "Excluded changed" }); f.catalog.validate(snapshot); expect(f.catalog.resolve({ kind: "meeting", sessionId: "meeting-0" }).snapshot.key).toBe(snapshot.key); f.catalog.close();
});
test("capacity and raw before-parse limits fail honestly without inventing partial scope", async () => {
 const many = fixture(3, { catalogSources: 2 }); await many.catalog.reconcile(); expect(many.catalog.state()).toBe("capacity"); expect(() => many.catalog.resolve(all)).toThrow(); many.catalog.close();
 const large = fixture(1, { sourceRecordBytes: 10 }); await large.catalog.reconcile(); expect(large.catalog.state()).toBe("unavailable"); expect(() => large.catalog.resolve(all)).toThrow(); large.catalog.close();
});
test("mandatory work pauses discovery and later resumes without losing committed updates", async () => {
 const f = fixture(2); f.busy(true); await f.catalog.reconcile(); expect(f.catalog.state()).toBe("discovering");
 f.store.save({ ...f.store.read("meeting-0")!, title: "During discovery" }); f.store.remove("meeting-1"); f.busy(false); await f.catalog.reconcile();
 const result = f.catalog.resolve(all); expect(result.descriptors).toHaveLength(1); expect(result.descriptors[0].title).toBe("During discovery"); f.catalog.close();
});
test("observer uncertainty disables lookup until bounded reconciliation succeeds", async () => {
 const f = fixture(); await f.catalog.reconcile(); const snapshot = f.catalog.resolve(all).snapshot; f.catalog.observe({ kind: "invalidate" });
 expect(f.catalog.state()).toBe("unavailable"); expect(() => f.catalog.validate(snapshot)).toThrow(); await f.catalog.reconcile(); expect(f.catalog.state()).toBe("ready"); f.catalog.close();
});
test("descriptor byte capacity fails without truncating titles and recovers after smaller authoritative metadata", async () => {
 const f = fixture(1, { catalogBytes: 600 });
 f.store.save({ ...f.store.read("meeting-0")!, title: "Title".repeat(1000) }); await f.catalog.reconcile();
 expect(f.catalog.state()).toBe("capacity"); expect(() => f.catalog.resolve(all)).toThrow();
 f.store.save({ ...f.store.read("meeting-0")!, title: "Small" }); await f.catalog.reconcile();
 expect(f.catalog.state()).toBe("ready"); expect(f.catalog.resolve(all).descriptors[0].title).toBe("Small"); f.catalog.close();
});
test("commits and deletion during discovery win over earlier scanned state", async () => {
 const f = fixture(3), discovery = f.catalog.reconcile();
 f.store.save({ ...f.store.read("meeting-0")!, title: "After first slice" }); f.store.remove("meeting-1");
 await discovery; expect(f.catalog.resolve(all).descriptors.map((value: any) => [value.sessionId, value.title])).toEqual([["meeting-0", "After first slice"], ["meeting-2", "Fixture 2"]]); f.catalog.close();
});
test("large valid local candidate records do not inherit the smaller accepted portable projection limit", async () => {
 const f = fixture(1), session = f.store.read("meeting-0")!;
 const recognized = { id: "original", createdAt: "2026-10-07", origin: "legacy-preserved", transcript: session.transcript, segments: [], speakers: [], language: "en", duration: 1 };
 const baseGuard = transcriptGuard(session);
 const candidate = { ...recognized, id: "candidate-a", requestId: "stage-a", requestSignature: "a".repeat(64), baseGuard, transcriptionModel: "small", transcript: "c".repeat(8_100_000) };
 writeFileSync(join(f.dir, "meeting-0.json"), JSON.stringify({ ...session, transcriptEditing: { schemaVersion: 1, activeGenerationId: "original", generations: [recognized], edits: [], candidateRequestReceipts: [], candidates: [candidate, { ...candidate, id: "candidate-b", requestId: "stage-b" }] } }));
 await f.catalog.reconcile(); expect(f.catalog.state()).toBe("ready"); expect(f.catalog.resolve(all).descriptors[0].evidenceCount).toBe(1); expect(JSON.stringify(f.catalog.resolve(all).descriptors).length).toBeLessThan(600); f.catalog.close();
});
test("bounded reconciliation overlays cannot retain an unbounded stream of deleted identities", async () => {
 const f = fixture(2, { catalogSources: 2 }), discovery = f.catalog.reconcile();
 const template = f.store.read("meeting-0")!;
 for (const id of ["temporary-a", "temporary-b", "temporary-c"]) {
  f.store.commitSource(id, null, () => ({ ...template, id, transcriptVersion: undefined, transcriptRevision: undefined })); f.store.remove(id);
 }
 await discovery; expect(f.catalog.state()).toBe("unavailable");
 await f.catalog.reconcile(); expect(f.catalog.resolve(all).descriptors).toHaveLength(2); f.catalog.close();
});
test("an uncertain post-rename metadata failure disables old scope until reconciliation", async () => {
 const f = fixture(1); f.catalog.close(); let fail = false;
 const store = new SessionTags(f.dir, { writeAtomic(path, data) { atomicWrite(path, data); if (fail) throw new Error("Synthetic post-rename failure"); } });
 const catalog = new module!.RetrievalCatalog({ store, policy: createRetrievalPolicy(), isBusy: () => false, now: () => 0 }); await catalog.reconcile();
 const snapshot = catalog.resolve({ kind: "library", scope: { mode: "labels", labels: ["Work"], match: "any" } }).snapshot;
 fail = true; expect(() => store.save({ ...store.read("meeting-0")!, tags: ["Other"] })).toThrow();
 expect(() => catalog.validate(snapshot)).toThrow(); await catalog.reconcile();
 expect(catalog.resolve({ kind: "library", scope: { mode: "labels", labels: ["Work"], match: "any" } }).descriptors).toEqual([]); catalog.close();
});
test("mandatory work arriving between source slices pauses a running discovery", async () => {
 const f = fixture(10), discovery = f.catalog.reconcile(); f.busy(true); await discovery;
 expect(f.catalog.state()).toBe("discovering"); expect(() => f.catalog.resolve(all)).toThrow();
 f.busy(false); await f.catalog.reconcile(); expect(f.catalog.resolve(all).descriptors).toHaveLength(10); f.catalog.close();
});
