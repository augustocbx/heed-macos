# Recoverable Transcript Corrections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. The user selected agent execution; review this written plan before implementation.

**Goal:** Deliver saved-meeting text corrections, recoverable recognized text, previewed literal replacement and explicitly accepted retranscription candidates.

**Architecture:** Keep accepted text canonical on Session and commit accepted source/history/provenance through one synchronous, quota-reserved atomic session boundary. Preserve the content hash for derived evidence and add a device-local monotonic version for concurrency. Portable v2 carries accepted history/provenance while device-local candidates, receipts, versions and diagnostics stay local.

**Tech Stack:** Existing Bun/TypeScript server and atomic JSON storage, React/Zustand/Vitest client, current ASR finalization API; no new product dependency.

**Spec:** [Approved architectural specification](../specs/2026-10-06-issue-7-transcript-corrections.md).

## Global Constraints

- This feature operates on finalized saved meetings, including untimed transcripts and meetings without available audio. Live capture remains unchanged.
- English, Brazilian Portuguese, French and German interface translations remain supported.
- It introduces no ASR engine, vocabulary assistance, cloud publication, sharing, PDF export or secure-erasure guarantee.
- Existing quota and portable synchronization policies remain authoritative.
- Bound accepted serialized portable content, including recovery history, to the existing 16,000,000-byte artifact limit.
- Allow at most two pending candidates per meeting, each with at most 16,000,000 serialized bytes; replacing a pending candidate requires explicit discard.
- Bound each submitted text command to 1,000,000 UTF-8 bytes and 1,000 affected targets.
- Never silently prune original recognition or accepted history. Candidates, request receipts and local transcriptVersion counters do not cross devices.
- English source/comments/documentation/commit messages; preserve user-authored language content. Never add author-credit trailers.
- Keep all work in this issue worktree; preserve PR #91 attribution/diagnostics and PR #89 scheduling behavior. Recheck current integration state before code changes; do not touch the active synchronization worktree.
- Use synthetic/licensed fixtures. Keep private recordings, transcripts, credentials and logs out of the repository.

## Review Focus

1. A retry after a successful save and lost response must not apply an edit twice, even after reload or revert (Tasks 1–2).
2. An old notes/polling response arriving after a correction must not restore old text or clear newly stale provenance (Tasks 2 and 5).
3. Importing an old v1 artifact must not fabricate notes provenance, lose local candidates/history, or change immutable integrity comparisons (Task 4).
4. An IME composition, decomposed accent or multiline draft must survive refresh/conflict without normalization or accidental seeking (Task 6).
5. Candidate acceptance racing another tab's rename/discard must preserve both speaker identity and the already accepted source; quota failure must preserve recovery state (Tasks 2–3 and 7).

---

## Execution boundaries and writer audit

Start from `2bd4815bbaf6ae5f26b0faccec68bd698892342c` (approved spec on product base `f13c3da`). Run tasks serially because they share Session/store/source-write interfaces. Use a fresh reviewer after each task, then whole-branch review. The user has authorized isolated synthetic UI validation and push/merge after the applicable criteria pass. Written-plan review remains the gate before implementation; individual task commits are not completion or physical acceptance evidence.

File paths beginning `components/`, `stores/`, `api/` or `lib/` within client tasks are relative to `packages/client/src/`. Bare server filenames within server tasks are relative to `packages/server/lib/`. All commands run from the issue worktree root unless `--cwd` explicitly selects the client package.

