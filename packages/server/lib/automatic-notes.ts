import type { AiWaitingReason } from "@heed/shared";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { Session, SessionPatch } from "../../shared/types/session";
import type { AutomaticNotesSettings, NotesJob } from "../../shared/types/notes";
import type { Template } from "../../shared/types/template";
import type { SessionTags } from "./session-tags";
import { atomicWriteJson } from "./atomic-json";
import { sanitizeTranscriptionDiagnostics } from "./final-recording";

export interface NotesGenerationInput {
 session: Session;
 job: NotesJob;
 signal: AbortSignal;
 onProgress: (characters: number) => void;
}
export interface AutomaticNotesOptions {
 sessionsDir: string;
 sessionStore?: SessionTags;
 getSettings: () => AutomaticNotesSettings;
 loadTemplate: (id: string) => Template | undefined;
 generate: (input: NotesGenerationInput) => Promise<string>;
 isBusy: () => boolean;
 waitingReason?: () => AiWaitingReason;
 now?: () => Date;
}
export interface GuardedSessionPatch extends SessionPatch {
 expectedTranscriptRevision?: string;
 expectedNotes?: string;
}
export interface NotesRetryOptions { jobId?: string; replaceExisting?: boolean; expectedNotesHash?: string; }
export function notesHash(text: string): string { return createHash("sha256").update(text).digest("hex"); }
export function sourceRevision(session: Pick<Session, "transcript" | "language" | "speakers" | "segments">): string {
 return notesHash(JSON.stringify({ transcript: session.transcript, language: session.language, speakers: session.speakers || [], segments: (session.segments || []).map(({ speaker, start, end, text, channel }) => ({ speaker, start, end, text, channel })) }));
}
export function renderNotesTranscript(session: Session): string {
 return session.segments?.length ? session.segments.map(segment => `[${segment.speaker || "Unknown speaker"}] ${segment.text}`).join("\n") : session.transcript;
}
const activeStatuses = new Set(["queued", "waiting", "running"]);
const allowedLanguages = new Set(["en", "pt", "fr", "de"]);
const failureReasons = new Set(["template-missing", "model-missing", "transcript-empty", "language-unsupported", "existing-notes", "local-only", "ollama-unavailable", "generation-failed", "incomplete-output"]);

