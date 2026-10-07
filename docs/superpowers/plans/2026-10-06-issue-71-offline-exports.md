# Selective Offline Meeting Exports Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. The user selected agent execution and approved the design; the controller schedules product execution after #7. This commit is docs only and requires no further user approval.

**Goal:** Produce selective offline PDF/SRT/VTT downloads from finalized accepted meeting content while preserving existing Markdown/text exports.

**Architecture:** A protected synchronous server reader creates a sanitized frozen snapshot and validates its source/key immediately before generation. Pure content/subtitle builders and a dedicated browser worker consume only that snapshot; PDF code and licensed bundled fonts load lazily. Review acknowledgment is per export, and stale/unknown derived provenance stays explicit without changing application data.

**Tech Stack:** Bun 1.4.2/TypeScript server, React/Zustand/Vitest client, Vite module worker, pinned MIT `pdf-lib` 1.17.1 and `@pdf-lib/fontkit` 1.1.1; licensed static Noto Sans TTF assets. Dev-only independent subtitle parser `subtitle` 4.2.2; PDF parser/Poppler for artifact QA.

**Spec:** [Approved offline export specification](../specs/2026-10-06-issue-71-offline-exports.md).

## Execution update

The controller integrated independently reviewed #7 Tasks 1–2 at `04a9b38` to implement the read-only export foundation in this isolated worktree alongside #7's remaining work and #70. Source/version/provenance contracts are now concrete. Integrate the complete reviewed #7 branch before final client integration, whole-branch validation and merge; no #7 files are implemented or copied here.

## Global Constraints

- Product execution follows integration of issue #7's finalized source/provenance contract.
- Reject provisional meetings rather than labeling live recognition as final.
- Existing copy, Markdown and text actions retain their contents and behavior.
- English, Brazilian Portuguese, French and German interface translations remain supported.
- Read at most 16,000,000 body bytes before parsing; selected UTF-8 content has a 16,000,000-byte bound before renderer work.
- SRT/VTT contain transcript and timestamps only, with optional literal speaker prefixes. Untimed meetings support PDF without fabricated subtitle times.
- A4 pages, 48pt margins, 11pt body, 1.35 line spacing, measured width wrapping and page numbers/compact source footer.
- Wrap subtitle text at 42 graphemes per line; warn above two lines or 20 visible graphemes/second. Preserve one cue per nonempty recognized segment.
- No provider calls, uploads, keys, telemetry or paid dependencies. No server output path, audio copy, managed export record or retention mutation.
- Use synthetic/licensed fixtures only. English source/comments/documentation/commits; preserve authored content and four locales; no author-credit trailers.

## Review Focus

1. Edit/revert restores the source hash while increasing the local version: an old dialog must conflict rather than silently export under its original guard (Tasks 1–2).
2. Notes regeneration or task edit/delete/completion after acknowledgment: old review must not authorize different deliverables, even when transcript is unchanged (Tasks 1–2, 5).
3. Blank lines, markup/entities, timing-arrow strings and decomposed accents in cue/speaker text: decoded subtitle words must remain literal without injected cues (Task 3).
4. A long unbroken name, missing combining glyph, notes-only document or heading near page bottom: output must be readable or clearly fail, never clip/shrink/lose characters (Task 4).
5. Cancel/change/close during generation, followed by a late result: no stale download, leaked Blob or blocked recording controls (Tasks 4–6).

---

## Execution dependencies and file map

Planning starts from `origin/main` `f13c3da`. Do not implement before the controller integrates #7. Fetch current main and merge reviewed #7 at product execution; resolve only integration conflicts and recheck the interfaces below before installing dependencies. Preserve unrelated worktrees/installed app state. Docs preparation runs no product tests, artifact authoring or services.

| #7 dependency | Required contract | #71 usage |
| --- | --- | --- |
| `types/transcript-editing.ts` | `TranscriptGuard` with hash and monotonic version | Preview/validate request; ABA conflict. |
| `shared/lib/transcript-source.ts` | `sourceRevision`, `renderAcceptedTranscript`; existing hash bytes unchanged | Server source identity/canonical accepted text; do not barrel-export Node hashing to browser. |
| normalized Session | `transcriptVersion` zero for legacy, current transcript/segments, finalized flag | Snapshot uses accepted source, never candidates/history or stale SRT file. |
| `types/notes.ts`, portable v2 | `sourceRevision:string|null`, unknown means stale | Honest labels for v1 imported notes; never infer provenance from legacy normalization. |
| client `lib/acceptedSession.ts`/store | `guardForSession`, guarded `load/accept` merging | Refresh after 409 without resurrecting older accepted content. |