| Current writer/reader | Required ownership after this change |
|---|---|
| `server.ts` handleCreateSession; coordinator adapter save; `recording-coordinator.ts` saveFinal | Initial source creation initializes local version; duplicate recovery/create returns existing source without replacing corrections. |
| `AutomaticNotesService.patch`; `SessionTags.patch`/`preparePatch` | Untrusted source patches require hash + local version; derived/server-owned fields are not caller writable. |
| `SessionDetail.tsx` rename/merge | Guard patches from the displayed source; derive canonical transcript server-side. |
| `ResultCard.tsx` saved rename/merge | Use the latest saved Session and guards, not stale recording-store segments; pending coordinator rename retains its existing coordinator revision contract. |
| `recordingSession.ts` createRecordingSession reconciliation/finalization | Carry the returned hash/version through each PATCH; preserve `finalSavePending` and unpublished-ID behavior. This compatibility path edits only its not-yet-finalized source. |
| `RecoveryBanner.tsx` orphan recovery | Initial create only; duplicate ID/audio cannot overwrite an existing edited meeting. |
| `sessionTranscription.ts` direct retranscription save | Replace with candidate staging; explicit acceptance owns source replacement. |
| `PortableLibrary.importSelected`/`resolveConflict`/constructor commit-intent recovery | Trusted guarded replacement through the atomic source boundary, recoverable old source retained, schema-specific comparison/provenance. |
| Portable audio migration, `requestAudio`, archival flags and `server.ts` quota eviction | Metadata-only atomic saves preserve source/history/version/candidates exactly. Re-read after awaits. |
| SessionTags tag transaction/mutation; title/pin PATCH | Preserve source state; do not increment transcriptVersion. |
| Notes controls/progress/completion saves | Read latest source before save; preserve editing state. Provenance/hash checks and generation admission remain intact. |
| Session store accept/update/load/view; ResultCard display/copy | Older source responses cannot replace newer accepted source; finalized saved views use the saved source. |
| SessionDetail/SessionsPage/ActionMenu; meeting/library chat and tasks | Read current accepted canonical text; old evidence remains source-bound and visibly stale. |

## Task 1: Define recovery state and pure text operations

**Files:** Create `packages/shared/types/transcript-editing.ts`, `packages/shared/lib/transcript-source.ts`, `packages/server/lib/transcript-editing.ts`, `packages/server/lib/transcript-editing.test.ts`. Modify `packages/shared/types/session.ts`, `packages/shared/types/index.ts`, and `packages/server/lib/automatic-notes.ts` to re-export its existing source hash from the shared source module without changing hash bytes.

**Interfaces:** Define `TranscriptGuard = {expectedTranscriptRevision:string; expectedTranscriptVersion:number}`; `TranscriptTarget = {kind:'segment';index:number}|{kind:'document'}`; `ReplaceInput = {query:string;replacement:string;caseSensitive:boolean;wholeWord:boolean}`. Define `TextChange = {target:TranscriptTarget;before:string;after:string}` and `ReplacementPreview = {key:string;guard:TranscriptGuard;changes:TextChange[];matchCount:number}`.

`RecognitionGeneration` contains `id`, `createdAt`, `origin:'recognition'|'legacy-preserved'`, canonical transcript, segments/speakers, language/model/duration and optional sanitized diagnostics. `TranscriptEdit` contains `id`, optional local `requestId`/`requestSignature`, generation ID, kind `edit|replace|revert`, changes, timestamp and before/after source hashes. Locally created edits require their request fields; portable-imported actions omit them. `TranscriptCandidate` contains ID/request signature/time, base guards and finalized recognition fields plus optional local embeddings/diagnostics. `TranscriptEditingState` contains `schemaVersion:1`, active generation ID, generations, edits, candidates and candidate request receipts; each receipt stores request ID/signature/candidate ID and terminal status. Add optional stored Session `transcriptVersion` and `transcriptEditing`; normalized API responses supply version zero for legacy records. Add optional `expectedTranscriptVersion` to SessionPatch.

