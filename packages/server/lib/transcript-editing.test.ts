import { describe, expect, test } from "bun:test";
import type { Session } from "../../shared/types/session";
import type { ReplaceInput, TextOnlyCommand, TranscriptGuard } from "../../shared/types/transcript-editing";
import { sourceRevision } from "../../shared/lib/transcript-source";
import { sourceRevision as notesSourceRevision } from "./automatic-notes";
import { applyTextCommand, normalizeTranscriptSession, previewReplacement, renderAcceptedTranscript, transcriptCommandSignature } from "./transcript-editing";

const now = "2026-10-06T12:00:00Z";
function meeting(texts = ["Hello", "Olá"]): Session {
 return { id: "meeting", title: "Review", createdAt: now, duration: 2, language: "pt", transcriptionModel: "whisper",
  transcript: texts.join("\n"), speakers: ["Ana", "Bruno"], segments: texts.map((text, index) => ({ speaker: index ? "Bruno" : "Ana", start: index, end: index + 1, text, channel: index ? "sys" : "mic", attribution: "fallback", auto: true, id: index + 7, overlap: true })),
  embeddings: { Ana: [0.1, 0.2] }, aiNotes: "Existing notes", summary: "Summary", tags: ["review"], pinned: true,
  files: { wav: "/private/audio.wav" }, transcriptFinalized: true,
  transcriptionDiagnostics: { version: 1, aecApplied: false, channels: { mic: { rawRms: 1, rawPeak: 2, cleanedRms: 1, asrSegments: 1, diarizationSegments: 0, usableEmbeddings: 0, retainedSegments: 1, discardedSegments: 0, discardReasons: {}, fallbackSegments: 1, diarizationFailed: true } }, warnings: ["microphone-attribution-fallback"] } };
}
const guard = (session: Session): TranscriptGuard => ({ expectedTranscriptRevision: sourceRevision(session), expectedTranscriptVersion: session.transcriptVersion ?? 0 });
function edit(session: Session, index: number, text: string, requestId = "edit-1"): Session {
 return applyTextCommand(session, { ...guard(session), requestId, action: "edit", target: { kind: "segment", index }, text }, now);
}
const input = (query: string, replacement = "X", wholeWord = false, caseSensitive = true): ReplaceInput => ({ query, replacement, wholeWord, caseSensitive });
function replace(session: Session, value: ReplaceInput, requestId = "replace-1"): Session {
 const preview = previewReplacement(session, value, guard(session));
 return applyTextCommand(session, { ...guard(session), requestId, action: "replace", input: value, expectedPreviewKey: preview.key }, now);
}

