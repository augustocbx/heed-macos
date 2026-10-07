import {validateVocabularyRun} from '../../shared/lib/vocabulary';
import { createHash, randomUUID } from "node:crypto";
import type { Session } from "../../shared/types/session";
import type { Segment, TranscriptionDiagnostics } from "../../shared/types/speaker";
import type { CandidateInput, ReplaceInput, TranscriptCandidate, TranscriptCommand, TranscriptGuard } from "../../shared/types/transcript-editing";
import { applySpeakerNames, reconcileSpeakerNames } from "../../shared/lib/speaker-names";
import type { AutomaticNotesService } from "./automatic-notes";
import { SessionTags, TagError, checkTranscriptGuard } from "./session-tags";
import { previewReplacement, renderAcceptedTranscript, transcriptCommandSignature, transcriptRecoveryState } from "./transcript-editing";
import { sanitizeTranscriptionDiagnostics } from "./final-recording";

const maxReceipts = 1_000;
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function validText(value: unknown): value is string {
 if (typeof value !== "string" || value.includes("\0")) return false;
 for (let i = 0; i < value.length; i++) { const code = value.charCodeAt(i); if (code >= 0xd800 && code <= 0xdbff) { const next = value.charCodeAt(++i); if (!(next >= 0xdc00 && next <= 0xdfff)) return false; } else if (code >= 0xdc00 && code <= 0xdfff) return false; }
 return true;
}
export function validateTranscriptRequestId(value: unknown): asserts value is string {
 if (!validText(value) || !value.trim() || value.length > 128) throw new TagError("Invalid transcript request ID");
}
export function validateTranscriptGuard(value: unknown): asserts value is TranscriptGuard {
 if (!object(value) || typeof value.expectedTranscriptRevision !== "string" || !/^[a-f0-9]{64}$/.test(value.expectedTranscriptRevision) || !Number.isSafeInteger(value.expectedTranscriptVersion) || value.expectedTranscriptVersion < 0) throw new TagError("Transcript revision and version are required");
}
/** One namespace prevents an operation identity from being reused for a different mutation. */
export function transcriptOperationReceipt(session: Session, requestId: string) {
 const state = session.transcriptEditing;
 return state?.edits.find(value => value.requestId === requestId) ?? state?.candidates.find(value => value.requestId === requestId) ?? state?.candidateRequestReceipts.find(value => value.requestId === requestId);
}
function acknowledge(session: Session, requestId: string, signature: string): boolean {
 const receipt = transcriptOperationReceipt(session, requestId);
 if (!receipt) return false;
 if (receipt.requestSignature !== signature) throw new TagError("Transcript request ID was reused with different contents", 409);
 return true;
}
function finalized(session: Session) { if (!session.transcriptFinalized) throw new TagError("Only finalized transcripts can be corrected"); }
function candidateFields(raw: unknown, sanitize: (value: unknown) => TranscriptionDiagnostics | undefined) {
 if (!object(raw) || raw.success !== true || raw.finalized !== true || raw.error || !validText(raw.text) || !raw.text.trim() || !object(raw.metadata) || !["en", "pt"].includes(raw.metadata.language) || !validText(raw.metadata.model) || !raw.metadata.model.trim() || typeof raw.duration !== "number" || !Number.isFinite(raw.duration) || raw.duration < 0 || !Number.isSafeInteger(raw.wordCount) || raw.wordCount < 0 || !object(raw.files) || ["wav", "srt", "txt"].some(key => !validText(raw.files[key])) || !Array.isArray(raw.segments) || !Array.isArray(raw.speakers)) throw new TagError("No complete final English or Portuguese transcript was returned");
 const segments: Segment[] = raw.segments.map((segment: unknown) => {
  if (!object(segment) || !validText(segment.speaker) || !segment.speaker.trim() || !validText(segment.text) || typeof segment.start !== "number" || typeof segment.end !== "number" || !Number.isFinite(segment.start) || !Number.isFinite(segment.end) || segment.start < 0 || segment.end < segment.start || segment.end > raw.duration || (segment.channel !== undefined && !["mic", "sys"].includes(segment.channel)) || (segment.auto !== undefined && typeof segment.auto !== "boolean") || (segment.overlap !== undefined && typeof segment.overlap !== "boolean") || (segment.attribution !== undefined && segment.attribution !== "fallback") || (segment.id !== undefined && !Number.isSafeInteger(segment.id))) throw new TagError("Invalid finalized transcript segments");
  return { speaker: segment.speaker, text: segment.text, start: segment.start, end: segment.end, ...(segment.id !== undefined ? { id: segment.id } : {}), ...(segment.channel !== undefined ? { channel: segment.channel } : {}), ...(segment.auto !== undefined ? { auto: segment.auto } : {}), ...(segment.overlap !== undefined ? { overlap: segment.overlap } : {}), ...(segment.attribution !== undefined ? { attribution: segment.attribution } : {}) };
 });
 const speakers = [...new Set<string>(raw.speakers)];
 if (raw.speakers.some((speaker: unknown) => !validText(speaker) || !speaker.trim()) || speakers.length !== raw.speakers.length || segments.some(segment => !speakers.includes(segment.speaker)) || speakers.some(speaker => !segments.some(segment => segment.speaker === speaker))) throw new TagError("Invalid finalized transcript speakers");
 if (segments.length && raw.text !== renderAcceptedTranscript(segments)) throw new TagError("Final transcript text and segments disagree");
 let embeddings: Record<string, number[]> | undefined;
 if (raw.embeddings !== undefined) {
  if (!object(raw.embeddings)) throw new TagError("Invalid finalized voice embeddings");
  const entries = Object.entries(raw.embeddings).sort(([a], [b]) => a.localeCompare(b));
  if (entries.some(([speaker, vector]) => !speakers.includes(speaker) || !Array.isArray(vector) || !vector.length || vector.some(value => typeof value !== "number" || !Number.isFinite(value)))) throw new TagError("Invalid finalized voice embeddings");
  embeddings = Object.fromEntries(entries.filter(([speaker]) => !segments.some(segment => segment.speaker === speaker && segment.attribution === "fallback")));
 }
 const diagnostics = sanitize(raw.transcriptionDiagnostics);
 return { transcript: raw.text, segments, speakers, language: raw.metadata.language as string, transcriptionModel: raw.metadata.model as string, duration: raw.duration as number,
  ...(raw.metadata.vocabularyRun?{vocabularyRun:validateVocabularyRun(raw.metadata.vocabularyRun)}:{}),
  ...(embeddings !== undefined ? { embeddings } : {}), ...(diagnostics ? { transcriptionDiagnostics: diagnostics } : {}) };
}
/** Acceptance is a pure builder; the notes service owns the single guarded source commit. */
export function applyCandidateAcceptance(current: Session, command: Extract<TranscriptCommand, { action: "accept-candidate" }>, now: string): Session {
 finalized(current);
 const state = current.transcriptEditing, candidate = state?.candidates.find(value => value.id === command.candidateId);
 if (!state || !candidate) throw new TagError("Transcript candidate not found", 404);
 checkTranscriptGuard(current, candidate.baseGuard);
 const names = Object.fromEntries(current.speakers.filter(speaker => {
  if (current.segments.some(segment => segment.speaker === speaker && segment.attribution === "fallback") && ["Microphone (unattributed)", "System (unattributed)"].includes(speaker)) return false;
  return current.segments.some(segment => segment.speaker === speaker && segment.auto === false) || (!/^(Speaker\s*\d+|Unknown|You|Me)$/i.test(speaker) && current.segments.some(segment => segment.speaker === speaker && segment.auto !== true));
 }).map(speaker => [speaker, speaker]));
 const mapped = applySpeakerNames(candidate.segments, candidate.speakers, candidate.embeddings ?? {}, reconcileSpeakerNames(current.segments, candidate.segments, names));
 const { requestId, requestSignature, baseGuard, embeddings, ...recognized } = candidate;
 const generation = { ...recognized, ...mapped, id: candidate.id, createdAt: now, origin: "recognition" as const };
 // Embeddings belong only to current accepted state, not recognition recovery history.
 const { embeddings: _historyEmbeddings, ...history } = generation;
 return { ...current, transcript: candidate.transcript, ...mapped, language: candidate.language, duration: candidate.duration, transcriptionModel: candidate.transcriptionModel, vocabularyRun:candidate.vocabularyRun, liveVocabularyRuns:undefined, transcriptionDiagnostics: candidate.transcriptionDiagnostics, transcriptFinalized: true,
  transcriptEditing: { ...state, activeGenerationId: candidate.id, generations: [...state.generations, history], candidates: state.candidates.filter(value => value.id !== candidate.id), candidateRequestReceipts: [...state.candidateRequestReceipts,
   { requestId, requestSignature, candidateId: candidate.id, status: "accepted" }, { requestId: command.requestId, requestSignature: transcriptCommandSignature(command), candidateId: candidate.id, status: "accepted" }] } };
}

