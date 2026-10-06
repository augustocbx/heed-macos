import {configuredServicePorts} from '../packages/server/lib/service-ports';
import {localServiceUrl,servicePort} from '../packages/shared/lib/service-config';
import {isTranscriptionHealth} from '../packages/shared/lib/service-identity';
/** Opt-in production-server acceptance using synthetic WAV audio and installed local engines. */
import { closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir, platform, release, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import type { Session, TranscribeResult } from "../packages/shared/types";

const usage = `Usage: bun scripts/check-tag-persistence.ts --audio /outside/repo/synthetic.wav --language en|pt --model <installed-local-model> [--transcription-url http://127.0.0.1:48102] [--ollama-url http://127.0.0.1:11434] [--output /outside/repo/evidence]
Supply only synthetic spoken English or Brazilian Portuguese WAV audio. Run while all apps using these engines are idle. This starts only isolated Heed servers, never capture or engine services. --output retains synthetic evidence in a new subdirectory; otherwise all temporary files are removed.`;
const { values } = parseArgs({ options: {
 audio: { type: "string" }, language: { type: "string" }, model: { type: "string" },
 "transcription-url": { type: "string", default: process.env.HEED_TRANSCRIPTION_URL || `http://127.0.0.1:${configuredServicePorts().transcription}` },
 "ollama-url": { type: "string", default: "http://127.0.0.1:11434" },
 output: { type: "string" }, help: { type: "boolean", default: false },
} });
if (values.help) { console.log(usage); process.exit(0); }
const repository = resolve(import.meta.dir, "..");
function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function localUrl(value: string): string {
 const url = new URL(value);
 assert(["http:", "https:"].includes(url.protocol) && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  && !url.username && !url.password && !url.search && !url.hash && url.pathname === "/", "Engine URLs must be local origins without credentials or paths.");
 return localServiceUrl(url.origin,"QA engine");
}
function contained(parent: string, child: string): boolean { const path = relative(parent, child); return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !path.startsWith(sep)); }
function outsideLibrary(path: string): void {
 let existing = resolve(path);
 while (!existsSync(existing)) existing = dirname(existing);
 const real = resolve(realpathSync(existing), relative(existing, resolve(path)));
 assert(!contained(realpathSync(repository), real), "Audio and evidence must stay outside the repository.");
 const personal = join(homedir(), ".heed-app");
 assert(!contained(existsSync(personal) ? realpathSync(personal) : personal, real), "Audio and evidence must stay outside the personal Heed library.");
}
let audio: string;
let transcriptionUrl: string;
let ollamaUrl: string;
try {
 assert(values.audio && values.model?.trim() && ["en", "pt"].includes(values.language || ""), "Explicit --audio, --language en|pt, and --model are required.");
 audio = realpathSync(values.audio); outsideLibrary(audio);
 const header = readFileSync(audio).subarray(0, 12);
 assert(statSync(audio).isFile() && audio.toLowerCase().endsWith(".wav") && header.toString("ascii", 0, 4) === "RIFF" && header.toString("ascii", 8, 12) === "WAVE", "Supply a synthetic RIFF/WAVE .wav file.");
 transcriptionUrl = localUrl(values["transcription-url"]!); ollamaUrl = localUrl(values["ollama-url"]!);
 if (values.output) { outsideLibrary(resolve(values.output)); mkdirSync(resolve(values.output), { recursive: true, mode: 0o700 }); outsideLibrary(resolve(values.output)); }
} catch (error) { console.error(`${(error as Error).message}\n${usage}`); process.exit(2); }

const directory = mkdtempSync(join(tmpdir(), "heed-tag-persistence-"));
const runtime = join(directory, "runtime");
const appDirectory = join(directory, "app");
const evidence = values.output ? mkdtempSync(join(realpathSync(values.output), "tag-persistence-")) : undefined;
const logPath = join(directory, "server.log");
const logDescriptor = openSync(logPath, "a", 0o600);
const tags = ["Reunião técnica", "Planning – Q4", "Überprüfung", "日本語"];
const id = "synthetic-tag-persistence";
const snapshots: Record<string, Session> = {};
const steps: Array<{ name: string; at: string }> = [];
const report: Record<string, unknown> = { startedAt: new Date().toISOString(), model: values.model, language: values.language,
 transcriptionUrl, ollamaUrl, tags, machine: { platform: platform(), release: release(),
  hardware: platform() === "darwin" ? Bun.spawnSync(["sysctl", "-n", "hw.model"], { stdout: "pipe" }).stdout.toString().trim() : null,
  macOS: platform() === "darwin" ? Bun.spawnSync(["sw_vers"], { stdout: "pipe" }).stdout.toString().trim() : null }, bun: Bun.version, steps, snapshots,
 limits: "Synthetic audio through identical copied production server/shared sources and installed engines. No physical capture, browser UI, crash interruption, concurrent-engine exclusivity, or semantic ASR/notes quality acceptance. External engine requests may finish after a timeout; engine services are preserved. Notes quality requires human review." };