The #7 spec/plan currently reside in its dedicated branch at docs head `9b0723e`; do not copy implementation files or change that worktree. If finalized names change during #7 review, update this table/Task 1 references to the actual merged interface without weakening the contract.

The browser-safe shared `packages/shared/lib/export-timing.ts` owns cue validation/wrapping, used by server preview and client serialization. New server files own selection/key validation (`meeting-export.ts`) and HTTP parsing/routing (`meeting-export-http.ts`). New client export files own pure blocks (`content.ts`), subtitles (`subtitles.ts`), PDF/font layout (`pdf.ts`), module worker transport (`export.worker.ts`, `worker.ts`) and download cleanup (`download.ts`). Dialog state is in `MeetingExportDialog.tsx`; SessionsPage owns opening it after ActionMenu closes. No new Session/source writer is introduced.

All paths below are repository-relative. Commands run in this worktree; client tests use documented `NODE_OPTIONS=--no-experimental-webstorage`. Agent tasks execute serially because they share the snapshot contract; independent review checks each deliverable and then the full branch.

## Task 1: Sanitized snapshot, selection and truthful provenance

**Files:** Create `packages/shared/types/meeting-export.ts`, `packages/shared/lib/export-timing.ts`, `packages/server/lib/meeting-export.ts`, `meeting-export.test.ts`. Modify `packages/shared/types/index.ts`. Read #7 source helpers, notes normalization and `packages/server/lib/meeting-tasks.ts`.

**Interfaces:** Shared types are exactly those in the spec. Produce `createMeetingExportPreview(session:Session,tasks:TaskView[],input:MeetingExportPreviewInput,generatedAt:string):MeetingExportPreview` and `validateMeetingExportPreview(session:Session,tasks:TaskView[],input:MeetingExportValidateInput):{valid:true;snapshotKey:string}`. Also produce browser-safe `SubtitleCue = {startMs:number;endMs:number;text:string;sourceIndex:number}` and `buildTimedExportCues(segments:MeetingExportSnapshot['segments'],duration:number|null,speakers:boolean):{cues:SubtitleCue[];warnings:MeetingExportWarning[]}` in the shared helper. Server subtitle preview uses it for validity/overlap/density warnings; the client reuses it in Task 3. Use structured `MeetingExportError` with `status:400|404|409|413` and `code:string`. Hash deterministic allowlisted data server-side, excluding acknowledgment fields/generatedAt; include source hash/version even for notes-only PDF. Normalize a finite positive duration to number, otherwise null.

- [ ] Write pure behavior tests using synthetic finalized EN/PT segments and accepted tasks. Pin: `sourceVersion:3`, corrected text only, unknown notes `{sourceRevision:null,stale:true}`, omitted unselected fields, no sentinel paths/keys/embeddings/history/candidates anywhere in JSON, and guards fail for old version despite restored hash. Assert notes/task-only PDF succeeds with empty transcript, while all-empty and provisional selections fail.
- [ ] Write selection/review tests for all format combinations, duplicate/unknown/other-meeting task IDs, suggested/dismissed exclusions, status open/completed, missing notes, stale/unknown warnings, per-export notes hash and current task revision binding. Title/selected notes/task/source changes invalidate key; unselected note/task changes do not. Delay does not change the key/generatedAt of the frozen preview. Exact encoded deterministic key-payload UTF-8 byte limit and one-over fail before expensive work. Add timing/overlap/42-grapheme wrapping availability assertions for the shared helper; no invalid subtitle preview silently omits recognized content.
- [ ] Run `bun test packages/server/lib/meeting-export.test.ts`; require meaningful new-behavior failures.
- [ ] Implement the named pure functions and deterministic key/review hashes. Initial preview may return selected unreviewed notes; validate requires exact acknowledgment. Keep source/provenance/tasks unchanged; no saves, model/audio calls or persistent review subsystem. Tasks sort by createdAt then ID; DTOs strip evidence/audioAvailability. Notes legacy unknown handling must come from #7, not a duplicate fallback.
- [ ] Rerun the command with zero failures; commit `feat: define sanitized frozen meeting export snapshots`.

