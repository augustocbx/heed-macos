import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Session } from "../../shared/types/session";
import type { TranscribeResult } from "../../shared/types/api";
import { SessionTags, atomicWrite, transcriptGuard } from "./session-tags";
import { AutomaticNotesService } from "./automatic-notes";
import { setAtomicWriteBudget } from "./atomic-json";
import { TranscriptService } from "./transcript-service";

const directories: string[] = [];
afterEach(() => { setAtomicWriteBudget(undefined); for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const now = "2026-10-06T12:00:00.000Z";
function meeting(): Session {
 return { id: "meeting", title: "Synthetic meeting", createdAt: now, language: "pt", duration: 2, transcript: "Original\nSistema", speakers: ["Ana", "System (unattributed)"],
  segments: [{ speaker: "Ana", start: 0, end: 1, text: "Original", auto: false, channel: "mic" }, { speaker: "System (unattributed)", start: 1, end: 2, text: "Sistema", auto: false, channel: "sys", attribution: "fallback" }],
  embeddings: { Ana: [1, 2] }, transcriptFinalized: true, aiNotes: "", summary: "", tags: ["Work"], pinned: false, files: { wav: "original.wav", txt: "old.txt", srt: "old.srt" } };
}
function result(): TranscribeResult {
 return { success: true, finalized: true, duration: 2, text: "Novo\nSistema novo", metadata: { language: "pt", model: "small" }, wordCount: 3,
  segments: [{ speaker: "Speaker 1", text: "Novo", start: 0, end: 1, channel: "mic", auto: true }, { speaker: "Speaker 2", text: "Sistema novo", start: 1, end: 2, channel: "sys", attribution: "fallback" }], speakers: ["Speaker 1", "Speaker 2"], embeddings: { "Speaker 1": [3, 4] }, files: { wav: "/forbidden/new.wav", txt: "/forbidden/new.txt", srt: "/forbidden/new.srt" } };
}
function fixture(generate: any = async () => "Generated") {
 const dir = mkdtempSync(join(tmpdir(), "heed-candidates-")); directories.push(dir); let failed = false;
 const store = new SessionTags(dir, { writeAtomic(path, data) { if (failed) throw new Error("Synthetic disk full"); atomicWrite(path, data); } });
 const settings = { enabled: false, templateId: "meeting", model: "local", language: "meeting" as const };
 const options = { sessionsDir: dir, sessionStore: store, getSettings: () => settings, loadTemplate: () => ({ id: "meeting", name: "Meeting", description: "", prompt: "Use evidence" }), generate, isBusy: () => false };
 const notes = new AutomaticNotesService(options); const service = new TranscriptService({ notes, store, now: () => now });
 writeFileSync(join(dir, "original.wav"), Buffer.from([82, 73, 70, 70, 1, 2, 3, 4]));
 const saved = notes.create({ ...meeting(), files: { ...meeting().files!, wav: join(dir, "original.wav") } });
 return { dir, store, notes, service, settings, saved, options, fail: (value = true) => { failed = value; }, bytes: () => readFileSync(join(dir, "meeting.json"), "utf8"), stage: (requestId = "stage") => service.stage("meeting", { requestId, base: transcriptGuard(saved), result: result() }) };
}

test("staging is durable local state without replacing accepted source or notes jobs", () => {
 const f = fixture(); const staged = f.stage();
 expect(staged.transcript).toBe("Original\nSistema"); expect(staged.transcriptVersion).toBe(1); expect(staged.transcriptRevision).toBe(f.saved.transcriptRevision);
 expect(staged.transcriptEditing!.generations[0]!.transcript).toBe("Original\nSistema"); expect(staged.notesJobs).toEqual(f.saved.notesJobs);
 const reloaded = new TranscriptService({ notes: new AutomaticNotesService(f.options), store: new SessionTags(f.dir), now: () => now });
 expect(reloaded.stage("meeting", { requestId: "stage", base: transcriptGuard(f.saved), result: result() })).toEqual(staged);
 expect(JSON.stringify(staged.transcriptEditing)).not.toContain("/forbidden"); expect(staged.transcriptEditing!.candidates).toHaveLength(1);
});
test("acceptance preserves corrections, original audio and manual names while installing the finalized candidate", () => {
 const f = fixture(); const corrected = f.notes.commitTranscript("meeting", { ...transcriptGuard(f.saved), requestId: "edit", action: "edit", target: { kind: "segment", index: 0 }, text: "Corrected" });
 const staged = f.service.stage("meeting", { requestId: "stage", base: transcriptGuard(corrected), result: result() });
 f.notes.patch("meeting", { title: "Latest title", pinned: true }); const candidate = staged.transcriptEditing!.candidates[0]!;
 const request = { ...transcriptGuard(staged), requestId: "accept", action: "accept-candidate" as const, candidateId: candidate.id };
 const accepted = f.service.command("meeting", request);
 expect([...readFileSync(f.saved.files!.wav!)]).toEqual([82, 73, 70, 70, 1, 2, 3, 4]);
 expect(accepted).toMatchObject({ transcript: "Novo\nSistema novo", transcriptVersion: 3, language: "pt", transcriptionModel: "small", title: "Latest title", pinned: true, files: f.saved.files, embeddings: { Ana: [3, 4] } });
 expect(accepted.segments[0]).toMatchObject({ speaker: "Ana", auto: false, channel: "mic", start: 0, end: 1 });
 expect(accepted.segments[1]).toMatchObject({ speaker: "Speaker 2", attribution: "fallback", channel: "sys" });
 expect(accepted.transcriptEditing!.generations.map(g => g.transcript)).toEqual(["Original\nSistema", "Novo\nSistema novo"]);
 expect(accepted.transcriptEditing!.edits).toHaveLength(1); expect(accepted.transcriptEditing!.candidates).toHaveLength(0);
 expect(f.service.command("meeting", request)).toEqual(accepted);
 expect(f.service.stage("meeting", { requestId: "stage", base: transcriptGuard(corrected), result: result() })).toEqual(accepted);
 expect(() => f.service.command("meeting", { ...request, candidateId: "other" })).toThrow();
 expect(() => f.service.stage("meeting", { requestId: "accept", base: transcriptGuard(corrected), result: result() })).toThrow();
});
test("discard remains durable and idempotent after the candidate is gone and rejects conflicting reuse", () => {
 const f = fixture(); const staged = f.stage(), id = staged.transcriptEditing!.candidates[0]!.id;
 const discarded = f.service.discard("meeting", id, "discard"); const bytes = f.bytes();
 expect(discarded.transcriptVersion).toBe(1); expect(discarded.transcriptEditing!.candidates).toHaveLength(0);
 const reload = new TranscriptService({ notes: new AutomaticNotesService(f.options), store: f.store, now: () => now });
 expect(reload.discard("meeting", id, "discard")).toEqual(discarded); expect(f.bytes()).toBe(bytes);
 expect(reload.stage("meeting", { requestId: "stage", base: transcriptGuard(f.saved), result: result() })).toEqual(discarded);
 expect(() => reload.discard("meeting", "other", "discard")).toThrow();
 expect(() => reload.command("meeting", { ...transcriptGuard(discarded), requestId: "discard", action: "edit", target: { kind: "segment", index: 0 }, text: "Bad" })).toThrow();
});
test("stale staging retains its base and candidate inspection while acceptance cannot replace newer text", () => {
 const f = fixture(); const corrected = f.notes.commitTranscript("meeting", { ...transcriptGuard(f.saved), requestId: "edit", action: "edit", target: { kind: "segment", index: 0 }, text: "Corrected" });
 const staged = f.stage(); expect(staged.transcript).toBe("Corrected\nSistema"); const bytes = f.bytes();
 expect(staged.transcriptEditing!.candidates[0]!.baseGuard).toEqual(transcriptGuard(f.saved));
 expect(() => f.service.command("meeting", { ...transcriptGuard(corrected), requestId: "accept", action: "accept-candidate", candidateId: staged.transcriptEditing!.candidates[0]!.id })).toThrow("Transcript changed");
 expect(f.bytes()).toBe(bytes); expect(f.notes.get("meeting")!.transcriptEditing!.candidates).toHaveLength(1);
});
test("two pending candidates require explicit discard before another admission", () => {
 const f = fixture(); f.stage("one"); const two = f.stage("two"), bytes = f.bytes();
 expect(() => f.stage("three")).toThrow(); expect(f.bytes()).toBe(bytes);
 f.service.discard("meeting", two.transcriptEditing!.candidates[0]!.id, "discard"); expect(f.stage("three").transcriptEditing!.candidates).toHaveLength(2);
});
test("near receipt capacity reserves terminal slots so discard succeeds without pruning", () => {
 const f = fixture(); f.stage(); const initial = f.notes.get("meeting")!;
 const state = initial.transcriptEditing!; state.candidates = []; state.candidateRequestReceipts = Array.from({ length: 998 }, (_, i) => ({ requestId: `done-${i}`, requestSignature: `signature-${i}`, candidateId: `gone-${i}`, status: "discarded" as const }));
 writeFileSync(join(f.dir, "meeting.json"), JSON.stringify(initial));
 const staged = f.stage("last"); expect(() => f.stage("overflow")).toThrow();
 const discarded = f.service.discard("meeting", staged.transcriptEditing!.candidates[0]!.id, "last-discard");
 expect(discarded.transcriptEditing!.candidateRequestReceipts).toHaveLength(1000);
 expect(discarded.transcriptEditing!.candidateRequestReceipts[0]!.requestId).toBe("done-0");
 expect(f.service.discard("meeting", staged.transcriptEditing!.candidates[0]!.id, "last-discard")).toEqual(discarded);
 expect(() => f.stage("overflow")).toThrow();
});
test("incomplete or invalid finalized results do not change the durable source", () => {
 const f = fixture(); const before = f.bytes();
 for (const patch of [{ success: false }, { finalized: false }, { finalized: undefined }, { text: "" }, { duration: NaN }, { duration: undefined }, { metadata: { language: "fr", model: "small" } }, { metadata: { language: "pt", model: "" } }, { segments: [{ ...result().segments[0], end: -1 }] }, { segments: [{ ...result().segments[0], text: "\ud800" }] }, { embeddings: { "Speaker 1": [Infinity] } }, { speakers: ["Unknown"] }, { wordCount: -1 }, { wordCount: undefined }, { files: null }]) {
  expect(() => f.service.stage("meeting", { requestId: "invalid", base: transcriptGuard(f.saved), result: { ...result(), ...patch } as any })).toThrow(); expect(f.bytes()).toBe(before);
 }
});
test("candidate validation drops private extras but preserves sanitized diagnostics and fallback fields", () => {
 const f = fixture(), final = result();
 const levels = { rawRms: 0.1, rawPeak: 0.2, cleanedRms: 0.1, asrSegments: 1, diarizationSegments: 0, usableEmbeddings: 0, retainedSegments: 1, discardedSegments: 0, discardReasons: {}, fallbackSegments: 1, diarizationFailed: true };
 final.transcriptionDiagnostics = { version: 1, aecApplied: false, channels: { sys: levels }, warnings: ["system-attribution-fallback"] };
 (final.transcriptionDiagnostics as any).privatePath = "/private/not-stored"; (final.segments[0] as any).privateData = "secret"; final.embeddings!["Speaker 2"] = [9, 9];
 const staged = f.service.stage("meeting", { requestId: "diagnostics", base: transcriptGuard(f.saved), result: final });
 const accepted = f.service.command("meeting", { ...transcriptGuard(staged), requestId: "accept", action: "accept-candidate", candidateId: staged.transcriptEditing!.candidates[0]!.id });
 expect(accepted.transcriptionDiagnostics).toEqual({ version: 1, aecApplied: false, channels: { sys: levels }, warnings: ["system-attribution-fallback"] });
 expect(accepted.embeddings).toEqual({ Ana: [3, 4] }); expect(JSON.stringify(accepted.transcriptEditing)).not.toContain("privatePath"); expect(JSON.stringify(accepted.segments)).not.toContain("secret");
 expect(JSON.stringify(accepted.transcriptEditing!.generations)).not.toContain("embeddings");
});
test("candidate acceptance rejects an old base even after edit and revert restore its hash", () => {
 const f = fixture(); const staged = f.stage(), candidateId = staged.transcriptEditing!.candidates[0]!.id;
 const edited = f.notes.commitTranscript("meeting", { ...transcriptGuard(staged), requestId: "edit", action: "edit", target: { kind: "segment", index: 0 }, text: "Corrected" });
 const restored = f.notes.commitTranscript("meeting", { ...transcriptGuard(edited), requestId: "revert", action: "revert", editId: edited.transcriptEditing!.edits[0]!.id });
 expect(restored.transcriptRevision).toBe(f.saved.transcriptRevision); const before = f.bytes();
 expect(() => f.service.command("meeting", { ...transcriptGuard(restored), requestId: "accept", action: "accept-candidate", candidateId })).toThrow(); expect(f.bytes()).toBe(before);
});
test("failed stage and failed acceptance retain exact bytes including pending candidates", () => {
 const f = fixture(), initial = f.bytes(); f.fail(); expect(() => f.stage()).toThrow(); expect(f.bytes()).toBe(initial); f.fail(false);
 const staged = f.stage(), before = f.bytes(); f.fail();
 expect(() => f.service.command("meeting", { ...transcriptGuard(staged), requestId: "accept", action: "accept-candidate", candidateId: staged.transcriptEditing!.candidates[0]!.id })).toThrow(); expect(f.bytes()).toBe(before);
});
test("candidate writes reserve the complete local record and quota failure retains source bytes", () => {
 const f = fixture(), before = f.bytes(); let reserved = 0;
 setAtomicWriteBudget((_path, bytes) => { reserved = bytes; throw new Error("Synthetic quota full"); });
 const final = result(); final.segments[0]!.text = "x".repeat(1_000_000); final.text = final.segments.map(s => s.text).join("\n");
 expect(() => f.service.stage("meeting", { requestId: "quota", base: transcriptGuard(f.saved), result: final })).toThrow("Synthetic quota full");
 expect(reserved).toBeGreaterThan(2_000_000); expect(f.bytes()).toBe(before);
});
test("candidate-byte bounds are measured on complete serialized candidate and quota faults retain old bytes", () => {
 const f = fixture(); const staged = f.stage(); const candidate = staged.transcriptEditing!.candidates[0]!;
 const padding = 16_000_000 - Buffer.byteLength(JSON.stringify(candidate));
 const long = result(); long.segments[0]!.text += "x".repeat(Math.floor(padding / 2)); long.text = long.segments.map(s => s.text).join("\n");
 if (padding % 2) long.metadata.model += "x";
 // Fixed-width UUID/time/hash fields make independent serialized size calibration exact.
 const full = f.service.stage("meeting", { requestId: "large", base: transcriptGuard(f.saved), result: long });
 expect(Buffer.byteLength(JSON.stringify(full.transcriptEditing!.candidates[1]!))).toBe(16_000_000);
 f.service.discard("meeting", candidate.id, "discard"); const before = f.bytes(); long.metadata.model += "x";
 expect(() => f.service.stage("meeting", { requestId: "extra", base: transcriptGuard(f.saved), result: long })).toThrow(); expect(f.bytes()).toBe(before);
 f.fail(); expect(() => f.service.discard("meeting", full.transcriptEditing!.candidates[1]!.id, "disk-discard")).toThrow(); expect(f.bytes()).toBe(before);
});
test("stage/discard preserve a held notes job while acceptance aborts old output only after commit", async () => {
 let resolve!: (value: string) => void, signal!: AbortSignal;
 const f = fixture(({ signal: current }: any) => { signal = current; return new Promise<string>(r => { resolve = r; }); });
 f.settings.enabled = true; const queued = f.notes.patch("meeting", { aiNotes: "" });
 // Queue a legitimate finalized creation without altering an existing accepted record.
 const newSession = f.notes.create({ ...meeting(), id: "held", files: undefined }); const run = f.notes.tick();
 const staged = f.service.stage("held", { requestId: "held-stage", base: transcriptGuard(newSession), result: result() });
 expect(signal.aborted).toBe(false); expect(staged.notesJobs![`notes-${newSession.transcriptRevision}`]!.status).toBe("running");
 f.service.discard("held", staged.transcriptEditing!.candidates[0]!.id, "held-discard"); expect(signal.aborted).toBe(false);
 const candidate = f.service.stage("held", { requestId: "again", base: transcriptGuard(newSession), result: result() });
 f.fail(); expect(() => f.service.command("held", { ...transcriptGuard(candidate), requestId: "failed-accept", action: "accept-candidate", candidateId: candidate.transcriptEditing!.candidates[0]!.id })).toThrow(); expect(signal.aborted).toBe(false); f.fail(false);
 f.service.command("held", { ...transcriptGuard(candidate), requestId: "accept", action: "accept-candidate", candidateId: candidate.transcriptEditing!.candidates[0]!.id });
 expect(signal.aborted).toBe(true); resolve("Old notes"); await run; expect(f.notes.get("held")!.aiNotes).toBe(""); expect(queued.transcriptVersion).toBe(1);
});
test("accepting the last admitted candidate terminalizes both reserved receipts at capacity", () => {
 const f = fixture(); f.stage(); const initial = f.notes.get("meeting")!; initial.transcriptEditing!.candidates = [];
 initial.transcriptEditing!.candidateRequestReceipts = Array.from({ length: 998 }, (_, i) => ({ requestId: `done-${i}`, requestSignature: `signature-${i}`, candidateId: `gone-${i}`, status: "discarded" as const }));
 writeFileSync(join(f.dir, "meeting.json"), JSON.stringify(initial)); const staged = f.stage("last");
 const request = { ...transcriptGuard(staged), requestId: "last-accept", action: "accept-candidate" as const, candidateId: staged.transcriptEditing!.candidates[0]!.id };
 const accepted = f.service.command("meeting", request); expect(accepted.transcriptEditing!.candidateRequestReceipts).toHaveLength(1000); expect(accepted.transcript).toBe("Novo\nSistema novo");
 expect(f.service.command("meeting", request)).toEqual(accepted); expect(() => f.stage("overflow")).toThrow();
});
