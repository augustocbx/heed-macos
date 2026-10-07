import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

let dir: string, base: string, app: ReturnType<typeof Bun.spawn>, sidecar: ReturnType<typeof Bun.serve>;
const fixture = { id: "meeting", title: "Fixture", createdAt: "2026-10-06T12:00:00.000Z", duration: 2, language: "pt", transcript: "Olá world", segments: [{ speaker: "Ana", text: "Olá world", start: 0, end: 2, channel: "mic", auto: false }], speakers: ["Ana"], files: { wav: "synthetic.wav" }, transcriptFinalized: true, tags: [], pinned: false, aiNotes: "", summary: "" };
const result = { success: true, finalized: true, duration: 2, text: "Novo mundo", segments: [{ speaker: "Speaker 1", text: "Novo mundo", start: 0, end: 2, channel: "mic" }], speakers: ["Speaker 1"], metadata: { language: "pt", model: "small" }, files: { wav: "/ignored.wav", txt: "", srt: "" }, wordCount: 2 };
const guard = (s: any) => ({ expectedTranscriptRevision: s.transcriptRevision, expectedTranscriptVersion: s.transcriptVersion });
async function call(path: string, body?: unknown, options: { origin?: string; raw?: string; method?: string } = {}) {
 const response = await fetch(`${base}${path}`, { method: options.method ?? "POST", headers: { "Content-Type": "application/json", ...(options.origin ? { Origin: options.origin } : {}) }, body: options.raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
 const text = await response.text(); let value: any; try { value = JSON.parse(text); } catch { value = text; }
 return { status: response.status, body: value };
}
async function start() {
 app = Bun.spawn([process.execPath, resolve(import.meta.dir, "../server.ts")], { cwd: resolve(import.meta.dir, "../../.."), env: { ...process.env, PORT: base.split(":").at(-1)!, HEED_APP_DIR: dir, HEED_RECORDINGS_DIR: join(dir, "recordings"), HEED_TRANSCRIPTION_URL: `http://127.0.0.1:${sidecar.port}`, OLLAMA_HOST: `http://127.0.0.1:${sidecar.port}` }, stdout: "ignore", stderr: "ignore" });
 const deadline = Date.now() + 8000;
 while (Date.now() < deadline) { try { if ((await fetch(`${base}/api/desktop/control/status`)).ok) return; } catch {} await Bun.sleep(25); }
 throw new Error("Isolated transcript server failed to start");
}
beforeAll(async () => {
 dir = mkdtempSync(join(tmpdir(), "heed-transcript-http-")); writeFileSync(join(dir, "config.json"), JSON.stringify({ user_name: "Synthetic Owner", automatic_notes: { enabled: false } }));
 sidecar = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ whisper: true, warm: true, models: [] }) });
 const reserve = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() }); base = `http://127.0.0.1:${reserve.port}`; reserve.stop(true); await start();
});
afterAll(async () => { app?.kill(); if (app) await app.exited; sidecar?.stop(true); if (dir) rmSync(dir, { recursive: true, force: true }); });
async function saved() { const response = await call("/api/sessions", fixture); expect(response.status).toBe(200); return response.body; }