## Task 2: Protected preview/validate HTTP and typed client

**Files:** Create `packages/server/lib/meeting-export-http.ts`, `meeting-export-http.test.ts`, `packages/client/src/api/meeting-export.ts`, `meeting-export.test.ts`. Modify `packages/server/server.ts` near existing protected session/task routes.

**Interfaces:** `MeetingExportReaders = {session:(id:string)=>Session|null;tasks:(id:string)=>TaskView[];now:()=>string}`; `meetingExportResponse(req:Request,readers:MeetingExportReaders,allowed:boolean):Promise<Response|null>` handles the two POST routes from the spec. Reads use `notesService.read(id)`/`tasksService.snapshot(id).tasks`, synchronously after parsing; no await between capture/validation of source/tasks. `meetingExportApi.preview(id:string,input:MeetingExportPreviewInput):Promise<MeetingExportPreview>` and `.validate(id:string,input:MeetingExportValidateInput):Promise<{valid:true;snapshotKey:string}>` use encoded IDs and existing apiClient/ApiError.

- [ ] Write owned real-HTTP tests with temp stores: safe ID routing, nonlocal/invalid origin denial, malformed/unknown JSON fields, 16,000,000-byte streamed-body bound, no Content-Length bypass, missing meeting, provisional/all-empty, cross-meeting task ID, notes/task review mismatch and ABA/source/key 409. Assert successful responses contain no sentinel sensitive fields and no disk state changes.
- [ ] Write two-request races: preview, then notes regeneration/task completion/deletion/transcript edit, then validate; each selected change conflicts. Metadata title changes conflict; unchanged data validates after clock advance. Capture a valid snapshot, edit source after validate, and assert renderer inputs still equal the original snapshot rather than a refreshed store. Typed client encodes meeting IDs and preserves status/message for conflict/413.
- [ ] Run `bun test packages/server/lib/meeting-export-http.test.ts` and `NODE_OPTIONS=--no-experimental-webstorage bun run --cwd packages/client test --run src/api/meeting-export.test.ts`; confirm new assertions fail first.
- [ ] Implement bounded parsing, stable status/code errors and existing loopback/origin enforcement. Inject existing read services, never invoke model generation or media endpoints; validate returns only `{valid:true,snapshotKey}`. Ensure maintenance admission retains normal short-lived read-only request behavior without a long model lease.
- [ ] Rerun focused commands plus Task 1 tests/typecheck; commit `feat: expose guarded meeting export preview and validation`.

## Task 3: Literal content blocks and valid subtitle serializers

**Files:** Create `packages/client/src/lib/export/content.ts`, `content.test.ts`, `subtitles.ts`, `subtitles.test.ts`; add pinned dev-only `subtitle` 4.2.2 in client package/lock. Extend shared export types only with client-safe block/cue types if needed; no source changes.

**Interfaces:** `ExportBlock = {kind:'heading'|'paragraph'|'provenance';text:string}`; `buildExportBlocks(preview:MeetingExportPreview):ExportBlock[]` returns metadata then selected sections, omitting disabled speaker/time/optional task fields. `buildSubtitleCues(snapshot:MeetingExportSnapshot,speakers:boolean):{cues:SubtitleCue[];warnings:MeetingExportWarning[]}` delegates to Task 1 shared `buildTimedExportCues`; `serializeSubtitles(format:'srt'|'vtt',snapshot:MeetingExportSnapshot,speakers:boolean):string`. Renderer input is the frozen preview only. Return actionable errors for invalid timing/text, never use `Session.files.srt`.