`TranscriptCommand` combines guard/requestId with `edit(target,text)`, `replace(input,expectedPreviewKey)`, `revert(editId)` or `accept-candidate(candidateId)`. Produce `sourceRevision(source:Pick<Session,'transcript'|'language'|'speakers'|'segments'>):string`, `renderAcceptedTranscript(segments:Segment[]):string`, `normalizeTranscriptSession(session:Session):Session`, `previewReplacement(session:Session,input:ReplaceInput,guard:TranscriptGuard):ReplacementPreview`, and `applyTextCommand(session:Session,command:TextOnlyCommand,now:string):Session` (`TextOnlyCommand` excludes accept-candidate). Pure transforms construct history/text but never increment local version, persist or invalidate jobs; Task 2 owns the version increment. Server imports the synchronous hash module directly; do not export Node crypto runtime code through the browser shared barrel. Export only transcript types there.

- [ ] Write behavior tests: EN/PT correction changes only text/canonical transcript; `attribution:'fallback'`, `auto`, timing, channels, embeddings and diagnostics remain equal; empty segment/document accepted; no-op has no version/history churn; original retained once; inverse edit preserves later rename/unrelated target; incompatible revert conflicts. Assert unchanged legacy `sourceRevision` hashes with fixed golden fixtures.
- [ ] Write literal replacement tests: punctuation/regex-looking query, Unicode case/word boundaries, underscore/apostrophe/hyphen, composed/decomposed accents, line breaks, no cross-segment matching, no matches, empty replacement, mismatched preview key and HTML-looking text. Test exact 1,000-target and 1,000,000-byte boundary plus one-over failures; reject NUL/unpaired surrogates and invalid indices.
- [ ] Run `bun test packages/server/lib/transcript-editing.test.ts`; verify failures demonstrate missing behavior, not malformed fixtures.
- [ ] Implement the named types/functions. Preserve exact-code-point matching, CRLF-to-LF conversion and input offsets. Capture legacy baseline lazily; use compact text actions and plain content. Re-export the old hash through `automatic-notes.ts` to avoid dependency cycles with storage.
- [ ] Rerun the focused test command; require zero failures. Commit only this deliverable: `feat: define recoverable transcript text operations`.

## Task 2: Establish the single atomic accepted-source boundary

**Files:** Modify `packages/server/lib/session-tags.ts`, `automatic-notes.ts`, `server.ts`, `packages/shared/types/notes.ts`, `packages/client/src/components/ai-notes/NotesJobStatus.tsx`. Create `packages/server/lib/transcript-persistence.test.ts`; extend `automatic-notes.test.ts`, `session-tags.test.ts` and `recording-coordinator.test.ts`.

**Interfaces:** Add `SessionTags.commitSource(id:string,guard:TranscriptGuard|null,build:(current:Session|null)=>Session):Session`. Null guard is allowed only when the ID does not exist. It reads latest, checks mandatory source guards, validates recovery bounds, increments the local version for a real accepted-source transition and atomically saves once. `SessionTags.save(session:Session)` remains metadata-only: reject changed source/hash/version/history/candidate state relative to latest rather than permitting bypass.

Add `SessionTags.commitTranscriptState(id:string,build:(current:Session)=>Session):Session` for candidate/receipt metadata only; verify accepted hash/version/source unchanged, then atomically write. Add `AutomaticNotesService.commitTranscript(id:string,command:TranscriptCommand):Session`, initially supporting Task 1 commands; Task 3 adds acceptance. Add `AutomaticNotesService.replaceAccepted(id:string,guard:TranscriptGuard,build:(current:Session)=>Session):Session` for trusted source transitions. Both invoke source-bound job/provenance changes inside `commitSource`; abort active work only after a successful commit. Existing notes-only writes stay metadata-only.

Make unknown notes explicit: `NotesMetadata.sourceRevision:string|null`; null means unknown, with `stale:true`. Normalize legacy notes lacking provenance to null, never to the current hash. Regeneration/manual guarded notes saves supply a known source. Accepted source changes keep earlier notes stale; generic PATCH cannot simultaneously erase history/provenance. Source-field allowlist covers transcript, segments, speakers, language, finalized state and source-changing model/duration/embedding/diagnostic replacement. Metadata-only patches cannot smuggle those fields.