test("production transcript routes deny remote origins before parsing or mutating", async () => {
 await saved();
 for (const suffix of ["preview", "commands", "candidates", "candidates/candidate/discard"]) expect((await call(`/api/sessions/meeting/transcript/${suffix}`, {}, { origin: "https://untrusted.example" })).status).toBe(403);
 expect((await fetch(`${base}/api/sessions/meeting/transcript/commands`, { method: "POST", headers: { Host: "untrusted.example" }, body: "{}" })).status).toBe(403);
 expect((await call("/api/sessions/meeting/transcript/commands", {}, { origin: base })).status).toBe(400);
});
test("actual HTTP preview/edit/replace/revert survive restart with durable retries and metadata", async () => {
 const original = await saved(); const preview = await call("/api/sessions/meeting/transcript/preview", { input: { query: "world", replacement: "mundo", caseSensitive: true, wholeWord: true }, guard: guard(original) });
 expect(preview.status).toBe(200); expect(preview.body.matchCount).toBe(1);
 await call("/api/sessions?id=meeting", { title: "Latest", pinned: true, tags: ["Work"], tagsRevision: original.tagsRevision }, { method: "PATCH" });
 const command = { ...guard(original), requestId: "replace", action: "replace", input: { query: "world", replacement: "mundo", caseSensitive: true, wholeWord: true }, expectedPreviewKey: preview.body.key };
 const changed = await call("/api/sessions/meeting/transcript/commands", command); expect(changed.status).toBe(200); expect(changed.body).toMatchObject({ title: "Latest", pinned: true, tags: ["Work"], transcript: "Olá mundo", transcriptVersion: 2 });
 expect((await call("/api/sessions/meeting/transcript/commands", { ...command, requestId: "mismatch", expectedPreviewKey: "0".repeat(64) })).status).toBe(409);
 app.kill(); await app.exited; await start();
 expect((await call("/api/sessions/meeting/transcript/commands", command)).body.transcriptVersion).toBe(2);
 const undo = await call("/api/sessions/meeting/transcript/commands", { ...guard(changed.body), requestId: "undo", action: "revert", editId: changed.body.transcriptEditing.edits[0].id });
 expect(undo.body.transcript).toBe("Olá world"); expect(undo.body.transcriptVersion).toBe(3);
 expect((await call("/api/sessions/meeting/transcript/commands", { ...command, requestId: "old" })).status).toBe(409);
 const edit = await call("/api/sessions/meeting/transcript/commands", { ...guard(undo.body), requestId: "edit", action: "edit", target: { kind: "segment", index: 0 }, text: "" }); expect(edit.status).toBe(200); expect(edit.body.transcript).toBe("");
});
test("chunked raw bodies are bounded without trusting Content-Length", async () => {
 const stream = (size: number) => new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode("{}")); let left = size - 2; while (left) { const bytes = Math.min(left, 1_000_000); controller.enqueue(new Uint8Array(bytes).fill(32)); left -= bytes; } controller.close(); } });
 const exact = await fetch(`${base}/api/sessions/meeting/transcript/commands`, { method: "POST", body: stream(16_000_000) }); expect(exact.status).toBe(400); await exact.text();
 const over = await fetch(`${base}/api/sessions/meeting/transcript/commands`, { method: "POST", body: stream(16_000_001) }); expect(over.status).toBe(413); await over.text();
});
test("malformed operation identities return invalid-input errors rather than missing or conflict", async () => {
 const list = await call("/api/sessions", undefined, { method: "GET" }), current = list.body.find((s: any) => s.id === "meeting");
 for (const fields of [{ action: "accept-candidate", candidateId: 5 }, { action: "accept-candidate", candidateId: "../other" }, { action: "revert", editId: null }, { action: "replace", input: { query: "x", replacement: "y", caseSensitive: true, wholeWord: false } }]) {
  expect((await call("/api/sessions/meeting/transcript/commands", { ...guard(current), requestId: "invalid", ...fields })).status).toBe(400);
 }
});
test("production candidate stage/discard/accept preserve audio and reject stale acceptance", async () => {
 const sessions = await call("/api/sessions", undefined, { method: "GET" }); const current = sessions.body.find((s: any) => s.id === "meeting");
 const input = { requestId: "stage", base: guard(current), result }; const staged = await call("/api/sessions/meeting/transcript/candidates", input); expect(staged.status).toBe(200);
 const id = staged.body.transcriptEditing.candidates[0].id;
 app.kill(); await app.exited; await start();
 const accepted = await call("/api/sessions/meeting/transcript/commands", { ...guard(staged.body), requestId: "accept", action: "accept-candidate", candidateId: id }); expect(accepted.status).toBe(200); expect(accepted.body.transcript).toBe("Novo mundo"); expect(accepted.body.files).toEqual(current.files);
 expect((await call("/api/sessions/meeting/transcript/candidates", input)).body.transcriptEditing.candidates).toHaveLength(0);
 const stale = await call("/api/sessions/meeting/transcript/candidates", { ...input, requestId: "stale" }); expect(stale.status).toBe(200);
 expect((await call("/api/sessions/meeting/transcript/commands", { ...guard(accepted.body), requestId: "stale-accept", action: "accept-candidate", candidateId: stale.body.transcriptEditing.candidates[0].id })).status).toBe(409);
 const path = `/api/sessions/meeting/transcript/candidates/${stale.body.transcriptEditing.candidates[0].id}/discard`;
 expect((await call(path, { requestId: "discard" })).status).toBe(200); expect((await call(path, { requestId: "discard" })).status).toBe(200);
});
test("bounded raw input, unsafe encoded IDs, invalid bodies and missing meetings fail predictably", async () => {
 expect((await call("/api/sessions/missing/transcript/commands", { requestId: "x", action: "edit", target: { kind: "document" }, text: "x", expectedTranscriptRevision: "a".repeat(64), expectedTranscriptVersion: 0 })).status).toBe(404);
 for (const id of ["%2Ftmp", "%00", "%ZZ"]) expect((await call(`/api/sessions/${id}/transcript/commands`, {})).status).toBe(400);
 for (const raw of ["{", "null", "[]"]) expect((await call("/api/sessions/meeting/transcript/commands", undefined, { raw })).status).toBe(400);
 expect((await call("/api/sessions/meeting/transcript/commands", undefined, { raw: " ".repeat(16_000_001) })).status).toBe(413);
 const unfinished = await call("/api/sessions", { ...fixture, id: "unfinished", files: undefined, transcriptFinalized: false });
 expect((await call("/api/sessions/unfinished/transcript/preview", { input: { query: "world", replacement: "x", caseSensitive: true, wholeWord: false }, guard: guard(unfinished.body) })).status).toBe(400);
});
test("production quota failure retains exact accepted bytes and candidate state", async () => {
 const sessions = await call("/api/sessions", undefined, { method: "GET" }), current = sessions.body.find((s: any) => s.id === "meeting");
 const quota = await call("/api/storage", undefined, { method: "GET" });
 // The normal HTTP quota setter cannot lower below existing usage without reviewed cleanup.
 // Exhaust the isolated configuration budget between commands to exercise actual atomic reservation.
 const configPath = join(dir, "config.json"), config = JSON.parse(readFileSync(configPath, "utf8")); config.storage_limit_bytes = 1_048_576; writeFileSync(configPath, JSON.stringify(config));
 writeFileSync(join(dir, "sessions", "budget.txt"), "x".repeat(1_048_576));
 const path = join(dir, "sessions", "meeting.json"), before = readFileSync(path, "utf8");
 const denied = await call("/api/sessions/meeting/transcript/commands", { ...guard(current), requestId: "no-space", action: "edit", target: { kind: "segment", index: 0 }, text: "Denied" });
 expect(denied.status).toBe(409); expect(readFileSync(path, "utf8")).toBe(before); expect(quota.status).toBe(200);
 delete config.storage_limit_bytes; writeFileSync(configPath, JSON.stringify(config));
});