- [ ] Write cue tests: `Math.round(1.2346*1000)===1235`, `0.0001..0.0004` collapses and fails, finite safe nonnegative intervals, end > start, optional duration bound, hours beyond 24, unsorted stable ties, cross-channel overlap retained, empty segments omitted and all-empty rejected. Assert one cue per nonempty segment despite corrected long text; 42-grapheme wrap keeps combining sequences/emoji intact and warnings reflect >2 lines/>20 graphemes per second.
- [ ] Write roundtrip fixtures with PT/EN/FR/DE, decomposed accents, literal `<b>`, `&amp;`, blank lines and `-->` in text/speaker names. Independent `subtitle` parser returns exactly the expected numbered times/cue count; decoded visible text under documented whitespace policy matches source. VTT has its NOTE and no metadata cue; SRT starts with cue 1. Invalid scalar/NUL text fails clearly. Content block tests exclude unselected sections and label unknown/earlier provenance without mutating stale flags.
- [ ] Run `NODE_OPTIONS=--no-experimental-webstorage bun run --cwd packages/client test --run src/lib/export/content.test.ts src/lib/export/subtitles.test.ts`; verify meaningful failures.
- [ ] Implement literal blocks and serializers using the shared millisecond validation/stable sort/grapheme helper plus format-specific escaping. Never emit note HTML/remote images or invent word timings. Add native browser TextTrack parsing to Task 6 for actual VTT entity/overlap behavior; parser-only tests cannot certify playback compatibility.
- [ ] Rerun focused tests and typecheck with zero failures; commit `feat: serialize corrected timed meeting subtitles`.

## Task 4: Bundled-font PDF and cancellable local worker

**Files:** Create `packages/client/src/lib/export/pdf.ts`, `pdf.test.ts`, `export.worker.ts`, `worker.ts`, `worker.test.ts`, `download.ts`, `download.test.ts`, `fonts/NotoSans-Regular.ttf`, `fonts/NotoSans-Bold.ttf`, `fonts/OFL.txt`, `fonts/manifest.json`. Modify client package/lock and `CREDITS.md` for the two pinned MIT libraries and actual font license.

**Interfaces:** `renderMeetingPdf(preview:MeetingExportPreview,fonts:{regular:Uint8Array;bold:Uint8Array}):Promise<Uint8Array>` validates glyphs, builds Task 3 blocks and emits A4 PDF bytes/metadata. `startMeetingExport(preview:MeetingExportPreview):{result:Promise<MeetingExportArtifact>;cancel:()=>void}`, where `MeetingExportArtifact={bytes:Uint8Array;mime:'application/pdf'|'application/x-subrip'|'text/vtt';extension:'pdf'|'srt'|'vtt';snapshotKey:string}`. Worker messages carry `{jobId,preview}` or `{jobId,artifact}`/`{jobId,error}`; main ignores noncurrent IDs. `downloadMeetingExport(artifact,title):()=>void` creates one local Blob/download and returns idempotent cleanup; filename strips separators/control characters and has an appropriate extension.

- [ ] Write PDF tests with selected scope: metadata has full source/date, correct A4 page size/margins/body size, multiple pages for long text, no unselected/sensitive sentinel fields, plain note markup and task optional fields. Test long unbroken speaker/title strings, heading/speaker at page bottom, notes-only/tasks-only, EN/PT/FR/DE/combining marks, and explicit missing-glyph failure (including unsupported emoji) before output. Use independent extraction in Task 6; loading the PDF with pdf-lib alone is not reading-order proof.
- [ ] Write worker/download tests: lazy PDF import/fonts, external font fetch absent, selected UTF-8 bound checked before generation, failure remains retryable, cancel terminates the owned worker, late result cannot resolve/download, changing job ID ignores old messages, Blob references revoked on close/replacement/unmount. Subtitle worker output equals Task 3 serializer. Repeated cleanup is safe; no app/source/media/provider/retention call.
- [ ] Run `NODE_OPTIONS=--no-experimental-webstorage bun run --cwd packages/client test --run src/lib/export/pdf.test.ts src/lib/export/worker.test.ts src/lib/export/download.test.ts`; confirm failures before implementation/assets are introduced.
- [ ] Pin exact libraries locally, bundle verified licensed static fonts with official source/version/hash manifest, implement measured layout and glyph preflight using font coverage/width APIs. Preserve user scalar text and extraction order, use fixed 11pt/1.35 line spacing/48pt margins, keep headings with first two lines, split across A4 pages and add page/source footers. No silent boxes/transliteration or shrinking to one page. Worker uses `new Worker(new URL('./export.worker.ts',import.meta.url),{type:'module'})`; PDF code/fonts import only for PDF, subtitles share the cancellable boundary.
- [ ] Rerun focused tests, typecheck and `bun run build`; inspect build output for locally bundled worker/fonts and no external URLs; commit `feat: generate Unicode meeting PDFs in an owned local worker`.