- [ ] Write actual storage/HTTP behavior tests: two guards compete and only first succeeds; edit/revert restores hash but an old version fails; lost-response retry returns acknowledgment without duplicate journal; reused request ID with different contents fails; quota/write faults leave original file/history/version and active source intact. Assert journal request receipts remain available after reload, without storing full Session copies.
- [ ] Write tests for every audit row classified metadata-only: tag transaction, title/pin, quota/audio flags and notes progress preserve source fields, version/history/candidates. Missing guards and direct source-changing `save` fail; initial creation/version and duplicate recovery preserve edits.
- [ ] Run `bun test packages/server/lib/transcript-persistence.test.ts packages/server/lib/automatic-notes.test.ts packages/server/lib/session-tags.test.ts packages/server/lib/recording-coordinator.test.ts`; verify the new assertions fail first.
- [ ] Implement the boundary and migrate `AutomaticNotesService.create/patch/save` plus coordinator creation wiring. Enforce 16,000,000-byte accepted portable-state bound before persistence; preserve existing atomic reservation/fsync recovery. Keep unchanged finalized source no-ops idempotent; do not increment on metadata/candidate changes. Reject unsafe-integer version overflow before commit.
- [ ] Add held-generator assertions: correction supersedes old notes output, old chat/task source is stale, unknown notes remain unknown, metadata-only notes response cannot overwrite correction, and failure before persistence does not falsely publish staleness. Existing pending-chat scheduler remains the admission authority.
- [ ] Rerun focused commands with zero failures; commit `feat: guard and atomically persist accepted transcript changes`.

## Task 3: Durable candidates and protected transcript HTTP API

**Files:** Create `packages/server/lib/transcript-service.ts`, `transcript-editing-http.ts`, `transcript-editing-http.test.ts`, `transcript-candidates.test.ts`. Modify `server.ts`, `automatic-notes.ts`, `packages/server/lib/transcript-editing.ts`, and shared transcript types.

**Interfaces:** `CandidateInput = {requestId:string;base:TranscriptGuard;result:TranscribeResult}`. `TranscriptService` consumes the notes service/SessionTags, clock and diagnostic sanitizer; produces `preview(id:string,input:ReplaceInput,guard:TranscriptGuard):ReplacementPreview`, `command(id:string,input:TranscriptCommand):Session`, `stage(id:string,input:CandidateInput):Session`, and `discard(id:string,candidateId:string,requestId:string):Session`.

`transcriptEditingResponse(req:Request,service:TranscriptService,allowed:boolean):Promise<Response|null>` routes `POST /api/sessions/:id/transcript/preview`, `/commands`, `/candidates`, and `POST /api/sessions/:id/transcript/candidates/:candidateId/discard`. Request bodies use the corresponding exact interfaces; discard supplies `{requestId}`. Require existing loopback/origin protection for every route, encoded safe meeting IDs, at most 16,000,000 request-body bytes read before JSON parsing, and request IDs of 1–128 characters. Use stable errors: 400 invalid input, 403 denied, 404 missing, 409 stale/conflict/quota, 413 oversized body. Candidate responses contain normalized Session; no new audio paths are accepted from candidate result files.

- [ ] Write real Bun HTTP tests for denied origins, malformed/oversized bodies, all commands and restart: edits/receipts persist; preview apply is atomic; no final source means editor denied; metadata-only title/tag updates survive; save faults retain accepted source. Use temporary fixtures and owned ephemeral servers, not dev services.
- [ ] Write candidate tests: complete stream result validation, at most two pending candidates, exact candidate-byte bound, third candidate refused until explicit discard, reused stage/discard IDs idempotent, and stale-base candidate retained with acceptance denied. Wrong candidate/discard race cannot replace text. Acceptance retains old generations/actions and preserves reconciled manual names, fallback attribution, diagnostics, returned embeddings and original audio path/bytes.
- [ ] Run `bun test packages/server/lib/transcript-editing-http.test.ts packages/server/lib/transcript-candidates.test.ts`; confirm behavior failures before implementing routes/state.
- [ ] Implement stage/discard through `commitTranscriptState` and acceptance through `commitTranscript`. Candidate receipts have at most 1,000 entries; exhausted receipt capacity rejects new candidate requests without pruning, while terminal updates/discard of existing entries remain allowed. Accepted journal signatures remain with their actions. Reserve the full local atomic write, including candidates/receipts; never count candidate bytes as portable content.
- [ ] Extend held-job tests to prove stage/discard does not alter hash/version or supersede derived jobs, and acceptance does. Rerun focused tests plus `bun test packages/server/lib/meeting-chat.test.ts packages/server/lib/library-chat.test.ts packages/server/lib/meeting-tasks.test.ts`; require zero failures. Commit `feat: stage and explicitly accept transcript candidates`.

