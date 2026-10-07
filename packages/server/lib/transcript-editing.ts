import type { Session } from "../../shared/types/session";
import type { Segment } from "../../shared/types/speaker";
import type { ReplaceInput, ReplacementPreview, TextChange, TextOnlyCommand, TranscriptCommand, TranscriptEditingState, TranscriptGuard, TranscriptTarget } from "../../shared/types/transcript-editing";
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { sourceRevision, transcriptSourceIdentity } from "../../shared/lib/transcript-source";
import { sanitizeTranscriptionDiagnostics } from "./final-recording";

const inputBytes = 1_000_000;
const historyBytes = 16_000_000;
const targetLimit = 1_000;
const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export class TranscriptEditingError extends Error {
 constructor(message: string, readonly status: 400 | 409 | 413 = 400) { super(message); }
}
const invalid = (message: string): never => { throw new TranscriptEditingError(message); };
const conflict = (): never => { throw new TranscriptEditingError("Transcript changed; reload before editing", 409); };
const limit = (): never => { throw new TranscriptEditingError("Transcript correction exceeds the size limit", 413); };

function text(value: string): string {
 if (typeof value !== "string" || value.includes("\0")) return invalid("Invalid transcript text");
 for (let i = 0; i < value.length; i++) {
  const unit = value.charCodeAt(i);
  if (unit >= 0xd800 && unit <= 0xdbff) {
   const next = value.charCodeAt(++i);
   if (!(next >= 0xdc00 && next <= 0xdfff)) return invalid("Invalid Unicode text");
  } else if (unit >= 0xdc00 && unit <= 0xdfff) return invalid("Invalid Unicode text");
 }
 return value.replace(/\r\n/g, "\n");
}
function boundedText(value: string): string {
 if (typeof value !== "string") return invalid("Invalid transcript text");
 if (Buffer.byteLength(value, "utf8") > inputBytes) return limit();
 const normalized = text(value);
 if (Buffer.byteLength(normalized, "utf8") > inputBytes) return limit();
 return normalized;
}
function replacementInput(value: ReplaceInput): ReplaceInput {
 if (!value || typeof value.caseSensitive !== "boolean" || typeof value.wholeWord !== "boolean") return invalid("Invalid replacement options");
 if (typeof value.query !== "string" || typeof value.replacement !== "string") return invalid("Invalid transcript text");
 if (Buffer.byteLength(value.query) + Buffer.byteLength(value.replacement) > inputBytes) return limit();
 const query = text(value.query), replacement = text(value.replacement);
 if (!query) return invalid("Replacement query must not be empty");
 if (Buffer.byteLength(query) + Buffer.byteLength(replacement) > inputBytes) return limit();
 return { query, replacement, caseSensitive: value.caseSensitive, wholeWord: value.wholeWord };
}
function version(session: Session): number {
 const value = session.transcriptVersion ?? 0;
 if (!Number.isSafeInteger(value) || value < 0) return invalid("Invalid transcript version");
 return value;
}
function checkGuard(session: Session, guard: TranscriptGuard): void {
 if (!session.transcriptFinalized) return invalid("Only finalized transcripts can be corrected");
 if (!guard || !Number.isSafeInteger(guard.expectedTranscriptVersion) || guard.expectedTranscriptVersion < 0) return invalid("Invalid transcript guard");
 if (guard.expectedTranscriptRevision !== sourceRevision(session) || guard.expectedTranscriptVersion !== version(session)) return conflict();
}
function targetText(session: Session, target: TranscriptTarget): string {
 if (target?.kind === "document" && !session.segments.length) return session.transcript;
 if (target?.kind === "segment" && Number.isSafeInteger(target.index) && target.index >= 0 && target.index < session.segments.length) return session.segments[target.index]!.text;
 return invalid("Invalid transcript target");
}
function canonicalTarget(target: TranscriptTarget): TranscriptTarget {
 if (target?.kind === "document") return { kind: "document" };
 if (target?.kind === "segment" && Number.isSafeInteger(target.index) && target.index >= 0) return { kind: "segment", index: target.index };
 return invalid("Invalid transcript target");
}
const targetKey = (target: TranscriptTarget): string => target.kind === "segment" ? `segment:${target.index}` : "document";
export function renderAcceptedTranscript(segments: Segment[]): string { return segments.map(segment => segment.text).join("\n"); }
export function normalizeTranscriptSession(session: Session): Session {
 return { ...session, transcriptVersion: version(session), transcriptRevision: sourceRevision(session) };
}

/** Source offsets come from Unicode regex matching; replacement strings are always literal. */
export function previewReplacement(session: Session, input: ReplaceInput, guard: TranscriptGuard): ReplacementPreview {
 checkGuard(session, guard);
 const options = replacementInput(input);
 const literal = options.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
 const word = "[\\p{L}\\p{N}\\p{M}_]";
 const pattern = new RegExp(options.wholeWord ? `(?<!${word})${literal}(?!${word})` : literal, options.caseSensitive ? "gu" : "giu");
 const targets: TranscriptTarget[] = session.segments.length ? session.segments.map((_, index) => ({ kind: "segment", index })) : [{ kind: "document" }];
 const changes: TextChange[] = [];
 let matchCount = 0, changedBytes = 0;
 for (const target of targets) {
  const before = targetText(session, target);
  const pieces: string[] = [];
  let cursor = 0, outputBytes = 0, matches = 0;
  for (const match of before.matchAll(pattern)) {
   const prefix = before.slice(cursor, match.index);
   outputBytes += Buffer.byteLength(prefix) + Buffer.byteLength(options.replacement);
   if (outputBytes > historyBytes) return limit();
   pieces.push(prefix, options.replacement);
   cursor = match.index + match[0].length;
   matches++;
  }
  matchCount += matches;
  if (!matches) continue;
  const suffix = before.slice(cursor);
  outputBytes += Buffer.byteLength(suffix);
  if (outputBytes > historyBytes) return limit();
  const after = pieces.join("") + suffix;
  if (after === before) continue;
  changedBytes += Buffer.byteLength(before) + outputBytes;
  if (changes.length === targetLimit || changedBytes > historyBytes) return limit();
  changes.push({ target, before, after });
 }
 const boundGuard = { expectedTranscriptRevision: guard.expectedTranscriptRevision, expectedTranscriptVersion: guard.expectedTranscriptVersion };
 return { key: hash({ guard: boundGuard, input: options, changes, matchCount }), guard: boundGuard, changes, matchCount };
}

