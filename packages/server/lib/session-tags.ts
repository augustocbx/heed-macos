import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fsyncSync, fstatSync, lstatSync, openSync, opendirSync, readFileSync, readSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {reserveAtomicWrite} from './atomic-json';
import { normalizeTag, tagKey, uniqueTags, type Session, type SessionPatch, type TagMutation, type TagSnapshot } from "@heed/shared";
import { isDeepStrictEqual } from "node:util";
import type { RecognitionGeneration, TranscriptEditingState, TranscriptGuard } from "../../shared/types/transcript-editing";
import { sourceRevision } from "../../shared/lib/transcript-source";
import { normalizeTranscriptSession, renderAcceptedTranscript } from "./transcript-editing";
import { sanitizeTranscriptionDiagnostics } from "./final-recording";

export class TagError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export function atomicWrite(path: string, data: string): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const release=reserveAtomicWrite(path,Buffer.byteLength(data,'utf8'),temporary);
  try {
    const fd = openSync(temporary, "wx", 0o600);
    try { writeFileSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, path);
    const directory = openSync(dirname(path), "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } finally {
    try {if (existsSync(temporary)) unlinkSync(temporary);}finally{release();}
  }
}

type Entry = { id: string; before: string; after: string };
type Journal = { committed: boolean; entries: Entry[] };
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const assignmentRevision = (session: Session) => hash(session.tags ?? []);
const sourceFields = ["transcript", "segments", "speakers", "language", "transcriptFinalized", "transcriptionModel", "duration", "embeddings", "transcriptionDiagnostics"] as const;
const metadataFields = ["title", "aiNotes", "summary", "tags", "pinned", "files", "audioArchived", "liveModel"] as const;
const same = (a: unknown, b: unknown): boolean => isDeepStrictEqual(JSON.parse(JSON.stringify(a ?? null)), JSON.parse(JSON.stringify(b ?? null)));
const acceptedFields = (session: Session) => Object.fromEntries(sourceFields.map(key => [key, session[key]]));
export function acceptedSourceChanged(before: Session, after: Session): boolean { return !same(acceptedFields(before), acceptedFields(after)); }
export function acceptedTranscriptChanged(before:Session,after:Session):boolean {
 const history=(session:Session)=>session.transcriptEditing?{activeGenerationId:session.transcriptEditing.activeGenerationId,generations:session.transcriptEditing.generations,edits:session.transcriptEditing.edits}:undefined;
 return acceptedSourceChanged(before,after)||!same(history(before),history(after));
}
export function sourcePatch(patch: SessionPatch): boolean { return sourceFields.some(key => Object.hasOwn(patch, key)); }
export function transcriptGuard(session: Session): TranscriptGuard { return { expectedTranscriptRevision: sourceRevision(session), expectedTranscriptVersion: session.transcriptVersion ?? 0 }; }
export function checkTranscriptGuard(session: Session, guard: TranscriptGuard | null): void {
 if (!guard || typeof guard.expectedTranscriptRevision !== "string" || !Number.isSafeInteger(guard.expectedTranscriptVersion) || guard.expectedTranscriptVersion < 0) throw new TagError("Transcript revision and version are required");
 if (guard.expectedTranscriptRevision !== sourceRevision(session) || guard.expectedTranscriptVersion !== (session.transcriptVersion ?? 0)) throw new TagError("Transcript changed. Reload and try again.", 409);
}
export function normalizeNotesSource(session: Session): Session {
 if (!session.aiNotes?.trim()) return session;
 const metadata = session.notesMetadata;
 if (!metadata || typeof metadata.sourceRevision !== "string" || !metadata.sourceRevision) return { ...session, notesMetadata: { ...metadata, origin: metadata?.origin ?? "manual", sourceRevision: null, stale: true } };
 return session;
}
export function speakerOnly(before: Session, after: Session): boolean {
 const withoutIdentity = (session: Session) => ({ ...acceptedFields(session), transcript: undefined, speakers: undefined, embeddings: undefined,
  segments: (session.segments ?? []).map(({ speaker, auto, ...rest }) => rest) });
 return same(withoutIdentity(before), withoutIdentity(after)) && ((before.segments?.length ?? 0) > 0 || before.transcript === after.transcript);
}
function generation(session: Session, origin: RecognitionGeneration["origin"]): RecognitionGeneration {
 const diagnostics = sanitizeTranscriptionDiagnostics(session.transcriptionDiagnostics);
 return { id: `generation-${randomUUID()}`, createdAt: new Date().toISOString(), origin, transcript: session.transcript, segments: structuredClone(session.segments ?? []), speakers: [...(session.speakers ?? [])], language: session.language, duration: session.duration,
  ...(session.transcriptionModel !== undefined ? { transcriptionModel: session.transcriptionModel } : {}), ...(diagnostics ? { transcriptionDiagnostics: diagnostics } : {}) };
}
function preserveRecovery(current: Session, next: Session): TranscriptEditingState {
 let prior = current.transcriptEditing;
 const hadHistory = !!prior;
 if (!prior) {
  const preserved = next.transcriptEditing?.generations.find(value => value.origin === "legacy-preserved" && value.transcript === current.transcript && same(value.segments, current.segments ?? []) && same(value.speakers, current.speakers ?? []) && value.language === current.language && value.duration === current.duration && value.transcriptionModel === current.transcriptionModel && same(value.transcriptionDiagnostics, sanitizeTranscriptionDiagnostics(current.transcriptionDiagnostics)));
  const original = preserved ?? generation(current, "legacy-preserved"); prior = { schemaVersion: 1, activeGenerationId: original.id, generations: [original], edits: [], candidates: [], candidateRequestReceipts: [] };
 }
 let state = next.transcriptEditing ?? prior;
 if (!hadHistory && !state.generations.some(value => value.id === prior.activeGenerationId)) state = { ...state, generations: [...prior.generations, ...state.generations] };
 for (const collection of ["generations", "edits", "candidateRequestReceipts"] as const) {
  if (prior[collection].some(value => !state[collection].some(saved => same(value, saved)))) throw new TagError("Transcript recovery history cannot be removed", 409);
 }
 if (prior.candidates.some(candidate => !state.candidates.some(saved => same(candidate, saved)) && !state.candidateRequestReceipts.some(receipt => receipt.candidateId === candidate.id && receipt.status === "accepted"))) throw new TagError("Pending transcript candidates must be retained", 409);
 if (!speakerOnly(current, next) && state.activeGenerationId === prior.activeGenerationId && same(prior.edits, state.edits)) {
  const accepted = generation(next, "recognition"); state = { ...state, activeGenerationId: accepted.id, generations: [...state.generations, accepted] };
 }
 return state;
}
function validateRecoveryBounds(session: Session): void {
 const state = session.transcriptEditing;
 if (state && (state.schemaVersion !== 1 || !state.generations.some(value => value.id === state.activeGenerationId))) throw new TagError("Invalid transcript recovery state");
 const { files, embeddings, transcriptionDiagnostics, transcriptVersion, transcriptRevision, transcriptEditing, notesJobs, tagsRevision, audioArchived, ...accepted } = session;
 const portable = { ...accepted, transcriptEditing: state ? { schemaVersion: 1, activeGenerationId: state.activeGenerationId,
  generations: state.generations.map(({ transcriptionDiagnostics, ...value }) => value), edits: state.edits.map(({ requestId, requestSignature, ...value }) => value) } : undefined };
 if (Buffer.byteLength(JSON.stringify(portable)) > 16_000_000) throw new TagError("Accepted transcript and recovery history exceed the size limit", 409);
 if (state && (state.candidates.length > 2 || state.candidates.some(candidate => Buffer.byteLength(JSON.stringify(candidate)) > 16_000_000) || state.candidateRequestReceipts.length > 1_000)) throw new TagError("Transcript candidate state exceeds the size limit", 409);
}