## Task 4: Compatible portable history and provenance

**Files:** Modify `packages/shared/types/portable-storage.ts`, `packages/server/lib/portable-schema.ts`, `portable-library.ts`, `portable-runtime.ts`. Create `packages/server/lib/portable-transcript.ts`, `portable-transcript.test.ts`; extend `portable-schema.test.ts`, `portable-integration.test.ts`, `portable-migration.test.ts`.

**Interfaces:** `PortableMeeting` becomes the v1/v2 discriminated union. V2 adds accepted `transcriptHistory` (active generation, portable generations/actions) and `notesMetadata` (known/unknown provenance); it excludes candidates, request IDs/signatures/receipts, local versions, diagnostics, paths and embeddings. V2 current/history segments preserve `auto` and `attribution`; v1 projection is byte-for-byte unchanged.

`portableMeeting(session:Session,meetingId:string,audio?:PortableAudio,version?:1|2):PortableMeeting` supports an explicit integrity projection. New corrected/history/provenance-bearing records select v2. `acceptedPortableHash(session:Session,payload:PortableMeeting):string` hashes the projection for that payload's version. `preparePortableTranscript(current:Session|null,incoming:Session,now:string):Session` merges recoverable accepted generations/actions by ID, rejects conflicting IDs/bounds, keeps local candidates/receipts, preserves diagnostics/embeddings only when still applicable to unchanged accepted source, and assigns no remote local version.

When preserved local recovery state makes the accepted projection differ from received bytes, catalog Entry stores separate `acceptedPayloadHash`, `acceptedProjectionVersion` and device-local `acceptedTranscriptVersion`; `payloadHash` continues to describe immutable received bytes. Commit-intent recovery/local drift compares both the saved accepted projection and local version with the accepted baseline, not a fabricated equality to the remote artifact. This catches edit-and-revert/history changes even when a v1 projection omits them. Existing catalog entries without local stamps use legacy projection checks and conservatively report conflict when newly added correction history is present. Subsequent explicitly queued publication creates a child containing preserved history; this task does not auto-publish.

- [ ] Write v1 golden-byte/hash fixtures and v2 roundtrip assertions: original text/journal/provenance/attribution survive; local counters/candidates/receipts/diagnostics/embeddings/paths are absent; unknown notes stay unknown. Unsupported schema, malformed history references, cycles, duplicate-ID collisions, oversized content and forged source provenance reject before writing a Session.
- [ ] Write two-device import/conflict tests: local guard is checked after remote awaits; concurrent correction becomes conflict; explicit replacement retains old accepted history and local candidates; local version increments once. Constructor restart recognizes complete accepted commit-intent, while failed atomic source write never acknowledges import. Empty current/library metadata writes preserve state.
- [ ] Run `bun test packages/server/lib/portable-transcript.test.ts packages/server/lib/portable-schema.test.ts packages/server/lib/portable-integration.test.ts packages/server/lib/portable-migration.test.ts`; confirm new behavior fails first.
- [ ] Implement schema dispatch, bounded validated history conversion and catalog accepted-projection tracking. Inject `replaceAccepted(id,guard,build)` into `PortableLibraryOptions` from the production notes service; trusted replacements invoke it so source persistence and notes invalidation share Task 2's boundary. Keep existing remote-conflict admission, leases, immutable artifacts and quota protection. Initial imports call `commitSource` with null guard only when their local alias does not exist. Pass the freshly captured guard for existing sources; source changes during awaits become conflict. Keep local catalog stamps out of published artifacts.
- [ ] Update metadata-only archival/audio restoration/migration writers to reread latest after awaits and use metadata-only save. No bulk artifact rewrite. Rerun the focused command plus `bun test packages/server/lib/portable-runtime.test.ts packages/server/lib/portable-preemption.test.ts`; require zero failures. Commit `feat: preserve transcript recovery across portable revisions`.