export interface TranscriptServiceOptions { notes: AutomaticNotesService; store: SessionTags; now?: () => string; sanitizeDiagnostics?: typeof sanitizeTranscriptionDiagnostics; }
export class TranscriptService {
 constructor(private readonly options: TranscriptServiceOptions) {}
 private now() { return this.options.now?.() ?? new Date().toISOString(); }
 private get(id: string) { const session = this.options.notes.get(id); if (!session) throw new TagError("Meeting not found", 404); return session; }
 preview(id: string, input: ReplaceInput, guard: TranscriptGuard) { validateTranscriptGuard(guard); return previewReplacement(this.get(id), input, guard); }
 command(id: string, input: TranscriptCommand): Session {
  if (!object(input) || !["edit", "replace", "revert", "accept-candidate"].includes(input.action)) throw new TagError("Invalid transcript command");
  validateTranscriptRequestId(input.requestId); validateTranscriptGuard(input);
  if (input.action === "accept-candidate" || input.action === "revert") {
   const entityId = input.action === "accept-candidate" ? input.candidateId : input.editId;
   if (typeof entityId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(entityId)) throw new TagError("Invalid transcript candidate or edit ID");
  }
  if (input.action === "replace" && (typeof input.expectedPreviewKey !== "string" || !/^[a-f0-9]{64}$/.test(input.expectedPreviewKey))) throw new TagError("Invalid transcript preview key");
  this.get(id); return this.options.notes.commitTranscript(id, input);
 }
 stage(id: string, input: CandidateInput): Session {
  if (!object(input)) throw new TagError("Invalid transcript candidate");
  validateTranscriptRequestId(input.requestId); validateTranscriptGuard(input.base);
  const fields = candidateFields(input.result, this.options.sanitizeDiagnostics ?? sanitizeTranscriptionDiagnostics);
  const baseGuard = { expectedTranscriptRevision: input.base.expectedTranscriptRevision, expectedTranscriptVersion: input.base.expectedTranscriptVersion };
  const signature = hash({ action: "stage", base: baseGuard, result: fields }), current = this.get(id);
  if (acknowledge(current, input.requestId, signature)) return current;
  finalized(current);
  const saved = this.options.store.commitTranscriptState(id, session => {
   finalized(session);
   const state = transcriptRecoveryState(session, this.now());
   if (state.candidates.length >= 2) throw new TagError("Discard a pending transcript candidate before staging another", 409);
   // Each pending stage reserves its stage and terminal-operation receipts. Never prune.
   if (state.candidateRequestReceipts.length + 2 * (state.candidates.length + 1) > maxReceipts) throw new TagError("Transcript request receipt capacity is exhausted; existing candidates can still be accepted or discarded", 409);
   const candidate: TranscriptCandidate = { ...fields, id: `candidate-${randomUUID()}`, createdAt: this.now(), requestId: input.requestId, requestSignature: signature, baseGuard };
   return { ...session, transcriptEditing: { ...state, candidates: [...state.candidates, candidate] } };
  });
  return this.options.notes.normalize(saved);
 }
 discard(id: string, candidateId: string, requestId: string): Session {
  validateTranscriptRequestId(requestId);
  if (typeof candidateId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(candidateId)) throw new TagError("Invalid transcript candidate ID");
  const signature = hash({ action: "discard", candidateId }), current = this.get(id);
  if (acknowledge(current, requestId, signature)) return current;
  const saved = this.options.store.commitTranscriptState(id, session => {
   const state = session.transcriptEditing, candidate = state?.candidates.find(value => value.id === candidateId);
   if (!state || !candidate) throw new TagError("Transcript candidate not found", 404);
   return { ...session, transcriptEditing: { ...state, candidates: state.candidates.filter(value => value.id !== candidateId), candidateRequestReceipts: [...state.candidateRequestReceipts,
    { requestId: candidate.requestId, requestSignature: candidate.requestSignature, candidateId, status: "discarded" }, { requestId, requestSignature: signature, candidateId, status: "discarded" }] } };
  });
  return this.options.notes.normalize(saved);
 }
}