## Task 5: Accessible scope preview, review and Save flow

**Files:** Create `packages/client/src/components/sessions/MeetingExportDialog.tsx`, `MeetingExportDialog.module.css`, `MeetingExportDialog.test.tsx`, `ActionMenu.exports.test.tsx`, `packages/client/src/lib/translations-exports.ts`, `translations-exports.test.ts`. Modify `ActionMenu.tsx`, `SessionsPage.tsx`, `ActionMenu.module.css`, `lib/i18n.ts`; preserve #7's existing ActionMenu correction tests.

**Interfaces:** ActionMenu gains `onExport:(session:Session)=>void`; a keyboard-accessible “Export PDF or subtitles…” button calls it then closes the menu. SessionsPage retains the persistent SessionItem menu-button `event.currentTarget` as `trigger` (not the soon-unmounted ActionMenu export button), owns `{sessionId,trigger}` and renders `MeetingExportDialog({sessionId:string;onClose:()=>void})`, restoring focus to that connected menu control, with the meetings heading as fallback if the row was deleted. Dialog reads the current accepted store Session, gets accepted default tasks using `tasksApi.list(sessionId)`, builds guards via #7 `guardForSession`, and uses Tasks 2/4 APIs. Its state machine is choosing → previewing → review-ready → validating → generating → completed, with conflict/error/cancel returning to retryable choosing/review states.

- [ ] Write component tests for PDF transcript/notes/tasks combinations; transcript-only forced SRT/VTT; speaker/time disabled without transcript; missing/untimed/provisional feedback; actual selected text shown before Save; accepted-only defaults. Notes checkbox acknowledgment binds preview hash and selected task revisions; stale/unknown requires separate acknowledgment/visible provenance. Format/scope changes clear obsolete review/artifacts.
- [ ] Write conflict/cancellation tests: notes/task changes after review cause validate409 and fresh review; refresh uses guarded #7 store load/merging; deleted meeting closes generation with clear feedback; late preview response cannot replace newer selection; failed validate/renderer preserves choices; Cancel/Escape/close/unmount releases worker/blob; completed valid artifact alone enables Save; source change after validate does not switch frozen renderer input. Assert no actual source/review/retention mutations.
- [ ] Write legacy action golden tests: transcript/speakers/notes copy, Markdown/text downloads and copy-everything outputs remain identical for corrected finalized Session. Test new button Enter/Space, native Dialog focus containment/return, narrow viewport and literal EN/PT-BR/FR/DE labels/status/errors; no nested controls or hover-only new flow.
- [ ] Run `NODE_OPTIONS=--no-experimental-webstorage bun run --cwd packages/client test --run src/components/sessions/MeetingExportDialog.test.tsx src/components/sessions/ActionMenu.exports.test.tsx src/lib/translations-exports.test.ts`; confirm new behavior fails.
- [ ] Implement the dialog using existing `components/layout/Dialog.tsx` and i18n table conventions. A new preview request resets acknowledgments; never reuse an old content review after conflict. Generate first revalidates source/key/current acknowledgments, then freezes/clones preview for the worker. The separate Save action downloads only the completed bytes; do not promise later edits are reflected. Rerun focused tests, #7 ActionMenu regressions and typecheck; commit `feat: add reviewed selective offline export controls`.

## Task 6: Independent artifacts, offline/runtime evidence and handoff

**Files:** Create `scripts/qa/meeting-exports.mjs`, `scripts/qa/verify-meeting-exports.py`, `packages/server/lib/meeting-export-workflow.http.test.ts`, `docs/meeting-exports.md`, `docs/qa/issue-71-offline-exports.md`. Add authored fixtures under `scripts/qa/fixtures/meeting-exports/` (short/long EN/PT, four-language accent sample, overlapping cues, unknown notes, tasks-only) with provenance README. Modify `.github/workflows/ci.yml` only for required QA parser/browser/prerequisite checks, not to skip them.