/** Stable local request identity, excluding the request ID itself. Persistence owns retries. */
export function transcriptCommandSignature(command: TranscriptCommand): string {
 const guard = { expectedTranscriptRevision: command.expectedTranscriptRevision, expectedTranscriptVersion: command.expectedTranscriptVersion };
 switch (command.action) {
  case "edit": {
   return hash({ ...guard, action: command.action, target: canonicalTarget(command.target), text: boundedText(command.text) });
  }
  case "replace": return hash({ ...guard, action: command.action, input: replacementInput(command.input), expectedPreviewKey: command.expectedPreviewKey });
  case "revert": return hash({ ...guard, action: command.action, editId: command.editId });
  case "accept-candidate": return hash({ ...guard, action: command.action, candidateId: command.candidateId });
 }
}
export function transcriptRecoveryState(session: Session, now: string): TranscriptEditingState {
 if (session.transcriptEditing) {
  const state = session.transcriptEditing;
  if (state.schemaVersion !== 1 || !state.generations.some(generation => generation.id === state.activeGenerationId)) return invalid("Invalid transcript recovery state");
  return state;
 }
 const id = `generation-${sourceRevision(session)}`;
 const diagnostics = sanitizeTranscriptionDiagnostics(session.transcriptionDiagnostics);
 return { schemaVersion: 1, activeGenerationId: id, generations: [{ id, createdAt: now, origin: "legacy-preserved", transcript: session.transcript,
  segments: structuredClone(session.segments), speakers: [...session.speakers], language: session.language, duration: session.duration,
  ...(session.transcriptionModel !== undefined ? { transcriptionModel: session.transcriptionModel } : {}), ...(session.vocabularyRun?{vocabularyRun:structuredClone(session.vocabularyRun)}:{}), ...(session.liveVocabularyRuns?{liveVocabularyRuns:structuredClone(session.liveVocabularyRuns)}:{}), ...(diagnostics ? { transcriptionDiagnostics: diagnostics } : {}) }],
  edits: [], candidates: [], candidateRequestReceipts: [] };
}
/** No persistence, version increment, timestamps on the session, or derived-state invalidation. */
export function applyTextCommand(session: Session, command: TextOnlyCommand, now: string): Session {
 checkGuard(session, command);
 if (typeof command.requestId !== "string" || !command.requestId.trim()) return invalid("Invalid transcript request ID");
 let changes: TextChange[];
 switch (command.action) {
  case "edit": {
   const before = targetText(session, command.target), after = boundedText(command.text);
   changes = before === after ? [] : [{ target: canonicalTarget(command.target), before, after }];
   break;
  }
  case "replace": {
   const preview = previewReplacement(session, command.input, command);
   if (typeof command.expectedPreviewKey !== "string" || command.expectedPreviewKey !== preview.key) return conflict();
   changes = preview.changes;
   break;
  }
  case "revert": {
   const state = session.transcriptEditing;
   const edit = state?.edits.find(edit => edit.id === command.editId);
   if (!state || !edit || edit.generationId !== state.activeGenerationId) return conflict();
   const affected = new Set(edit.changes.map(change => targetKey(change.target)));
   if (state.edits.slice(state.edits.indexOf(edit) + 1).some(later => later.generationId === state.activeGenerationId && later.changes.some(change => affected.has(targetKey(change.target))))) return conflict();
   if (edit.changes.some(change => targetText(session, change.target) !== change.after)) return conflict();
   changes = edit.changes.map(change => ({ target: canonicalTarget(change.target), before: change.after, after: change.before }));
   break;
  }
  default: return invalid("Invalid transcript action");
 }
 if (!changes.length) return session;
 if (changes.length > targetLimit) return limit();
 const bySegment = new Map(changes.filter(change => change.target.kind === "segment").map(change => [(change.target as { index: number }).index, change.after]));
 const segments = session.segments.map((segment, index) => bySegment.has(index) ? { ...segment, text: bySegment.get(index)! } : segment);
 const transcript = segments.length ? renderAcceptedTranscript(segments) : changes[0]!.after;
 const next = { ...session, segments, transcript };
 const state = transcriptRecoveryState(session, now);
 const requestSignature = transcriptCommandSignature(command);
 const afterRevision = sourceRevision(next);
 const editing: TranscriptEditingState = { ...state, edits: [...state.edits, { id: `edit-${hash({ requestId: command.requestId, requestSignature, now })}`, requestId: command.requestId, requestSignature,
  generationId: state.activeGenerationId, kind: command.action, changes, createdAt: now, sourceIdentity: transcriptSourceIdentity(session), beforeRevision: sourceRevision(session), afterRevision }] };
 // Do not prune history to fit. The persistence boundary also checks the complete portable record.
 if (Buffer.byteLength(JSON.stringify({ generations: editing.generations, edits: editing.edits })) > historyBytes) return limit();
 return { ...next, transcriptRevision: afterRevision, transcriptEditing: editing };
}