export type CommittedSessionChange = { kind: "upsert"; session: Session } | { kind: "delete"; sessionId: string } | { kind: "invalidate" };
/** All operations are synchronous after request parsing, so one server cannot interleave commits. */
export class SessionTags {
  private journal: string;
  private recovering = false;
  private committedListeners = new Set<{ listener: (change: CommittedSessionChange) => void; onError: (error: unknown) => void }>();
  constructor(private directory: string, private io = { writeAtomic: atomicWrite }) {
    this.journal = join(directory, ".tag-transaction");
  }
  subscribeCommitted(listener: (change: CommittedSessionChange) => void, onError: (error: unknown) => void): () => void {
    const subscription = { listener, onError }; this.committedListeners.add(subscription);
    return () => { this.committedListeners.delete(subscription); };
  }
  private notifyCommitted(change: CommittedSessionChange): void {
    for (const subscription of [...this.committedListeners]) {
      try { subscription.listener(structuredClone(change)); }
      catch (error) { try { subscription.onError(error); } catch { /* Observers cannot turn durable success into a failed save. */ } }
    }
  }
  private commitRecord(session: Session): Session {
    try {
      this.io.writeAtomic(this.path(session.id), JSON.stringify({ ...session, tagsRevision: undefined }, null, 2));
      const saved = this.read(session.id)!; this.notifyCommitted({ kind: "upsert", session: saved }); return saved;
    } catch (error) {
      // Rename may already have succeeded before a durability/budget cleanup error.
      // Invalidate scope metadata without publishing a potentially tentative upsert.
      this.notifyCommitted({ kind: "invalidate" }); throw error;
    }
  }
  /** Streaming enumeration avoids parsing or allocating an entire library during discovery. */
  *sourceIds(maximum: number): IterableIterator<string> {
    if (!Number.isSafeInteger(maximum) || maximum < 1) throw new TagError("Invalid source discovery budget");
    this.recover(); const directory = opendirSync(this.directory); let count = 0;
    try {
      for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
        if (!entry.name.endsWith(".json")) continue;
        if (++count > maximum) throw new TagError("Source discovery capacity exceeded", 409);
        yield entry.name.slice(0, -5);
      }
    } finally { directory.closeSync(); }
  }

  private path(id: string): string {
    if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) throw new TagError("Invalid meeting ID");
    const path = join(this.directory, `${id}.json`);
    if (existsSync(path) && !lstatSync(path).isFile()) throw new TagError("Invalid meeting file", 500);
    return path;
  }

  recover(): void {
    if (this.recovering) return;
    if (!existsSync(this.journal)) return;
    this.recovering = true;
    try {
    if (!lstatSync(this.journal).isFile()) throw new TagError("Invalid tag transaction", 500);
    const journal: Journal = JSON.parse(readFileSync(this.journal, "utf8"));
    if (!Array.isArray(journal.entries) || typeof journal.committed !== "boolean") throw new TagError("Invalid tag transaction", 500);
    // Validate the entire journal before restoring any file.
    for (const entry of journal.entries) {
      this.path(entry.id);
      if (typeof entry.before !== "string" || typeof entry.after !== "string") throw new TagError("Invalid tag transaction", 500);
    }
    if (!journal.committed) {
      for (const entry of journal.entries) this.io.writeAtomic(this.path(entry.id), entry.before);
      unlinkSync(this.journal);
      this.notifyCommitted({ kind: "invalidate" });
    } else {
      // The commit is durable; a cleanup failure must not turn success into a false failed save.
      try { unlinkSync(this.journal); } catch { /* Retry cleanup on the next request. */ }
      for (const entry of journal.entries) { const session = this.read(entry.id); if (session) this.notifyCommitted({ kind: "upsert", session }); }
    }
    } catch (error) { this.notifyCommitted({ kind: "invalidate" }); throw error; }
    finally { this.recovering = false; }
  }

  read(id: string, maximumBytes?: number): Session | null {
    return this.readRecord(id, maximumBytes).session;
  }

  /** Exact original JSON byte accounting for bounded read-only retrieval. */
  readSized(id: string, maximumBytes: number): {session: Session | null; bytes: number} {
    return this.readRecord(id, maximumBytes);
  }

  private readRecord(id: string, maximumBytes?: number): {session: Session | null; bytes: number} {
    this.recover();
    const path = this.path(id);
    if (!existsSync(path)) return {session: null, bytes: 0};
    let raw: string; let originalBytes: number;
    if (maximumBytes === undefined) { raw = readFileSync(path, "utf8"); originalBytes = Buffer.byteLength(raw); }
    else {
      if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) throw new TagError("Invalid source record budget");
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.size > maximumBytes) throw new TagError("Source record exceeds the retrieval size limit", 409);
        const buffer = Buffer.alloc(stat.size + 1); let bytes = 0;
        while (bytes < buffer.length) { const received = readSync(fd, buffer, bytes, buffer.length - bytes, null); if (!received) break; bytes += received; }
        if (bytes > stat.size) throw new TagError("Source record changed during retrieval read", 409);
        raw = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytes)); originalBytes = bytes;
      } finally { closeSync(fd); }
    }
    const session = JSON.parse(raw) as Session;
    if (!session || session.id !== id || (session.tags !== undefined && (!Array.isArray(session.tags) || session.tags.some(t => typeof t !== "string")))) {
      throw new TagError("Invalid meeting file", 500);
    }
    return {session: normalizeNotesSource(normalizeTranscriptSession({ ...session, tags: session.tags ?? [], tagsRevision: assignmentRevision(session) })), bytes: originalBytes};
  }

  snapshot(): TagSnapshot {
    this.recover();
    const sessions = readdirSync(this.directory).filter(f => f.endsWith(".json")).sort().map(file => this.read(file.slice(0, -5))!);
    const tags = new Map<string, { name: string; meetingCount: number }>();
    for (const session of sessions) {
      for (const name of uniqueTags(session.tags)) {
        const key = tagKey(name);
        const existing = tags.get(key);
        if (existing) existing.meetingCount++; else tags.set(key, { name, meetingCount: 1 });
      }
    }
    return {
      sessions,
      tags: [...tags.values()].sort((a, b) => a.name.localeCompare(b.name)),
      revision: hash(sessions.map(s => [s.id, s.tags])),
    };
  }

  create(session: Session): Session {
    this.recover();
    const path = this.path(session.id);
    if (existsSync(path)) throw new TagError("Meeting already exists", 409);
    const tags = uniqueTags(session.tags ?? [], this.snapshot().tags.map(t => t.name));
    return this.commitSource(session.id, null, () => ({ ...session, tags }));
  }

  /** Validate the raw client patch before merging so missing revisions cannot be inherited. */
  preparePatch(existing: Session, patch: SessionPatch): SessionPatch {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new TagError("Invalid meeting patch");
    if (sourcePatch(patch)) checkTranscriptGuard(existing, patch as TranscriptGuard);
    const fields: SessionPatch = Object.fromEntries([...metadataFields, ...sourceFields].filter(key => Object.hasOwn(patch, key)).map(key => [key, patch[key]]));
    if (Object.hasOwn(fields, "transcriptionDiagnostics")) fields.transcriptionDiagnostics = sanitizeTranscriptionDiagnostics(fields.transcriptionDiagnostics);
    if (fields.segments !== undefined && !Array.isArray(fields.segments)) throw new TagError("Invalid transcript segments");
    if (fields.speakers !== undefined && (!Array.isArray(fields.speakers) || fields.speakers.some(value => typeof value !== "string"))) throw new TagError("Invalid transcript speakers");
    if (sourcePatch(patch) && existing.transcriptFinalized && ((Object.hasOwn(fields, "transcript") && fields.transcript !== existing.transcript) || !speakerOnly(existing, { ...existing, ...fields }))) throw new TagError("Use transcript commands to change saved text");
    const tagsRevision = patch.tagsRevision;
    if (fields.tags !== undefined) {
      if (tagsRevision !== existing.tagsRevision) throw new TagError("Tags changed. Reload and try again.", 409);
      if (!Array.isArray(fields.tags) || fields.tags.some(t => typeof t !== "string" || !normalizeTag(t))) throw new TagError("Enter a tag name");
      fields.tags = uniqueTags(fields.tags, this.snapshot().tags.map(t => t.name));
    }
    return fields;
  }

  /** The only accepted-source writer: read, guard, build and one reserved atomic save. */
  commitSource(id: string, guard: TranscriptGuard | null, build: (current: Session | null) => Session): Session {
    const current = this.read(id);
    if (current) checkTranscriptGuard(current, guard);
    else if (guard !== null) throw new TagError("Meeting not found", 404);
    let next = build(current ? structuredClone(current) : null);
    if (!next || next.id !== id || (current && next.createdAt !== current.createdAt)) throw new TagError("Invalid accepted meeting identity");
    if ((!current || acceptedSourceChanged(current, next)) && next.segments?.length) next = { ...next, transcript: renderAcceptedTranscript(next.segments) };
    const changed = !current || acceptedTranscriptChanged(current, next);
    const oldVersion = current?.transcriptVersion ?? 0;
    if (changed && oldVersion === Number.MAX_SAFE_INTEGER) throw new TagError("Transcript version limit reached", 409);
    if (current?.transcriptFinalized && changed) next = { ...next, transcriptEditing: preserveRecovery(current, next) };
    else if (current && !same(current.transcriptEditing, next.transcriptEditing)) throw new TagError("Use the transcript-state boundary for metadata", 409);
    next = normalizeNotesSource({ ...next, transcriptRevision: sourceRevision(next), transcriptVersion: changed ? oldVersion + 1 : oldVersion });
    if (current && changed) {
      if (next.aiNotes === current.aiNotes && same(next.notesMetadata, current.notesMetadata) && next.notesMetadata) next.notesMetadata = { ...next.notesMetadata, stale: true };
      for (const job of Object.values(next.notesJobs ?? {})) {
        if (["queued", "waiting", "running"].includes(job.status) && (job.sourceRevision !== next.transcriptRevision || (job.sourceVersion ?? oldVersion) !== next.transcriptVersion)) {
          job.status = "superseded"; job.reason = "transcript-changed"; job.updatedAt = next.updatedAt ?? new Date().toISOString();
        }
      }
    }
    validateRecoveryBounds(next);
    if (current && same(current, next)) return current;
    return this.commitRecord(next);
  }

  /** Candidate/receipt metadata never changes the accepted source or accepted history. */
  commitTranscriptState(id: string, build: (current: Session) => Session): Session {
    const current = this.read(id);
    if (!current) throw new TagError("Meeting not found", 404);
    const next = build(structuredClone(current));
    if (next.id !== current.id || next.createdAt !== current.createdAt || acceptedSourceChanged(current, next) || next.transcriptVersion !== current.transcriptVersion || next.transcriptRevision !== current.transcriptRevision) throw new TagError("Transcript state cannot replace the accepted source", 409);
    const before = current.transcriptEditing, after = next.transcriptEditing;
    if (before && (!after || before.activeGenerationId !== after.activeGenerationId || !same(before.generations, after.generations) || !same(before.edits, after.edits))) throw new TagError("Transcript state cannot replace accepted history", 409);
    if (!before && after && (after.edits.length || after.generations.length !== 1 || !same(after.generations[0]?.segments, current.segments ?? []) || after.generations[0]?.transcript !== current.transcript)) throw new TagError("Invalid transcript baseline");
    if (before && after && (before.candidateRequestReceipts.some(receipt => !after.candidateRequestReceipts.some(saved => same(receipt, saved))) || before.candidates.some(candidate => !after.candidates.some(saved => same(candidate, saved)) && !after.candidateRequestReceipts.some(receipt => receipt.candidateId === candidate.id && receipt.status === "discarded")))) throw new TagError("Transcript candidate receipts cannot be removed", 409);
    validateRecoveryBounds(next);
    return this.commitRecord(next);
  }

  /** Trusted synchronous metadata writes preserve assignments exactly. */
  save(session: Session): Session {
    const current = this.read(session.id);
    if (!current) throw new TagError("Meeting not found", 404);
    if (acceptedSourceChanged(current, session) || (session.transcriptVersion ?? 0) !== current.transcriptVersion || (session.transcriptRevision !== undefined && session.transcriptRevision !== current.transcriptRevision) || !same(current.transcriptEditing, session.transcriptEditing)) throw new TagError("Metadata save cannot replace transcript state", 409);
    validateRecoveryBounds(session);
    return this.commitRecord(session);
  }

  patch(id: string, patch: SessionPatch): Session {
    const existing = this.read(id);
    if (!existing) throw new TagError("Meeting not found", 404);
    const fields = this.preparePatch(existing, patch);
    const next = { ...existing, ...fields, updatedAt: new Date().toISOString() };
    if (sourcePatch(patch)) {
      if (existing.transcriptFinalized && !speakerOnly(existing, next)) throw new TagError("Use transcript commands to change saved text");
      return this.commitSource(id, patch as TranscriptGuard, () => next);
    }
    return this.save(next);
  }

  remove(id: string): void {
    this.recover();
    const path = this.path(id);
    if (existsSync(path)) { unlinkSync(path); this.notifyCommitted({ kind: "delete", sessionId: id }); }
  }

  mutate(input: TagMutation): TagSnapshot {
    const snapshot = this.snapshot();
    if (!input || typeof input.tag !== "string" || !normalizeTag(input.tag)) throw new TagError("Enter a tag name");
    if (!["add", "remove", "rename", "delete"].includes(input.action)) throw new TagError("Invalid tag action");
    if (input.expectedRevision !== snapshot.revision) throw new TagError("Tags changed. Reload and try again.", 409);
    const key = tagKey(input.tag);
    const known = snapshot.tags.find(t => tagKey(t.name) === key);
    let name = known?.name ?? normalizeTag(input.tag);
    if (input.action === "rename") {
      if (typeof input.name !== "string" || !normalizeTag(input.name)) throw new TagError("Enter a tag name");
      name = normalizeTag(input.name);
      if (snapshot.tags.some(t => tagKey(t.name) === tagKey(name) && tagKey(t.name) !== key)) throw new TagError("Tag already exists", 409);
    }
    if (input.action !== "add" && !known) throw new TagError("Tag not found", 404);
    if ((input.action === "add" || input.action === "remove") && !snapshot.sessions.some(s => s.id === input.sessionId)) throw new TagError("Meeting not found", 404);

    const entries: Entry[] = [];
    for (const session of snapshot.sessions) {
      if ((input.action === "add" || input.action === "remove") && session.id !== input.sessionId) continue;
      const hasTag = session.tags.some(t => tagKey(t) === key);
      let tags = session.tags;
      if (input.action === "add") tags = uniqueTags([...tags, name], snapshot.tags.map(t => t.name));
      else if (input.action === "rename" && hasTag) tags = uniqueTags(tags.map(t => tagKey(t) === key ? name : t));
      else if (hasTag) tags = tags.filter(t => tagKey(t) !== key);
      if (JSON.stringify(tags) === JSON.stringify(session.tags)) continue;
      const path = this.path(session.id);
      entries.push({ id: session.id, before: readFileSync(path, "utf8"), after: JSON.stringify({ ...session, tags, tagsRevision: undefined, updatedAt: new Date().toISOString() }, null, 2) });
    }
    if (!entries.length) return snapshot;
    // One durable journal stages every original and replacement before the first change.
    this.io.writeAtomic(this.journal, JSON.stringify({ committed: false, entries }));
    try {
      for (const entry of entries) this.io.writeAtomic(this.path(entry.id), entry.after);
      this.io.writeAtomic(this.journal, JSON.stringify({ committed: true, entries }));
    } catch (error) {
      this.recover();
      throw error;
    }
    this.recover();
    return this.snapshot();
  }
}

