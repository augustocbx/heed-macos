# Issue #7: recoverable transcript corrections

This specification follows approval of the conversational design for [issue #7](https://github.com/augustocbx/heed-macos/issues/7). It describes the product and architectural contract; implementation planning requires review of this written specification. The reviewed base is `f13c3da5493d14709e1bfe0131018288a806296d`, including merged microphone-preservation and AI-scheduling changes from PRs #91 and #89.

## Outcome and boundaries

Users can correct saved meeting text, preview literal find/replace, recover recognized text and accepted edits, and review a new transcription before explicitly replacing their accepted source. Text corrections preserve the audio, segment timing, speaker identity and microphone/system attribution. English, Brazilian Portuguese, French and German interface translations remain supported.

This feature operates on finalized saved meetings, including untimed transcripts and meetings without available audio. Live capture remains unchanged. It introduces no ASR engine, vocabulary assistance, cloud publication, sharing, PDF export or secure-erasure guarantee. Existing quota and portable synchronization policies remain authoritative.

## Accepted source and recovery

`Session.transcript` and `Session.segments[].text` remain the current effective source. Segmented meetings regenerate the transcript from accepted segment text using a single canonical renderer. Untimed meetings edit a whole-text document without creating artificial timestamps. Display, literal library search, notes/chat/task inputs and existing text/Markdown exports use this same source.

Store recoverable state within the existing atomic session record:

- An immutable recognition generation records original text, timed segments, speaker labels, language, model and duration. Preserve segment `channel`, `overlap`, `auto` and `attribution`, plus sanitized transcription diagnostics where available. Do not duplicate audio or voice embeddings in history.
- A compact accepted edit journal records action ID, generation ID, before/after text, target, timestamp and source hashes. Save one journal action per confirmed operation, not per keystroke.
- For legacy meetings, capture the existing source lazily before the first correction. Describe it as the source preserved when editing was enabled; do not claim knowledge of older recognizer results.

Single-segment editing accepts a segment index and replacement text only. The server copies every nontext field unchanged. A guarded index addresses one accepted generation and topology; it cannot be reused after retranscription. Empty segments and an intentionally empty whole transcript are permitted. Keep timing and show an empty-text placeholder; derived features explain when usable text is absent.

Revert creates another accepted journal action. It changes only the affected text when the current targets still match that action's recorded result and generation. Later speaker renames and unrelated edits survive. If another text action changed the same targets, show a conflict and keep the original text available for recovery. Older recognition generations remain readable after retranscription; recovering their text never silently restores old speaker assignments or timing.

## Concurrency and atomic persistence

Keep `transcriptRevision` as the existing source-content hash for evidence and derived-source comparisons. Add a server-owned, device-local `transcriptVersion`, initialized to zero for legacy records and incremented on each accepted source mutation, including speaker rename/merge and retranscription replacement. Reverting to identical content may restore its hash; the monotonic version prevents an old command from succeeding after that intervening change.

Every untrusted source-changing operation requires both `expectedTranscriptRevision` and `expectedTranscriptVersion`. The server reads the latest record and validates the guards synchronously before constructing and atomically persisting accepted text, history, version and provenance. Missing guards are invalid input; stale guards return HTTP 409 with an actionable conflict. Metadata-only changes, such as title, tags and pin state, remain independent and are preserved.

Generic patches cannot set source hashes, local versions, history or candidates directly. Trusted initial finalization creates a source once; trusted recovery and portable import/conflict replacement use the same accepted-source invariants and preserve recoverable current text. Audit existing source writers rather than guarding only the new editor.

Request IDs make retries idempotent. The same request and contents return the confirmed outcome; reuse with different contents is rejected. Retain receipts with accepted journal actions and bound candidate/discard receipts. UI success follows persistence confirmation. Save/quota failure preserves the previous accepted source and the user's draft. Late polling or notes responses cannot overwrite a newer transcriptVersion in the client store.

## Literal find/replace

Find/replace offers case-sensitive and whole-word options, before/after previews, affected-target and match counts, and explicit confirmation. The query is literal text, not a user regular expression. It must be nonempty; replacement may be empty. Matches remain within a segment or the untimed document. No-match and unchanged-result operations are no-ops.

Whole-word boundaries treat Unicode letters, numbers, combining marks and underscore as word characters. Case-insensitive matching preserves offsets in the original text. Accents remain meaningful; matching uses exact code points rather than silently normalizing stored text. Preserve entered Unicode and multiline text, normalize CRLF to LF, reject NUL/invalid scalar input, and render content as plain text.

A preview key binds source guards, options and computed changes. Confirmation recomputes the preview against the latest source; changed text or options invalidate it. Draft text and previews do not mutate the accepted source. Cancel discards the draft only through the user's explicit action.

## Retranscription candidates

Preserve the current complete-stream validation, manual speaker-name reconciliation, fallback-attribution exclusions, sanitized diagnostics and expected-revision protection introduced by PR #91. Change the final save step into candidate staging.

A successful complete final transcription becomes a durable, device-local candidate tied to its starting accepted hash/version. Store the finalized fields needed for later acceptance, including new embeddings in candidate state if returned, without duplicating embeddings into recovery history or portable records. Failed or incomplete streams do not replace the accepted source.

The dialog shows accepted text and candidate text, model/language and changed-text/segment counts. **Replace accepted transcript** explicitly accepts the candidate; Discard leaves corrections untouched. Candidate staging/discard does not change accepted transcriptVersion/hash or supersede derived work. If another tab changed text or speakers during processing, retain the candidate as stale for inspection and disable replacement; another run is required. Do not reinterpret the earlier approval against fresh source.

Acceptance validates the current guards, candidate identity and original base guards, then atomically retains the old generation/corrections and installs the new accepted generation. Update canonical text, model/language, duration, embeddings and diagnostics consistently while preserving manual names through existing reconciliation. Audio bytes and paths remain unchanged. After interruption, users can reopen a saved candidate; it cannot become accepted automatically.

## Derived content and portable compatibility

Reuse the existing source revision contracts for notes, individual/library chat, citation extraction and tasks. Accepted text changes mark earlier notes stale, supersede obsolete jobs and block old generated output from committing as current. Conversations and accepted tasks retain their original evidence revision and show source-change status. Corrections never rewrite old notes, task text or chat answers. Literal search updates immediately; regenerated results use the new source. Preserve the scheduler's pending-chat admission and waiting-reason behavior from PR #89.

Extend portable meeting payloads with a compatible versioned history/provenance format. The new reader accepts v1 and v2; corrected records use v2 to carry accepted generations/journal and notes source provenance. Candidates, request receipts, local transcriptVersion counters, personal paths, embeddings and device-local diagnostics are excluded. A receiving device recomputes the source hash and initializes/increments its own local version.

Keep immutable v1 artifact bytes and schema-specific integrity comparisons unchanged. Adding a v2 reader must not make unmodified v1 catalog entries appear locally edited. Unsupported v2 artifacts are rejected before changing local sessions. Import/conflict resolution cannot bypass correction-preservation and source-mutation guards. Existing edited local records continue to use explicit synchronization conflict handling, not silent replacement.

Legacy notes without provenance have an unknown source. Display that honestly; neither read-time normalization nor import may relabel them as verified against the current corrected transcript. Regeneration creates known provenance. No bulk migration, automatic publication or rewrite of unrelated meetings is required.

## Bounds and UI responsibilities

Use the existing managed quota for atomic writes and retained candidates. Bound accepted serialized portable content, including recovery history, to the existing 16,000,000-byte artifact limit. Allow at most two pending candidates per meeting, each with at most 16,000,000 serialized bytes; replacing a pending candidate requires explicit discard. Bound each submitted text command to 1,000,000 UTF-8 bytes and 1,000 affected targets. Validate bounds and reserve the complete atomic-write budget before committing. Reject exhausted limits with a recoverable error; never silently prune original recognition or accepted history. Discarding a candidate does not discard accepted source/history.

Saved segment editing controls are opt-in additions to `SpeakerView`, which also serves live capture. Place Edit controls beside seek controls rather than nesting buttons. Editing, typing, Save and Cancel must not seek audio. `SessionDetail` owns draft/conflict/history dialogs and untimed editing; it retains drafts across store refreshes and asks before discarding unsaved text. `RetranscribeDialog` owns candidate comparison and explicit acceptance. All new controls support keyboard navigation, accessible status/error messages, focus return and the four locales.

Shared types define guards, text targets/actions, recognition generations, journal entries and candidates. A focused server transcript service owns validation/transforms and accepted-source coordination; protected loopback HTTP handlers expose preview, command and candidate operations. Integrate through the existing atomic session writer and notes invalidation mechanisms. The implementation plan will specify concrete function signatures and routing after this spec is reviewed.

## Acceptance and evidence

| Acceptance requirement | Required evidence |
|---|---|
| Atomic persistence; consistent display/search/export | Real HTTP edit/reload/restart; canonical source equality across readers; injected disk/quota failure preserves one complete accepted state and draft. |
| Playback and identity unchanged | Text transform preserves every nontext segment field, diagnostics and embeddings; edited segments seek the same start; editing controls never seek; audio digest unchanged. |
| Original recoverable; revert | Legacy baseline and multiple edits survive restart; safe revert preserves later rename/unrelated edits; conflicting revert keeps recovery text; old corrected generation survives candidate acceptance. |
| Previewed find/replace options | Literal metacharacters, Unicode whole-word/case boundaries, accents, multiline, empty replacement, no matches, preview mismatch and explicit apply/cancel. |
| Safe Unicode/input behavior | EN/PT content plus FR/DE accents, decomposed marks and emoji persist unchanged; HTML-looking content stays literal; invalid/bounded input fails before mutation. |
| Concurrent writers cannot overwrite source | Two-tab edit/rename/retranscription races, edit-and-revert hash reuse, missing guards, duplicate requests and late polling/notes responses; unrelated metadata survives. |
| Honest failure and empty states | Empty/all-empty accepted text is defined; failures retain unsaved drafts and old source; failed retry cannot duplicate an action. |
| Derived source provenance remains truthful | Edit during running notes/chat/tasks; old output cannot commit as current; old evidence stays labeled stale; unknown legacy notes remain unknown; scheduler admission remains intact. |
| Retranscription preserves corrections | Failed stream, durable candidate reload, discard, stale candidate after rename and explicit replacement; preserved attribution/diagnostics and speaker names. |
| Compatible portable recovery | v1 read/integrity unchanged; v2 history/provenance roundtrip; unsupported schemas reject safely; remote conflict preserves edited source; local versions/candidates never cross devices. |
| Bounded durable state | Command/history/candidate caps and quota-pressure failures preserve accepted originals; no silent pruning or automatic candidate replacement. |

Automated evidence covers pure transforms, actual HTTP/storage failures, client state races and compatibility fixtures. Physical acceptance remains separate: repeat English/PT editing, preview/revert, refresh/restart, seek and candidate workflows on MacBook Air M1 and MacBook Pro M4 Pro with macOS 27.0.1, across the four locales and available/unavailable audio. Document supported macOS 14+ compatibility separately. Use synthetic/licensed public fixtures; keep private recordings, transcripts and logs outside the repository.