let server: ReturnType<typeof Bun.spawn> | undefined;
let base = "";
let reservation: ReturnType<typeof Bun.serve> | undefined;
const controller = new AbortController();
const interrupt = () => { process.exitCode = 130; controller.abort(new Error("Acceptance interrupted")); };
process.on("SIGINT", interrupt); process.on("SIGTERM", interrupt);
const signal = (milliseconds: number) => AbortSignal.any([controller.signal, AbortSignal.timeout(milliseconds)]);
function step(name: string) { steps.push({ name, at: new Date().toISOString() }); console.log(name); }
async function json(url: string, body?: unknown, method = "GET", milliseconds = 20_000): Promise<any> {
 const response = await fetch(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: signal(milliseconds), redirect: "error" });
 if (!response.ok) throw new Error(`${method} ${new URL(url).pathname} failed (${response.status}): ${(await response.text()).slice(0, 1000)}`);
 return response.json();
}
async function stopServer() {
 const child = server; if (!child) return;
 child.kill("SIGTERM");
 let exited = await Promise.race([child.exited.then(() => true), Bun.sleep(12_000).then(() => false)]);
 if (!exited) { child.kill("SIGKILL"); exited = await Promise.race([child.exited.then(() => true), Bun.sleep(5_000).then(() => false)]); }
 assert(exited && child.exitCode !== null, `Could not verify isolated server ${child.pid} stopped.`);
 server = undefined;
 step(`Stopped isolated server ${child.pid}`);
}
async function startServer() {
 controller.signal.throwIfAborted();
 reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
 const port = servicePort(reservation.port!,"QA API"); reservation.stop(true); reservation = undefined;
 base = `http://127.0.0.1:${port}`;
 server = Bun.spawn([process.execPath, join(runtime, "packages/server/server.ts")], { cwd: runtime,
  env: { ...process.env, PORT: String(port), HEED_APP_DIR: appDirectory, HEED_TRANSCRIPTION_URL: transcriptionUrl, OLLAMA_HOST: ollamaUrl },
  stdout: logDescriptor, stderr: logDescriptor, stdin: "ignore" });
 const deadline = Date.now() + 20_000;
 while (Date.now() < deadline) {
  controller.signal.throwIfAborted();
  assert(server.exitCode === null, `Isolated server exited (${server.exitCode}); inspect server.log.`);
  try { await json(`${base}/api/notes/settings`, undefined, "GET", 1000); step(`Started isolated server ${server.pid} on ${port}`); return; }
  catch { controller.signal.throwIfAborted(); await Bun.sleep(100); }
 }
 throw new Error("Isolated server was not ready within 20 seconds.");
}
async function current(label: string): Promise<Session> {
 const sessions = await json(`${base}/api/sessions`) as Session[];
 const session = sessions.find(session => session.id === id); assert(session, `Meeting missing at ${label}.`);
 assert(JSON.stringify(session.tags) === JSON.stringify(tags), `Tags changed at ${label}: ${JSON.stringify(session.tags)}`);
 snapshots[label] = session; return session;
}
const patch = (body: unknown) => json(`${base}/api/sessions?id=${id}`, body, "PATCH");
function copySources(source: string, destination: string, hashes: Record<string, string>) {
 mkdirSync(destination, { recursive: true, mode: 0o700 });
 for (const entry of readdirSync(source, { withFileTypes: true })) {
  if (entry.name === "node_modules" || entry.name === "dist" || entry.isSymbolicLink()) continue;
  const from = join(source, entry.name); const to = join(destination, entry.name);
  if (entry.isDirectory()) copySources(from, to, hashes);
  else if (entry.isFile() && /\.(ts|json)$/.test(entry.name) && !entry.name.endsWith(".test.ts")) {
   cpSync(from, to); const hash = createHash("sha256").update(readFileSync(from)).digest("hex");
   assert(createHash("sha256").update(readFileSync(to)).digest("hex") === hash, "Production source copy differs.");
   hashes[relative(repository, from)] = hash;
  }
 }
}
try {
 step("Checking installed engines (no downloads or service changes)");
 const health = await json(`${transcriptionUrl}/health`);
 assert(isTranscriptionHealth(health) && health.ready === true && health.whisper_info?.final_model === "parakeet-v3", "ASR must be ready with installed Parakeet v3.");
 report.transcriptionHealth = health;
 const models = await json(`${ollamaUrl}/api/tags`);
 assert(models.models?.some((model: { name: string }) => model.name === values.model), `Requested Ollama model ${values.model} is not installed.`);
 report.installedModel = models.models.find((model: { name: string }) => model.name === values.model);
 const hashes: Record<string, string> = {};
 copySources(join(repository, "packages/server"), join(runtime, "packages/server"), hashes);
 copySources(join(repository, "packages/shared"), join(runtime, "packages/shared"), hashes);
 copySources(join(repository,"config"),join(runtime,"config"),hashes);
 mkdirSync(join(runtime, "node_modules/@heed"), { recursive: true });
 symlinkSync(join(runtime, "packages/shared"), join(runtime, "node_modules/@heed/shared"), "dir");
 report.sourceHashes = hashes;
 mkdirSync(join(runtime, "recordings"), { recursive: true, mode: 0o700 });
 const fixtureAudio = join(runtime, "recordings", "synthetic.wav"); cpSync(audio, fixtureAudio);
 report.audio = { name: basename(audio), bytes: statSync(audio).size, sha256: createHash("sha256").update(readFileSync(audio)).digest("hex") };
 await startServer();
 step("Creating tagged meeting and refreshing API state");
 const provisionalText = values.language === "pt" ? "Prévia sintética provisória antes da transcrição final." : "Synthetic provisional preview before final transcription.";
 await json(`${base}/api/sessions`, { id, title: "Synthetic tag persistence acceptance", language: values.language, tags, transcriptFinalized: false,
  transcript: provisionalText, speakers: ["Provisional Speaker"], segments: [{ speaker: "Provisional Speaker", text: provisionalText, start: 0, end: 1, channel: "sys" }], files: { wav: fixtureAudio, srt: "", txt: "" } }, "POST");
 const initial = await current("refresh");
 await stopServer(); await startServer();
 const reopened = await current("firstRestart");
 assert(reopened.tagsRevision === initial.tagsRevision, "Tag assignment revision changed after restart.");
 step("Transcribing synthetic WAV through the real production recording-finalization route (10-minute ceiling)");
 const response = await fetch(`${base}/api/transcribe`, { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ input: fixtureAudio, language: values.language, recording_finalize: true, final_model: "parakeet-v3" }), signal: signal(600_000) });
 assert(response.ok, `Transcription failed (${response.status}).`);
 const frames = (await response.text()).split(/\r?\n\r?\n/).filter(Boolean).map(frame => {
  const lines = frame.split(/\r?\n/); const event = lines.find(line => line.startsWith("event:"))?.slice(6).trim();
  const data = lines.filter(line => line.startsWith("data:")).map(line => line.slice(5).trim()).join("\n");
  return { event, data: data ? JSON.parse(data) : null };
 });
 report.transcriptionEvents = frames;
 const failure = frames.find(frame => frame.event === "error"); assert(!failure, `Real ASR failed: ${JSON.stringify(failure?.data)}`);
 const result = frames.find(frame => frame.event === "result")?.data as TranscribeResult;
 assert(result?.success === true && result.finalized === true && result.metadata?.model === "parakeet-v3" && result.metadata.language === values.language
  && result.text?.trim() && result.segments?.length && result.speakers?.length, "Real final ASR did not return nonempty finalized audio in the requested language.");
 // Persist only returned transcription fields; deliberately omit tags and assignment revisions.
 await patch({ transcript: result.text, segments: result.segments, speakers: result.speakers, language: result.metadata.language,
  transcriptionModel: result.metadata.model, files: result.files, embeddings: result.embeddings, duration: result.duration, transcriptFinalized: true });
 const transcribed = await current("finalTranscription");
 assert(transcribed.transcript === result.text && JSON.stringify(transcribed.segments) === JSON.stringify(result.segments), "Returned final transcript was not saved intact.");
 assert(transcribed.transcriptRevision !== initial.transcriptRevision && transcribed.tagsRevision === initial.tagsRevision, "Retranscription did not update the source revision while preserving tag assignments.");
 const names = Object.fromEntries(result.speakers.map((speaker, index) => [speaker, `Synthetic Speaker ${index + 1}`]));
 step("Saving speaker names without rewriting tags");
 const namedSpeakers = result.speakers.map(speaker => names[speaker]);
 const namedSegments = result.segments.map(segment => ({ ...segment, speaker: names[segment.speaker] }));
 await patch({ speakers: namedSpeakers, segments: namedSegments });
 const renamed = await current("speakerNames");
 assert(renamed.transcript === result.text && renamed.tagsRevision === initial.tagsRevision, "Speaker edit changed the transcript or tag assignment revision.");
 assert(JSON.stringify(renamed.speakers) === JSON.stringify(namedSpeakers) && JSON.stringify(renamed.segments) === JSON.stringify(namedSegments)
  && renamed.transcriptRevision !== transcribed.transcriptRevision, "Speaker name patch was not saved intact with a new source revision.");
 // Enable only the isolated library, then use the production finalization transition to enqueue.
 await patch({ transcriptFinalized: false });
 await json(`${base}/api/notes/settings`, { enabled: true, model: values.model, templateId: "general", language: values.language }, "PATCH");
 await patch({ transcriptFinalized: true });
 step("Waiting for the real automatic-notes worker (10-minute ceiling; production generation timeout also applies)");
 const deadline = Date.now() + 600_000; let completed: Session | undefined; let lastProgress = 0;
 while (Date.now() < deadline) {
  controller.signal.throwIfAborted();
  const session = await current("notesProgress");
  const job = Object.values(session.notesJobs || {}).find(job => job.sourceRevision === session.transcriptRevision);
  assert(job, "Automatic notes job was not enqueued.");
  assert(!["failed", "cancelled", "superseded"].includes(job.status), `Real notes worker ${job.status}: ${job.reason || "unknown reason"}`);
  if (Date.now() - lastProgress >= 30_000) { console.log(`Notes: ${job.status}, ${job.generatedCharacters} characters`); lastProgress = Date.now(); }
  if (job.status === "completed") { completed = session; break; }
  await Bun.sleep(1000);
 }
 assert(completed?.aiNotes.trim(), "Automatic notes did not complete within 10 minutes.");
 assert(completed.notesMetadata?.origin === "automatic" && completed.notesMetadata.model === values.model && completed.notesMetadata.sourceRevision === completed.transcriptRevision
  && completed.notesMetadata.stale === false, "Completed notes provenance does not match the saved final transcript.");
 snapshots.notesCompleted = completed;
 await stopServer(); await startServer();
 const final = await current("finalRestart");
 for (const field of ["transcript", "segments", "speakers", "aiNotes", "notesMetadata", "notesJobs", "files", "transcriptionModel", "transcriptRevision", "tagsRevision"] as const) {
  assert(JSON.stringify(final[field]) === JSON.stringify(completed[field]), `${field} changed after the final restart.`);
 }
 assert(final.transcript === result.text && JSON.stringify(final.segments) === JSON.stringify(namedSegments)
  && JSON.stringify(final.speakers) === JSON.stringify(namedSpeakers) && final.tagsRevision === initial.tagsRevision, "Final content or tag revision differs from the accepted intermediate state.");
 report.status = "passed"; step("PASS: tags, final ASR, speaker names, and automatic notes survived refresh and server restarts");
} catch (error) {
 report.status = "failed"; report.error = (error as Error).message; process.exitCode ||= 1;
 console.error(`FAIL: ${(error as Error).message}`);
} finally {
 reservation?.stop(true);
 try { await stopServer(); report.startedProcessesStopped = true; }
 catch (error) { report.status = "failed"; report.cleanupError = (error as Error).message; process.exitCode ||= 1; console.error(`Cleanup failed: ${(error as Error).message}`); }
 report.completedAt = new Date().toISOString();
 closeSync(logDescriptor);
 try { if (evidence) {
  writeFileSync(join(evidence, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  cpSync(audio, join(evidence, "synthetic.wav"));
  if (existsSync(logPath)) cpSync(logPath, join(evidence, "server.log"));
  console.log(`Synthetic evidence: ${evidence}`);
 } } catch (error) { report.status = "failed"; process.exitCode ||= 1; console.error(`Could not save synthetic evidence: ${(error as Error).message}`); }
 if (!server) rmSync(directory, { recursive: true, force: true });
 else console.error(`Temporary runtime retained because server shutdown failed: ${directory}`);
 process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt);
 console.log(`Acceptance: ${report.status}. Semantic ASR and notes quality require human review.`);
}