describe("recoverable text corrections", () => {
 test("keeps existing source hash bytes, including channel order and omitted optional fields", () => {
  const session = meeting();
  expect(sourceRevision(session)).toBe("f94fa9031dc6f14ed717e2e3def8996b391ea22d0890fdb1ddf5429d5e53fcb9");
  expect(notesSourceRevision(session)).toBe("f94fa9031dc6f14ed717e2e3def8996b391ea22d0890fdb1ddf5429d5e53fcb9");
  expect(sourceRevision({ transcript: "Plain text", language: "en", speakers: [], segments: [] })).toBe("988385ac6520e536988c6ab4785ccac1f324b670944faa7f5add12429e29c3ef");
 });
 test("normalizes legacy concurrency identity without inventing recovery history or mutating input", () => {
  const original = meeting(); const normalized = normalizeTranscriptSession(original);
  expect(normalized.transcriptVersion).toBe(0); expect(normalized.transcriptRevision).toBe(sourceRevision(original));
  expect(normalized.transcriptEditing).toBeUndefined(); expect(original.transcriptVersion).toBeUndefined();
  expect(renderAcceptedTranscript([{ speaker: "A", start: 0, end: 1, text: "" }, { speaker: "B", start: 1, end: 2, text: "Olá" }])).toBe("\nOlá");
 });
 test("corrects English and Portuguese text while preserving every nontext source field", () => {
  const original = meeting(); const snapshot = structuredClone(original);
  const first = edit(original, 0, "Hello world"); const second = edit(first, 1, "Olá, ação!", "edit-2");
  expect(second.transcript).toBe("Hello world\nOlá, ação!"); expect(original).toEqual(snapshot);
  expect(second.segments.map(({ text, ...rest }) => rest)).toEqual(original.segments.map(({ text, ...rest }) => rest));
  const { transcript: _text, segments: _segments, transcriptRevision: _revision, transcriptVersion: _version, transcriptEditing: _editing, ...unchanged } = second;
  const { transcript: _originalText, segments: _originalSegments, ...originalFields } = original;
  expect(unchanged).toEqual(originalFields);
 });
 test("retains the exact legacy original once and never increments the local version", () => {
  const original = { ...meeting(), transcript: "Legacy transcript differs from segments", transcriptVersion: 9 };
  const first = edit(original, 0, "New"); const second = edit(first, 1, "Novo", "edit-2");
  expect(second.transcriptVersion).toBe(9); expect(second.transcriptEditing?.generations).toHaveLength(1);
  expect(second.transcriptEditing?.generations[0]).toMatchObject({ origin: "legacy-preserved", transcript: original.transcript, segments: original.segments, speakers: original.speakers, language: original.language, transcriptionModel: "whisper", duration: 2, transcriptionDiagnostics: original.transcriptionDiagnostics });
  expect(second.transcriptEditing?.generations[0]).not.toHaveProperty("embeddings");
  expect(second.transcriptEditing?.edits).toHaveLength(2);
  expect(second.transcriptEditing?.edits[0]).toMatchObject({ requestId: "edit-1", kind: "edit", changes: [{ target: { kind: "segment", index: 0 }, before: "Hello", after: "New" }], beforeRevision: sourceRevision(original), afterRevision: sourceRevision(first) });
  original.segments[0].text = "External mutation"; expect(second.transcriptEditing?.generations[0]?.segments[0]?.text).toBe("Hello");
 });
 test("accepts empty segments and untimed documents and treats unchanged text as a no-op", () => {
  const original = meeting(); expect(edit(original, 0, "Hello")).toBe(original);
  expect(edit(original, 0, "").transcript).toBe("\nOlá");
  const document = { ...meeting(), segments: [], transcript: "Untimed" };
  const cleared = applyTextCommand(document, { ...guard(document), requestId: "doc", action: "edit", target: { kind: "document" }, text: "" }, now);
  expect(cleared.transcript).toBe(""); expect(cleared.segments).toEqual([]);
  expect(() => applyTextCommand(original, { ...guard(original), requestId: "wrong-target", action: "edit", target: { kind: "document" }, text: "x" }, now)).toThrow();
 });
 test("undoes only recorded text while preserving a later rename and another segment edit", () => {
  const first = edit(meeting(), 0, "Changed"); const other = edit(first, 1, "Outra mudança", "other");
  const renamed = { ...other, speakers: ["Alice", "Bruno"], segments: other.segments.map(s => s.speaker === "Ana" ? { ...s, speaker: "Alice", auto: false } : s) };
  const reverted = applyTextCommand(renamed, { ...guard(renamed), requestId: "undo", action: "revert", editId: first.transcriptEditing!.edits[0]!.id }, now);
  expect(reverted.transcript).toBe("Hello\nOutra mudança"); expect(reverted.speakers).toEqual(["Alice", "Bruno"]);
  expect(reverted.segments[0]).toMatchObject({ speaker: "Alice", auto: false, attribution: "fallback" });
  expect(reverted.transcriptEditing?.edits.at(-1)?.kind).toBe("revert");
 });
 test("rejects incompatible undo, stale content and stale monotonic version", () => {
  const first = edit(meeting(), 0, "Changed"); const second = edit(first, 0, "Later", "later");
  expect(() => applyTextCommand(second, { ...guard(second), requestId: "undo", action: "revert", editId: first.transcriptEditing!.edits[0]!.id }, now)).toThrow();
  const original = meeting();
  expect(() => applyTextCommand(original, { ...guard(original), expectedTranscriptRevision: "old", requestId: "bad", action: "edit", target: { kind: "segment", index: 0 }, text: "New" }, now)).toThrow();
  expect(() => applyTextCommand({ ...original, transcriptVersion: 2 }, { ...guard(original), requestId: "bad", action: "edit", target: { kind: "segment", index: 0 }, text: "New" }, now)).toThrow();
 });
 test("signs semantic command content independently of request ID and object key order", () => {
  const session = meeting();
  const command: TextOnlyCommand = { ...guard(session), requestId: "one", action: "edit", target: { kind: "segment", index: 0 }, text: "New\r\ntext" };
  const reordered: TextOnlyCommand = { ...command, requestId: "two", target: { index: 0, kind: "segment" }, text: "New\ntext" };
  expect(transcriptCommandSignature(command)).toBe(transcriptCommandSignature(reordered));
  const extra = { ...reordered, target: { ...reordered.target, ignored: "harmless" } };
  expect(transcriptCommandSignature(command)).toBe(transcriptCommandSignature(extra));
  expect(transcriptCommandSignature(command)).not.toBe(transcriptCommandSignature({ ...command, text: "Other" }));
 });
 test("rejects undo after a later action touched the same target even when text returned to its earlier value", () => {
  const first = edit(meeting(["a"]), 0, "b");
  const second = edit(first, 0, "c", "second");
  const third = edit(second, 0, "b", "third");
  expect(() => applyTextCommand(third, { ...guard(third), requestId: "undo-first", action: "revert", editId: first.transcriptEditing!.edits[0]!.id }, now)).toThrow();
  expect(third.transcript).toBe("b"); expect(third.transcriptEditing?.edits).toHaveLength(3);
 });
});