## Task 5: Client guarded writers and authoritative response merging

**Files:** Create `packages/client/src/api/transcript-editing.ts`, `packages/client/src/lib/acceptedSession.ts`, `acceptedSession.test.ts`, `packages/client/src/stores/transcript-version.test.ts`. Modify `stores/sessions.ts`, `lib/recordingSession.ts`, `components/recording/ResultCard.tsx`, `components/sessions/SessionDetail.tsx`. Extend `recordingSession.test.ts`, `ResultCard.names.test.tsx`, `SessionDetail.names.test.tsx` and `sessions.polling.test.ts`.

**Interfaces:** `transcriptEditingApi.preview(id,input,guard)`, `.command(id,command)`, `.stage(id,input)` and `.discard(id,candidateId,requestId)` return Task 3 response types. `guardForSession(session:Session):TranscriptGuard` consumes normalized server data and rejects missing hash. `mergeAcceptedSession(current:Session,incoming:Session):Session` retains newer source fields/version/history/candidates and known-stale derived state when incoming version is lower; merge tag/metadata ownership using existing generation checks. Equal-version candidate responses require request ordering, so an older stage response cannot resurrect a discarded candidate. Use per-meeting request sequence for candidate operations.

- [ ] Write response-race assertions: old polling/notes completion after correction cannot restore source; old stage response after discard cannot resurrect candidate; title/tag responses keep independently newer metadata; source version zero handles legacy record. Finalized ResultCard copy/display derives from saved Session, not stale recording store.
- [ ] Write saved rename/merge and reconciliation tests: exact displayed hash/version accompany mutation; concurrent edit fails with rollback; finalization uses each returned version; pending coordinator rename retains its old contract. Missing source cache causes refresh/blocked save, never an unguarded guess.
- [ ] Run `NODE_OPTIONS=--no-experimental-webstorage bun run --cwd packages/client test --run src/lib/acceptedSession.test.ts src/stores/transcript-version.test.ts src/lib/recordingSession.test.ts src/components/recording/ResultCard.names.test.tsx src/components/sessions/SessionDetail.names.test.tsx src/stores/sessions.polling.test.ts`; verify meaningful failures.
- [ ] Implement typed API and shared response merge; migrate all saved-source writer audit entries to source guards. Do not inject source guards into metadata-only title/tag/pin patches. Preserve all recording identity/readiness/finalSavePending behaviors.
- [ ] Rerun focused command and client typecheck (`bun run --cwd packages/client typecheck`); require zero failures. Commit `feat: protect accepted transcript state across client updates`.

## Task 6: Editing, replacement preview and recovery UI

**Files:** Create `components/sessions/TranscriptSegmentEditor.tsx`, `TranscriptReplaceDialog.tsx`, `TranscriptHistoryDialog.tsx`, `TranscriptEditing.module.css` and matching component tests. Create `lib/translations-transcript.ts`, `translations-transcript.test.ts`. Modify `SessionDetail.tsx`, `SpeakerView.tsx`, `SpeakerView.module.css`, `lib/i18n.ts`. Extend `SpeakerView.playback.test.tsx`, `SessionsPage.tags.test.tsx`; create `SessionDetail.editing.test.tsx` and `ActionMenu.transcript.test.tsx` to verify existing exports.