**Interfaces:** `meeting-exports.mjs --output DIR` launches only owned isolated fixture API/built UI, uses Playwright to deny every external request, exercises production dialog/worker, collects PDF/SRT/VTT and validates browser TextTrack; exits nonzero on selection/freeze/network/cancellation failure and shuts down children/ports in finally. `verify-meeting-exports.py --input DIR --render DIR` independently parses PDF metadata/text/page count and subtitles (or consumes independent parser results), invokes `pdftoppm` for all fixture pages, and reports content-free counts/hashes/errors. Artifacts and PNGs stay outside tracked source; manifest identifies source revision/selection/expected decoded text using public synthetic fixtures only.

- [ ] Write real HTTP workflow assertions: correct/revert source via #7, preview and review, edit accepted task/notes, conflict on validate, regenerate, successfully validate and export frozen selected content despite later source edits. Compare audio digest/state before/after without serving media; existing notes stale/task source-state remains unchanged. Initial isolated fixtures contain sentinel paths/config/embeddings/candidates; no sentinel reaches decoded output.
- [ ] Run `bun test packages/server/lib/meeting-export-workflow.http.test.ts`; require zero failures. Earlier tasks may make this integration test green initially; use controlled held responses/source mutations to prove its negative cases, not artificial product faults.
- [ ] Add the QA runners, then run `node scripts/qa/meeting-exports.mjs --output /private/tmp/heed-issue-71-artifacts` and `python3 scripts/qa/verify-meeting-exports.py --input /private/tmp/heed-issue-71-artifacts --render /private/tmp/heed-issue-71-rendered`. Apply the PDF skill before first artifact authoring. Use an isolated QA environment for pypdf/pdfplumber and Poppler if unavailable; pin recorded QA versions, never mutate installed app Python. Inspect every rendered synthetic page, especially first/middle/last of long documents, margins, line spacing, glyphs, headings, page/source footers and extraction order. Iterate until artifacts are readable and parsers/visible text agree. A parser pass alone cannot approve layout.
- [ ] Run full server/client suites, client typecheck/build and `git diff --check`; require zero relevant failures. Record exact results, lockfile/license/font hashes, offline denied-request count and worker cleanup. Add CI artifact parser/browser checks with necessary free prerequisites and synthetic outputs, verifying all checks run rather than merely exist.
- [ ] With controller-owned isolated services/data, perform actual offline file generation/opening on both MacBook Air M1 and MacBook Pro M4 Pro; verify PDF/subtitle files, EN/PT selections, four locales, narrow/keyboard UI, stale conflict/review and cancel while recording controls remain responsive. Report actual runtime separately from mocks/parsers; do not imply physical capture or subjective ASR quality from these exports. Stop/verify only owned services/processes and revoke temporary blobs before handoff.
- [ ] Document exact supported glyph repertoire and unsupported fallback, subtitle overlap/reading-density/whitespace limits, reviewed/stale provenance, frozen revision semantics, offline/assets and downloads outside managed deletion. Commit `test: verify offline export artifacts and source provenance`.
- [ ] Obtain whole-branch independent review and resolve applicable blockers. Controller owns subsequent push/PR/CI/merge and AGENTS.md handoff: all intended work committed/pushed, fetched branch equality, owned services stopped, safe clean worktree removal from outside it and verified absence. Do not close #71 while applicable actual artifact/runtime evidence is pending.

## Self-review and coverage

Spec coverage: scope/finalization/source guards/sanitization/bounds/review/legacy provenance (Tasks 1–2), subtitle timing/literal Unicode/overlap (3), fonts/layout/offline worker/memory cleanup (4), preview/selective UI/four locales/old exports (5), independent parsers/visual artifacts/two-Mac runtime/retention and secret absence (6). All five Review Focus conditions have explicit owning tests. Types and function names agree with the spec and between tasks; source helpers are server-only, client consumes typed snapshots. Future #7 dependencies are clearly identified rather than reported as implemented on this base.

Current baseline ActionMenu has text/Markdown copy/downloads, SessionsPage owns its menu and native Dialog already supports focus containment. Current notes normalization fabricates legacy provenance; #7 must replace that before #71 executes. Existing tasks snapshot contains accepted records separately from suggestions; no new task-acceptance state is necessary. Libraries' current version/license metadata was checked via npm during planning; actual font coverage, browser bundling, artifacts and performance remain implementation evidence, not claims from this document. No product files/dependencies/services/artifacts were changed during plan preparation.