export async function tagResponse(req: Request, store: SessionTags, normalize: (session: Session) => Session = session => session): Promise<Response> {
  try {
    const snapshot = req.method === "GET" ? store.snapshot() : store.mutate(await req.json());
    return Response.json({ ...snapshot, sessions: snapshot.sessions.map(normalize) });
  } catch (error) {
    const message = error instanceof TagError ? error.message : "Failed to save tags";
    return Response.json({ error: message }, { status: error instanceof TagError ? error.status : 500 });
  }
}

export async function sessionResponse(req: Request, store: SessionTags): Promise<Response> {
  try {
    if (req.method === "GET") return Response.json(store.snapshot().sessions.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)));
    if (req.method === "POST") {
      const input = await req.json();
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new TagError("Invalid meeting");
      const session = store.create({ ...input, id: input.id || `session-${Date.now()}`, createdAt: input.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString() });
      return Response.json(session);
    }
    const id = new URL(req.url).searchParams.get("id");
    if (!id) throw new TagError("No id");
    if (req.method === "PATCH") {
      const patch = await req.json();
      if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new TagError("Invalid meeting patch");
      return Response.json(store.patch(id, patch));
    }
    if (req.method === "DELETE") { store.remove(id); return Response.json({ ok: true }); }
    return new Response(null, { status: 405 });
  } catch (error) {
    return Response.json({ error: error instanceof TagError ? error.message : "Failed to save meeting" }, { status: error instanceof TagError ? error.status : 500 });
  }
}