**Interfaces:** Editor props `{value:string;onSave:(text:string)=>Promise<void>;onCancel:()=>void;label:string}`. Replace dialog props `{session:Session;onClose:()=>void;onSaved:(session:Session)=>void}`. History dialog has the same props and uses command revert only for compatible active-generation edits. SpeakerView adds optional `onEditText:(index:number)=>void`; omission means no edit controls. SessionDetail owns draft/target and opening guards; child dialogs call typed APIs and return confirmed sessions to the store.

- [ ] Write accessible component tests: segment/document edit, empty text placeholder, failed save retains draft, conflict preserves draft with explicit Reload/Copy/Discard, refresh/IME composition/decomposed accents/multiline untouched, dirty-close confirmation and focus return. Live SpeakerView has no editor controls; edit/save/cancel/typing never trigger seek; text click/Enter still seeks original timestamp.
- [ ] Write replacement/history tests: option changes clear preview approval, count/before-after preview from server, explicit confirmation required, no-match/cancel no save, recovered legacy label truthful, incompatible revert shows recovery text. Literal search and existing text/Markdown export contain confirmed corrected source while notes keep stale status.
- [ ] Run `NODE_OPTIONS=--no-experimental-webstorage bun run --cwd packages/client test --run src/components/sessions/SessionDetail.editing.test.tsx src/components/sessions/TranscriptSegmentEditor.test.tsx src/components/sessions/TranscriptReplaceDialog.test.tsx src/components/sessions/TranscriptHistoryDialog.test.tsx src/components/speakers/SpeakerView.playback.test.tsx src/components/sessions/ActionMenu.transcript.test.tsx`; verify missing-behavior failures.
- [ ] Implement the UI and four-locale translation table using existing Dialog/i18n patterns. Put Edit buttons beside seek controls; no nested interactive elements. Render drafts/history as text, not HTML. Keep buffers until successful persistence or explicit discard.
- [ ] Add translation assertions for every new message in en/pt-BR/fr/de and keyboard/focus tests at narrow width. Rerun focused command, `NODE_OPTIONS=--no-experimental-webstorage bun run --cwd packages/client test --run src/lib/translations-transcript.test.ts src/components/sessions/SessionsPage.tags.test.tsx`, and typecheck. Require zero failures; commit `feat: add saved transcript editing and recovery controls`.

## Task 7: Candidate comparison and explicit retranscription replacement

**Files:** Modify `lib/sessionTranscription.ts`, `components/sessions/RetranscribeDialog.tsx`, `RetranscribeDialog.module.css`, `translations-transcript.ts`. Extend `SessionDetail.transcribe.test.tsx`; create `RetranscribeDialog.candidates.test.tsx`. Update `api/transcribe.test.ts` only where final-stream contract assertions change; retain existing preservation regressions.

**Interfaces:** Replace direct-save helper with `createRetranscriptionCandidate(session:Session,model:FinalTranscriptionModel,language:MeetingLanguage,handlers:Pick<TranscribeHandlers,'onStep'|'onProgress'>,stage:(id:string,input:CandidateInput)=>Promise<Session>):Promise<Session>`. It captures starting guards/request ID, validates complete final stream, applies existing speaker-name reconciliation/fallback rules and stages the result. Candidate acceptance/discard uses Task 5 API; it never calls generic transcript PATCH.

- [ ] Write client behavior tests: complete results stage but do not replace text; failed/partial stream keeps accepted source; reopen durable candidate; current/candidate comparison displays model/language/changed segment counts; explicit Replace/Discard; stale hash/version disables Replace; rename/discard race 409 retains accepted source; acceptance failure/quota error preserves candidate for retry.
- [ ] Run `NODE_OPTIONS=--no-experimental-webstorage bun run --cwd packages/client test --run src/components/sessions/RetranscribeDialog.candidates.test.tsx src/components/sessions/SessionDetail.transcribe.test.tsx src/api/transcribe.test.ts`; confirm new assertions fail.
- [ ] Implement the helper/dialog using all PR #91 diagnostics/attribution/expected-revision guarantees. New processing controls remain exclusive under existing recording state; candidate review itself does not pretend capture is processing. No-audio meetings retain editing/history but cannot start retranscription.
- [ ] Rerun focused command and typecheck; require zero failures. Commit `feat: require review before replacing accepted transcriptions`.