describe("literal find and replace", () => {
 test("preserves punctuation and HTML as text without regex or replacement expansion", () => {
  const session = meeting(["a.b [x] $& a.b", "aXb"]);
  const preview = previewReplacement(session, input("a.b", "<b>$&</b>"), guard(session));
  expect(preview.matchCount).toBe(2); expect(preview.changes).toEqual([{ target: { kind: "segment", index: 0 }, before: "a.b [x] $& a.b", after: "<b>$&</b> [x] $& <b>$&</b>" }]);
  expect(replace(session, input("a.b", "<b>$&</b>")).transcript).toBe("<b>$&</b> [x] $& <b>$&</b>\naXb");
 });
 test("uses Unicode letters, numbers, marks and underscores for word boundaries", () => {
  const session = meeting(["ação AÇÃO ação_ ação2 açãó pré-ação d'ação xação", "é é É"]);
  expect(previewReplacement(session, input("ação", "X", true, false), guard(session)).changes[0]?.after).toBe("X X ação_ ação2 açãó pré-X d'X xação");
  const accents = meeting(["é é É"]);
  expect(previewReplacement(accents, input("é", "X", false, false), guard(accents)).changes[0]?.after).toBe("X é X");
 });
 test("normalizes CRLF, matches line breaks within one target and never crosses segments", () => {
  const session = meeting(["First\nsecond", "First", "second"]);
  const value = input("First\r\nsecond", "Done\r\nnow");
  const preview = previewReplacement(session, value, guard(session));
  expect(preview.matchCount).toBe(1); expect(preview.changes[0]?.after).toBe("Done\nnow");
  expect(replace(session, value).transcript).toBe("Done\nnow\nFirst\nsecond");
 });
 test("supports deletion, no matches and replacements which leave the source unchanged", () => {
  const session = meeting(["abc abc"]);
  expect(replace(session, input("abc", "")).transcript).toBe(" ");
  expect(previewReplacement(session, input("absent"), guard(session))).toMatchObject({ changes: [], matchCount: 0 });
  expect(replace(session, input("absent"))).toBe(session); expect(replace(session, input("abc", "abc"))).toBe(session);
 });
 test("binds previews to guards, options and computed changes", () => {
  const session = meeting(["Hello hello"]); const preview = previewReplacement(session, input("Hello"), guard(session));
  const command: TextOnlyCommand = { ...guard(session), requestId: "replace", action: "replace", input: input("Hello", "Other"), expectedPreviewKey: preview.key };
  expect(() => applyTextCommand(session, command, now)).toThrow();
  expect(() => previewReplacement(session, input("Hello"), { ...guard(session), expectedTranscriptVersion: 1 })).toThrow();
 });
 test("accepts exactly 1000 affected targets and rejects the next without changing the source", () => {
  const session = meeting(Array(1000).fill("x")); expect(previewReplacement(session, input("x"), guard(session)).changes).toHaveLength(1000);
  expect(replace(session, input("x")).segments.every(s => s.text === "X")).toBe(true);
  const tooMany = meeting(Array(1001).fill("x")); expect(() => previewReplacement(tooMany, input("x"), guard(tooMany))).toThrow(); expect(tooMany.transcriptEditing).toBeUndefined();
 });
 test("counts submitted UTF-8 bytes at the 1000000-byte boundary for edits and replacement input", () => {
  const session = meeting(["a"]); const million = "é".repeat(500000);
  expect(edit(session, 0, million).segments[0]?.text.length).toBe(500000);
  expect(() => edit(session, 0, million + "a")).toThrow();
  const accepted = input("a", "é".repeat(499999) + "a"); expect(previewReplacement(session, accepted, guard(session)).matchCount).toBe(1);
  expect(() => previewReplacement(session, input("a", "é".repeat(500000)), guard(session))).toThrow();
 });
 test("enforces the submitted byte bound before CRLF normalization", () => {
  const session = meeting(["a"]);
  expect(edit(session, 0, "\r\n".repeat(500000)).segments[0]?.text.length).toBe(500000);
  expect(() => edit(session, 0, "\r\n".repeat(500001))).toThrow();
  expect(previewReplacement(session, input("a", "\r\n".repeat(499999) + "x"), guard(session)).matchCount).toBe(1);
  expect(() => previewReplacement(session, input("a", "\r\n".repeat(500000)), guard(session))).toThrow();
 });
 test("rejects empty queries, NUL, invalid Unicode scalars and invalid indices", () => {
  const session = meeting();
  for (const text of ["\0", "\ud800", "\udc00"]) {
   expect(() => edit(session, 0, text)).toThrow();
   expect(() => previewReplacement(session, input(text), guard(session))).toThrow();
   expect(() => previewReplacement(session, input("Hello", text), guard(session))).toThrow();
  }
  expect(() => previewReplacement(session, input(""), guard(session))).toThrow();
  for (const index of [-1, 2, 0.5, NaN]) expect(() => edit(session, index, "x")).toThrow();
  expect(edit(session, 0, "🙂\r\nOlá").transcript).toBe("🙂\nOlá\nOlá");
 });
 test("refuses oversized recovery history and explosive replacements without pruning originals", () => {
  const session = meeting(["a".repeat(17)]);
  expect(() => previewReplacement(session, input("a", "b".repeat(999999)), guard(session))).toThrow();
  expect(session.transcriptEditing).toBeUndefined();
  const original = meeting(["a".repeat(8_000_000)]);
  expect(() => edit(original, 0, "b".repeat(1_000_000))).toThrow();
  expect(original.transcript).toHaveLength(8_000_000); expect(original.transcriptEditing).toBeUndefined();
 });
 test("replaces untimed document content without adding segments and rejects unfinished captures", () => {
  const document = { ...meeting(), segments: [], transcript: "Untimed untimed" };
  expect(replace(document, input("untimed", "Text", false, false))).toMatchObject({ transcript: "Text Text", segments: [] });
  const unfinished = { ...meeting(), transcriptFinalized: false };
  expect(() => edit(unfinished, 0, "x")).toThrow(); expect(() => previewReplacement(unfinished, input("Hello"), guard(unfinished))).toThrow();
 });
});
