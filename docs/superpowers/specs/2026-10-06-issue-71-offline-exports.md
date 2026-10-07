# Issue #71: selective offline meeting exports

This specification implements the approved recommended design for [issue #71](https://github.com/augustocbx/heed-macos/issues/71): a protected local API produces a frozen, sanitized export preview; local renderers produce PDF, SRT and VTT from exactly that preview. The user approved the design and agent execution. No additional approval or product choice is needed. The planning base is `f13c3da5493d14709e1bfe0131018288a806296d`; product execution follows integration of issue #7's finalized source/provenance contract.

## Outcome and boundaries

Users export finalized saved meetings without provider calls, uploads, keys, telemetry or paid dependencies. Existing copy, Markdown and text actions retain their contents and behavior. PDF supports any nonempty selection of accepted transcript, reviewed notes and accepted tasks. Speaker labels and timestamps affect only selected transcript content. SRT/VTT contain transcript and timestamps only, with optional literal speaker prefixes. Untimed meetings support PDF without fabricated subtitle times; unavailable audio does not prevent export.

Reject provisional meetings rather than labeling live recognition as final. A finalized meeting with intentionally empty transcript may export selected nonempty notes/tasks to PDF. Missing content has specific feedback; no blank successful deliverable. New output files are user-chosen downloads outside managed retention. Do not create a managed export record, server output path, audio copy, provider publication or portable JSON replacement. Sharing/access (#19), outbound delivery (#20) and machine-readable portability (#26) remain separate.

English, Brazilian Portuguese, French and German interface translations remain supported. Authored content retains its language. Public evidence uses synthetic/licensed content only. Source, documentation and commits are English, with no author-credit trailers.

## Integration contract with issue #7

Read the approved #7 spec and plan at `docs/superpowers/specs/2026-10-06-issue-7-transcript-corrections.md` and `docs/superpowers/plans/2026-10-06-issue-7-transcript-corrections.md` after merging its reviewed implementation. Those files currently belong to `feat/issue-7-transcript-corrections`; their reviewed docs head is `9b0723e`. Do not copy or reimplement #7 in this branch.

- `TranscriptGuard` has `expectedTranscriptRevision:string` and `expectedTranscriptVersion:number`. Normalized Session API data supplies local version zero for legacy records. A hash restored by edit/revert cannot authorize an old-version preview.
- Current accepted source remains `Session.transcript` and `Session.segments[].text`; server `sourceRevision` retains existing hash bytes. Segmented source uses `renderAcceptedTranscript`; candidates/history and stale `files.srt` never supply exports.
- `NotesMetadata.sourceRevision:string|null`: null means unknown, and unknown notes are stale. Portable v1 imports cannot be normalized into fabricated current-source provenance; v2 preserves known/unknown provenance.
- Client `guardForSession` and the #7 store's authoritative response merging protect refresh/conflict. Exports perform no source mutation or notes/task review-state persistence.
- Existing `MeetingTasksService.snapshot(sessionId)` supplies accepted `TaskView` records, revision and `sourceState`. Suggested/dismissed review items are not deliverable tasks. Filter by exact meeting ID and strip evidence/audio-availability fields.

## Snapshot and review protocol

Create shared `MeetingExportFormat = 'pdf'|'srt'|'vtt'` and the following interfaces. Export types only through `packages/shared/types/index.ts`; server hashing remains outside the browser barrel.

```ts
interface MeetingExportSelection {
  transcript: boolean; notes: boolean; taskIds: string[];
  speakers: boolean; timestamps: boolean;
  reviewedNotesHash?: string;
  reviewedTaskRevisions?: Record<string, string>;
}
interface MeetingExportSnapshot {
  schemaVersion: 1; snapshotKey: string; generatedAt: string;
  meetingId: string; title: string; createdAt: string; language: string;
  sourceRevision: string; sourceVersion: number; duration: number | null;
  transcript: string;
  segments: Array<{speaker?: string; start: number; end: number; text: string;
    channel?: 'mic'|'sys'; overlap?: boolean}>;
  notes?: {text: string; sourceRevision: string | null; stale: boolean};
  tasks: Array<{id: string; revision: string; title: string; description: string;
    assignee: string | null; dueDate: string | null; status: 'open'|'completed';
    sourceRevision: string; stale: boolean}>;
  warnings: MeetingExportWarning[];
}
type MeetingExportWarning = 'notes-stale'|'notes-source-unknown'|'tasks-stale'
  |'subtitle-overlap'|'subtitle-long-cue';
interface MeetingExportReview {
  notesHash?: string;
  taskRevisions: Record<string, string>;
  staleContentKey?: string;
}
interface MeetingExportPreview {
  format: MeetingExportFormat; selection: MeetingExportSelection;
  snapshot: MeetingExportSnapshot; review: MeetingExportReview;
  availability: {transcript: boolean; notes: boolean; subtitles: boolean;
    tasks: Array<{id: string; revision: string; title: string; stale: boolean}>};
}
type MeetingExportPreviewInput = TranscriptGuard & {
  format: MeetingExportFormat; selection: MeetingExportSelection;
};
type MeetingExportValidateInput = MeetingExportPreviewInput & {
  snapshotKey: string; staleAcknowledgmentKey?: string;
};
```

The added nullable duration supports bounds checking without manufacturing a duration for legacy records. Warnings use stable codes translated by the client; user content never becomes a translation key. Snapshot allowlisting excludes audio, file paths, embeddings, diagnostics, history/candidates, private config, provider keys, raw logs and suggested/dismissed tasks. Unselected transcript becomes empty text/segments; unselected notes are absent; unselected tasks are absent. Availability carries only the selected meeting's accepted task titles/IDs/revisions and booleans, not unselected notes/transcript text.

`POST /api/sessions/:id/export-preview` reads latest normalized Session and accepted task snapshot synchronously after bounded request parsing. Validate the exact hash/version, finalized state, format/selection and selected tasks. Initial preview may lack review acknowledgments: it returns the actual selected content and required review hashes, allowing meaningful review before generation. Default PDF scope is transcript plus that meeting's accepted tasks; notes are off until explicitly selected/reviewed. Default subtitles contain transcript/timestamps and optional speakers. The client obtains default accepted task IDs/revisions from the existing tasks API, then the authoritative preview validates them.

For notes, require an explicit per-export “I reviewed these notes” checkbox bound to `review.notesHash`; changing notes, provenance or selection clears the acknowledgment. Selected accepted tasks bind their current revisions using `reviewedTaskRevisions`; acceptance is the existing reviewed-task boundary, not a new persistent review subsystem. Stale/unknown selected notes/tasks require a separate checkbox bound to `review.staleContentKey`. PDF visibly labels each affected section's earlier or unknown source revision. Do not clear stale flags or regenerate content because it was exported.

`snapshotKey` is SHA-256 over a deterministic canonical representation of format, semantic selection, source hash/version, title/date/language/duration, selected text/segments, notes/provenance and sorted selected task IDs/revisions/content. Acknowledgment fields and wall-clock `generatedAt` are excluded from that representation. Selected task order is deterministic by existing creation time then ID; it does not depend on caller ID ordering. Notes hash includes text/provenance; stale key covers the selected stale/unknown sections and their revision/content identity. A title change, task deletion/completion/edit, notes change or accepted source edit invalidates the key. Unselected note/task changes do not invalidate it; accepted source guards still apply.

`POST /api/sessions/:id/export-validate` rereads the same current source/task state synchronously, recomputes the key and checks acknowledgments. Return `{valid:true,snapshotKey}` without writes or another mutable snapshot. Stale source/key/review content returns 409; the client disables Save and requires fresh preview/review. Generation uses the original frozen preview, including its server-issued generation date and source revision. Changes after successful validation do not alter an in-flight renderer or its accurate provenance label; a future export needs a new preview. Changing scope/format cancels any old generation and discards its output.

Both routes use existing loopback/origin protection and encoded safe IDs. Read at most 16,000,000 body bytes before parsing; reject unknown fields, malformed booleans/formats, duplicate task IDs and invalid revisions. Selected UTF-8 content has a 16,000,000-byte bound before renderer work, measured as the encoded deterministic snapshot-key payload rather than a JavaScript character count. Errors: 400 invalid selection/review/timing, 403 denied, 404 missing meeting/task, 409 source/snapshot conflict, 413 oversized input. Other-meeting tasks are invalid selection without exposing their content. Requests are read-only and must not enqueue AI or acquire model resources.

## Subtitle policy

Use accepted segments, one cue per nonempty recognized segment; do not invent word timing after edits. Validate every selected nonempty segment: finite nonnegative endpoints, integer milliseconds via `Math.round(seconds*1000)`, end strictly greater than start after rounding, safe integer endpoints, and end within a finite positive stored duration when known. Unknown duration means no artificial bound. Reject any invalid nonempty cue rather than silently dropping recognized content; omit empty-text segments. All-empty/no timed output gives a specific error.

A shared pure timing/cue helper supplies preview availability/warnings and serializer cues, so server and client enforce the same rounding/bounds. Stable sort by start/end/original index, preserving legitimate overlap and warning about it; never truncate another speaker's timing. Wrap using `Intl.Segmenter` grapheme boundaries at 42 graphemes per line. Preserve nonempty user line breaks; collapse repeated blank lines in the cue presentation to avoid structural separators. Cues exceeding two wrapped lines or 20 visible graphemes/second receive a long-cue warning, not fabricated segmentation. Document that corrected text retains segment timing and may have poor reading density.

SRT has consecutive numbering and `HH:MM:SS,mmm`; VTT has `WEBVTT`, one source/date NOTE and `HH:MM:SS.mmm`. Both are UTF-8 with LF and a terminal newline. Optional speaker prefix is literal content. Entity-escape ampersand/angle brackets, including the arrow's greater-than character, so markup-like content or timing-arrow strings cannot create new structure. Decoded visible words/graphemes must match accepted cue content under the documented whitespace wrapping policy. Do not insert a metadata cue into SRT. Require independent parser and browser TextTrack tests, not just serializer snapshots; report parser/player compatibility limitations honestly. Follow the [W3C WebVTT formatting/parsing rules](https://www.w3.org/TR/webvtt1/).

## PDF, fonts and local generation

Pin `pdf-lib` 1.17.1 and `@pdf-lib/fontkit` 1.1.1 (MIT) in the client and lockfile during implementation. The library supports embedded custom fonts and text measurement. [Custom-font documentation](https://github.com/Hopding/pdf-lib/blob/master/README.md), [PDFFont API](https://pdf-lib.js.org/docs/api/classes/pdffont). Bundle static Noto Sans Regular/Bold TTFs from the [official Noto repository](https://github.com/notofonts/latin-greek-cyrillic), license and source/version/SHA-256 manifest; verify the actual files' redistribution license and glyph coverage before committing. No CDN/system-font or network-image dependency.

Preflight glyph coverage for every selected title, metadata, speaker, note and task field. Preserve decomposed accents; do not normalize/transliterate user content to make a font fit. Supported first-release repertoire includes EN/PT/FR/DE characters, combining accents and verified common punctuation/currency/math symbols. Unsupported scripts/emoji produce an actionable error listing missing characters with existing UTF-8 text export as an alternative. Do not claim broad Unicode/emoji support without bundled fallback and extraction/render evidence.

Use pure document blocks for preview/PDF: metadata header, selected transcript paragraphs with optional speaker/time, reviewed notes as literal plain text with preserved lines, and selected task fields with status/assignee/due date. Never render notes HTML, active links or remote images. Empty optional task fields are omitted. A4 pages, 48pt margins, 11pt body, 1.35 line spacing, measured width wrapping and page numbers/compact source footer. Split long blocks and graphemes in unbroken strings; preserve user line breaks, keep a heading with the first two body lines when possible, and avoid a speaker header alone at page bottom. Do not reduce body size to fit a long meeting. Full source revision/date belongs in metadata and a readable provenance line; body text must remain extractable in reading order.

Generate in a dedicated cancellable module worker. Subtitle serialization uses the same worker boundary; PDF library/fonts load lazily only for PDF. A failed/cancelled worker is terminated, output/blob URLs released, and dialog remains retryable. Only a completed artifact enables Save. Closing dialog/changing selection invalidates old worker results with a job ID; late results cannot download. Saving creates a correctly typed Blob/local browser download, never writes server/managed files. A frozen validated source may render while capture continues without model inference or blocking recording controls.

## Acceptance evidence

| Live issue criterion | Proof required during implementation |
| --- | --- |
| New formats; unchanged Markdown/text | Exact old action outputs, typed downloads; real PDF/SRT/VTT artifacts from finalized synthetic sessions. |
| Scope, review and source revisions | Combination matrix, actual preview content, accepted-task filtering, acknowledgment/key conflicts, ABA edit/revert, frozen generation race. |
| Valid timings and supported Unicode | Independent subtitle parser/browser TextTrack; invalid/collapsed/unsorted/overlapping/long/empty timing; EN/PT/FR/DE and combining marks; unsupported glyph error. |
| Long readable PDF and provenance | PDF metadata/text/page parser plus rendered PNG inspection of all synthetic fixture pages, including first/middle/last long-meeting pages, notes/task-only outputs and long names. |
| Offline/no audio/secrets/retention | Production UI with external requests denied; local assets/worker work; sentinel secret/path/embedding exclusion; no raw media/model/provider endpoint and no managed output record; cancellation/cleanup. |

Both Macs require actual offline generation/opening of the representative exports; do not substitute parser tests for visual/runtime evidence. Synthetic fixtures do not claim subjective meeting quality or physical capture. This docs-only specification reports no product tests or generated artifacts.