## Task 8: Integrated acceptance evidence and handoff

**Files:** Create `packages/server/lib/transcript-workflow.http.test.ts`, `docs/transcript-corrections.md`, `docs/qa/issue-7-transcript-corrections.md`. Change existing regression fixtures only for intentional mandatory-guard/provenance contracts; do not weaken old assertions.

**Interfaces:** No new product API. This task consumes all prior interfaces and publishes reproducible validation instructions/evidence separating automation, CI, runtime and physical acceptance.

- [ ] Write one real-HTTP workflow with two clients and synthetic EN/PT segments: correct a proper name, replace repeated terminology, rename speaker, revert safely, reload/restart, verify canonical search/export input and unchanged media digest, stage/discard/accept, then v2 roundtrip into a second local store. Inject failed atomic save and a held stale-generation job; assertions must prove no loss or false acknowledgment. Add a regression for unknown-provenance v1 notes and edit/revert ABA.
- [ ] Run `bun test packages/server/lib/transcript-workflow.http.test.ts`; require zero failures. The integrated workflow may begin green because prior tasks implemented its behavior. Use injected failing writers/held generators to prove its negative cases; do not manufacture temporary product faults merely to obtain another red result.
- [ ] Run consolidated `bun test packages/server/lib`, `NODE_OPTIONS=--no-experimental-webstorage bun run --cwd packages/client test --run`, `bun run --cwd packages/client typecheck`, `bun run build`, and `git diff --check`. Require zero failures for modified areas; investigate failures before handoff. Record any independently reproduced inherited compiler warning rather than claiming a global server typecheck pass that CI does not require.
- [ ] Inspect production UI with only owned worktree services and synthetic data: desktop/narrow views, keyboard/IME, seek/edit separation, four locales, refresh/conflict and candidate recovery. Stop and verify all owned services after use. Record the spec's physical acceptance on MacBook Air M1 and MacBook Pro M4 Pro/macOS 27.0.1: EN/PT editing, preview/revert, refresh/restart, seek and candidate workflows with available/unavailable audio across the four locales. Document macOS 14+ compatibility separately without inventing an all-version physical test gate. Missing required physical evidence remains explicitly pending.
- [ ] Document user workflow, empty content, literal matching rules, legacy original/unknown provenance, conflicts/retries, quota/history/candidate limits and portable compatibility. Record exact commands/results and any remaining acceptance gaps. Commit `test: verify recoverable transcript correction workflow`.
- [ ] Obtain whole-branch independent review and resolve blockers. Once applicable criteria and CI pass, carry out the authorized push/merge with AGENTS.md cleanup: audit every repository change/outgoing commit, push all intended repository work, verify fetched remote equality, stop owned services and safely remove the clean issue worktree from outside it; verify service/worktree absence, then merge and report the PR link/evidence. Do not mark the issue complete while required acceptance remains unfinished.

## Plan self-review and coverage

All approved spec sections map to Tasks 1–8: canonical/recoverable source (1–2, 6), source guards and atomic quota persistence (2–3, 5), literal preview (1, 3, 6), staged/explicit retranscription (3, 7), derived truthfulness (2, 4, 8), versioned portability (4), bounds (1–4), accessibility/locales (6–7), and integrated/physical evidence (8). The writer audit accounts for initial/recovery, compatibility finalization, saved speaker edits, direct retranscription, portable replacement and metadata-only paths. No unresolved product choice is required to execute this plan after review; named interfaces above are the implementation contract.

This document does not report any implementation/test result. Agent execution is selected; written-plan review is the next gate.