/** All read/modify/write operations are synchronous, including after generation awaits. */
export class AutomaticNotesService {
 readonly sessionsDir: string;
 private active?: { sessionId: string; jobId: string; attempt: number; controller: AbortController; done: Promise<void> };
 constructor(private readonly options: AutomaticNotesOptions) { this.sessionsDir = options.sessionsDir; mkdirSync(this.sessionsDir, { recursive: true }); }
 private timestamp(): string { return (this.options.now?.() || new Date()).toISOString(); }
 private path(id: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(id)) throw new Error("Invalid session id");
  return join(this.sessionsDir, `${id}.json`);
 }
 private save(session: Session): Session { for(const job of Object.values(session.notesJobs || {}))delete job.waitingReason; session.updatedAt = this.timestamp(); if (this.options.sessionStore) return this.options.sessionStore.save(session); atomicWriteJson(this.path(session.id), session); return session; }
 get(id: string): Session | null {
  this.path(id);
  if (this.options.sessionStore) { const session = this.options.sessionStore.read(id); return session ? this.normalize(session) : null; }
  const path = this.path(id); if (!existsSync(path)) return null;
  if (!lstatSync(path).isFile()) throw new Error("Invalid session file");
  const session: Session = JSON.parse(readFileSync(path, "utf8"));
  return this.normalize(session);
 }
 normalize(session: Session): Session {
  // Normalize legacy records for guarded editing without enqueueing or writing them on read.
  session.transcriptRevision ||= sourceRevision(session);
  if (session.aiNotes?.trim() && !session.notesMetadata) session.notesMetadata = { origin: "manual", sourceRevision: session.transcriptRevision, stale: false };
  for(const job of Object.values(session.notesJobs || {})) {
   if (["queued", "waiting"].includes(job.status) && this.options.getSettings().enabled) job.waitingReason = this.options.waitingReason?.();
   else delete job.waitingReason;
  }
  return session;
 }
 list(): Session[] {
  if (this.options.sessionStore) return this.options.sessionStore.snapshot().sessions.map(session => this.normalize(session)).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return readdirSync(this.sessionsDir).filter(file => file.endsWith(".json")).flatMap(file => {
   try { const result = this.get(file.slice(0, -5)); return result ? [result] : []; } catch { return []; }
  }).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
 }
 private require(id: string): Session { const session = this.get(id); if (!session) throw new Error("Session not found"); return session; }
 create(input: Partial<Session>): Session {
  if (input.id) this.path(input.id);
  if (input.files?.wav) { const existingRecording = this.list().find(session => session.files?.wav === input.files!.wav); if (existingRecording) return existingRecording; }
  const id = input.id || (input.files?.wav ? `recording-${notesHash(input.files.wav).slice(0, 32)}` : `session-${randomUUID()}`);
  const existing = this.get(id); if (existing) return existing;
  const transcriptionDiagnostics=sanitizeTranscriptionDiagnostics(input.transcriptionDiagnostics);
  const session: Session = { id, title: input.title || "Untitled meeting", createdAt: input.createdAt || this.timestamp(), duration: input.duration || 0, language: input.language || "en", transcript: input.transcript || "", speakers: input.speakers || [], segments: input.segments || [], aiNotes: input.aiNotes || "", summary: input.summary || "", tags: input.tags || [], pinned: !!input.pinned, files: input.files, embeddings: input.embeddings, transcriptionModel: input.transcriptionModel, liveModel: input.liveModel, transcriptFinalized: input.transcriptFinalized === true };
  if(transcriptionDiagnostics) session.transcriptionDiagnostics=transcriptionDiagnostics;
  session.transcriptRevision = sourceRevision(session);
  if (session.aiNotes) session.notesMetadata = { origin: "manual", stale: false, sourceRevision: session.transcriptRevision };
  if (session.transcriptFinalized && this.options.getSettings().enabled) this.enqueue(session);
  if (this.options.sessionStore) { session.updatedAt = this.timestamp(); return this.options.sessionStore.create(session); }
  return this.save(session);
 }
 patch(id: string, patch: GuardedSessionPatch): Session {
  const existing = this.require(id);
  if (this.options.sessionStore) patch = this.options.sessionStore.preparePatch(existing, patch);
  if (patch.expectedTranscriptRevision !== undefined && patch.expectedTranscriptRevision !== existing.transcriptRevision) throw new Error("Transcript changed; reload before saving notes");
  if (patch.expectedNotes !== undefined && patch.expectedNotes !== existing.aiNotes) throw new Error("Notes changed; reload before saving notes");
  const { id: _id, createdAt: _created, transcriptRevision: _revision, notesJobs: _jobs, notesMetadata: _metadata, expectedTranscriptRevision: _expectedRevision, expectedNotes: _expectedNotes, ...mutable } = patch as GuardedSessionPatch & { id?: string; createdAt?: string };
  const session = { ...existing, ...mutable };
  const transcriptionDiagnostics=sanitizeTranscriptionDiagnostics(session.transcriptionDiagnostics);
  if(transcriptionDiagnostics) session.transcriptionDiagnostics=transcriptionDiagnostics;
  else delete session.transcriptionDiagnostics;
  session.transcriptRevision = sourceRevision(session);
  const revised = session.transcriptRevision !== existing.transcriptRevision;
  const manual = Object.hasOwn(mutable, "aiNotes");
  if (manual || revised || (existing.transcriptFinalized && !session.transcriptFinalized)) {
   for (const job of Object.values(session.notesJobs || {})) if (activeStatuses.has(job.status)) { job.status = "superseded"; job.reason = manual ? "notes-changed" : "transcript-changed"; job.updatedAt = this.timestamp(); }
   if (this.active?.sessionId === id) this.active.controller.abort();
  }
  if (manual) session.notesMetadata = { origin: "manual", sourceRevision: session.transcriptRevision, stale: false };
  else if (revised && session.notesMetadata) session.notesMetadata = { ...session.notesMetadata, stale: session.notesMetadata.sourceRevision !== session.transcriptRevision };
  if (session.transcriptFinalized && (revised || !existing.transcriptFinalized) && this.options.getSettings().enabled) this.enqueue(session);
  return this.save(session);
 }
 delete(id: string): boolean { const path = this.path(id); this.options.sessionStore?.recover(); if (this.active?.sessionId === id) this.active.controller.abort(); if (!existsSync(path)) return false; if (this.options.sessionStore) this.options.sessionStore.remove(id); else unlinkSync(path); return true; }
 private snapshot(session: Session, old?: NotesJob, retry: NotesRetryOptions = {}): NotesJob {
  const settings = this.options.getSettings();
  let template: Template | undefined;
  try { template = this.options.loadTemplate(settings.templateId); } catch { /* A removed or malformed template becomes a durable job failure. */ }
  const job: NotesJob = { id: old?.id || `notes-${session.transcriptRevision}`, sourceRevision: session.transcriptRevision!, status: "queued", templateId: settings.templateId, templateName: template?.name || settings.templateId, templateHash: notesHash(template?.prompt || ""), templatePrompt: template?.prompt || "", model: settings.model || "", language: settings.language === "meeting" ? session.language : settings.language, attempts: old?.attempts || 0, generatedCharacters: 0, retryable: true, updatedAt: this.timestamp(), expectedNotesHash: notesHash(session.aiNotes), replaceExisting: !!retry.replaceExisting };
  const reason = !template?.prompt?.trim() ? "template-missing" : !settings.model?.trim() ? "model-missing" : !renderNotesTranscript(session).trim() ? "transcript-empty" : !allowedLanguages.has(job.language) || !allowedLanguages.has(session.language) ? "language-unsupported" : session.aiNotes.trim() && !retry.replaceExisting ? "existing-notes" : undefined;
  if (reason) { job.status = "failed"; job.reason = reason; }
  return job;
 }
 private enqueue(session: Session): void {
  const id = `notes-${session.transcriptRevision}`;
  const previous = session.notesJobs?.[id];
  if (previous && previous.status !== "superseded") return;
  session.notesJobs = { ...session.notesJobs, [id]: this.snapshot(session, previous) };
 }
 recover(): void { this.recoverRunning(this.list()); }
 private recoverRunning(sessions: Session[]): void {
  for (const session of sessions) {
   let changed = false;
   for (const job of Object.values(session.notesJobs || {})) if (job.status === "running") { job.status = "waiting"; job.reason = "interrupted"; job.generatedCharacters = 0; job.updatedAt = this.timestamp(); changed = true; }
   if (changed) this.save(session);
  }
 }
 cancel(sessionId: string, jobId?: string): Session {
  const session = this.require(sessionId); const job = this.findJob(session, jobId);
  if (activeStatuses.has(job.status) || job.status === "failed") { job.status = "cancelled"; job.reason = "cancelled"; job.generatedCharacters = 0; job.updatedAt = this.timestamp(); }
  if (this.active?.sessionId === sessionId && this.active.jobId === job.id) this.active.controller.abort();
  return this.save(session);
 }
 private findJob(session: Session, id?: string): NotesJob {
  const job = id ? session.notesJobs?.[id] : Object.values(session.notesJobs || {}).find(job => job.sourceRevision === session.transcriptRevision);
  if (!job) throw new Error("Notes job not found"); return job;
 }
 retry(sessionId: string, options: NotesRetryOptions = {}): Session {
  const session = this.require(sessionId); const old = this.findJob(session, options.jobId);
  if (!session.transcriptFinalized || old.sourceRevision !== session.transcriptRevision) throw new Error("Transcript changed; retry the current revision");
  if (old.status === "running") throw new Error("Notes generation is already running");
  if (session.aiNotes.trim()) {
   if (!options.replaceExisting) throw new Error("Existing notes require explicit replacement");
   if (options.expectedNotesHash !== notesHash(session.aiNotes)) throw new Error("Notes changed; reload before replacing notes");
  }
  session.notesJobs![old.id] = this.snapshot(session, old, options);
  return this.save(session);
 }
 get busy(): boolean { return !!this.active; }
 async preempt(): Promise<void> {
  const active = this.active; if (!active) return;
  const session = this.get(active.sessionId); const job = session?.notesJobs?.[active.jobId];
  if (session && job?.status === "running") { job.status = "waiting"; job.reason = "resources-busy"; job.generatedCharacters = 0; job.updatedAt = this.timestamp(); this.save(session); }
  active.controller.abort(); await active.done;
 }
 async tick(): Promise<void> {
  if (this.active) return;
  // An idle worker may follow a failed storage read; recover its durable running job.
  const sessions = this.list();
  this.recoverRunning(sessions);
  const candidate = sessions.reverse().flatMap(session => Object.values(session.notesJobs || {}).map(job => ({ session, job }))).find(({ job }) => job.status === "queued" || job.status === "waiting");
  if (!candidate) return;
  const { session, job } = candidate;
  if (!this.options.getSettings().enabled || this.options.isBusy()) { job.status = "waiting"; job.reason = this.options.getSettings().enabled ? "resources-busy" : "disabled"; job.updatedAt = this.timestamp(); this.save(session); return; }
  if (!session.transcriptFinalized || session.transcriptRevision !== job.sourceRevision) { job.status = "superseded"; job.reason = "transcript-changed"; this.save(session); return; }
  job.status = "running"; delete job.reason; job.attempts++; job.generatedCharacters = 0; job.updatedAt = this.timestamp(); this.save(session);
  const controller = new AbortController();
  const active = { sessionId: session.id, jobId: job.id, attempt: job.attempts, controller, done: Promise.resolve() };
  this.active = active;
  active.done = this.execute(session, job, controller);
  try { await active.done; } finally { if (this.active === active) this.active = undefined; }
 }
 private async execute(snapshot: Session, expected: NotesJob, controller: AbortController): Promise<void> {
  try {
   let lastProgressAt = 0;
   const text = await this.options.generate({ session: snapshot, job: expected, signal: controller.signal, onProgress: characters => {
    const now = Date.now(); if (now - lastProgressAt < 500) return; lastProgressAt = now;
    const session = this.get(snapshot.id); const job = session?.notesJobs?.[expected.id];
    if (session && job?.status === "running" && job.attempts === expected.attempts && !controller.signal.aborted) { job.generatedCharacters = Math.max(0, characters); job.updatedAt = this.timestamp(); this.save(session); }
   } });
   const session = this.get(snapshot.id); const job = session?.notesJobs?.[expected.id];
   if (!session || !job || job.status !== "running" || job.attempts !== expected.attempts || controller.signal.aborted) return;
   if (session.transcriptRevision !== expected.sourceRevision || !session.transcriptFinalized || notesHash(session.aiNotes) !== expected.expectedNotesHash || (session.aiNotes.trim() && !expected.replaceExisting)) { job.status = "superseded"; job.reason = "transcript-changed"; this.save(session); return; }
   if (!text.trim()) throw new Error("incomplete-output");
   session.aiNotes = text; session.notesMetadata = { origin: "automatic", sourceRevision: expected.sourceRevision, templateId: expected.templateId, templateName: expected.templateName, templateHash: expected.templateHash, model: expected.model, language: expected.language, generatedAt: this.timestamp(), stale: false };
   job.status = "completed"; job.retryable = false; job.generatedCharacters = text.length; job.updatedAt = this.timestamp(); delete job.reason; this.save(session);
  } catch (error) {
   const session = this.get(snapshot.id); const job = session?.notesJobs?.[expected.id];
   if (!session || !job || job.status !== "running" || job.attempts !== expected.attempts) return;
   job.status = controller.signal.aborted ? "waiting" : "failed"; job.reason = controller.signal.aborted ? "interrupted" : failureReasons.has((error as Error).message) ? (error as Error).message : "generation-failed"; job.retryable = true; job.generatedCharacters = 0; job.updatedAt = this.timestamp(); this.save(session);
  }
 }
}
