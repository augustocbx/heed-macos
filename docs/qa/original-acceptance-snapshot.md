# Original acceptance review snapshot

This is the pre-merge checklist snapshot for consolidated issue #62, with every original acceptance bullet reviewed. Checked items retain their issue state; an unchecked item is not promoted by a narrower code, model, source-only or installation check. The six roadmap milestones in #18 are listed separately. See [the evidence report](remaining-acceptance.md) and the linked issues for fresh post-merge checklist updates.

The snapshot contains **85 checked and 43 unchecked original criteria** (128 total), plus six unchecked provider milestones. Google Drive/OneDrive planning closures remain distinct from acceptance.

## Provider milestones

| Issue | Milestone | Snapshot |
|---|---|---|
| [#18](https://github.com/augustocbx/heed-macos/issues/18) | #25 — Connect SMB/Samba shared folders: the first provider milestone. | Pending |
| [#18](https://github.com/augustocbx/heed-macos/issues/18) | #26 — Shared portable storage, local AI-ready transcripts and quota-aware import. | Pending |
| [#18](https://github.com/augustocbx/heed-macos/issues/18) | #27 — Configurable managed local meeting-data limit, default 2 GB at installation. | Pending |
| [#18](https://github.com/augustocbx/heed-macos/issues/18) | #28 — Google Drive API connector. | Pending |
| [#18](https://github.com/augustocbx/heed-macos/issues/18) | #29 — Microsoft Graph/OneDrive connector. | Pending |
| [#18](https://github.com/augustocbx/heed-macos/issues/18) | #30 — User-selected iCloud Drive folder with native capability/status validation. | Pending |

## [#4: Make recording and finalization independent of browser-tab ownership](https://github.com/augustocbx/heed-macos/issues/4)

Issue state: open. Remaining gate: Physical menu/tab lifecycle and update guards on both Macs; the Air reinstall is an intermediate-head readiness check.

| Criterion | Requirement | Snapshot |
|---|---|---|
| 1 | A menu-started recording continues with no UI tab and can be stopped/finalized once through the menu. | Pending |
| 2 | Opening/reloading multiple tabs attaches to the active meeting and its real elapsed/recorded duration. | Pending |
| 3 | Start/stop commands are idempotent, have explicit success/failure acknowledgments and cannot create duplicate capture processes. | Checked |
| 4 | Recording indication reflects actual capture, while finalization has a separate visible status. | Pending |
| 5 | A durable recovery manifest covers crashes between capture stop, final ASR, metadata save and cleanup. | Checked |
| 6 | App quit/restart and installation/update guards recognize active recording and finalization. | Pending |
| 7 | Localhost origin checks remain enforced; backend ownership does not introduce a publicly reachable control endpoint. | Checked |
| 8 | Recovery preserves retained audio and manual speaker names and never reports a saved meeting before durable persistence succeeds. | Checked |

## [#14: Automatically detect meeting start and end in Zoom, Teams and Google Meet on macOS](https://github.com/augustocbx/heed-macos/issues/14)

Issue state: open. Remaining gate: Actual supported conferencing-app join/end, permissions, sleep/reconnect and automatic capture on both Macs.

| Criterion | Requirement | Snapshot |
|---|---|---|
| 1 | Publish a per-app/browser capability matrix, required permissions and known limitations. | Checked |
| 2 | Detect actual join and actual leave/end using validated signals; app launch alone never starts capture. | Pending |
| 3 | Start one recording after permissions/source readiness succeed, with English live preview and existing final language handling. | Pending |
| 4 | End detection stops capture and triggers exactly one finalization; reconnect grace behavior is documented and visible. | Pending |
| 5 | Switching rooms, rejoining, overlapping calls and a call restarting shortly afterward have deterministic ownership behavior. | Checked |
| 6 | Users can override automation; failures display actionable status instead of silently appearing enabled. | Checked |
| 7 | Paused/manual-stop behavior is respected and the same active call does not immediately restart recording. | Checked |
| 8 | Denied access or changed app formats disable that detector clearly without blocking other supported apps. | Pending |

## [#15: Generate suggested to-do items from meetings and let users selectively add them to the system](https://github.com/augustocbx/heed-macos/issues/15)

Issue state: open. Remaining gate: Full applicable device retake of task filters and task-origin source/audio navigation; representative M1 checks passed.

| Criterion | Requirement | Snapshot |
|---|---|---|
| 1 | Each suggestion cites the transcript segment(s) supporting the action and distinguishes explicit commitments from inferred suggestions. | Checked |
| 2 | Users can select any subset, edit before accepting, reject suggestions, and intentionally accept none. | Checked |
| 3 | Adding selected items creates only those items; repeated clicks/retries cannot create duplicates. | Checked |
| 4 | A task supports title/description, status, source meeting, stable ID, optional assignee and nullable due/completion-target date. | Checked |
| 5 | Users can add, change or clear a date; no-date tasks remain visible and are not treated as overdue. | Checked |
| 6 | Dates explicitly mentioned in speech can be proposed with evidence; ambiguous phrases prompt review rather than inventing a date. | Checked |
| 7 | Completion can be marked/unmarked with a recorded actual completion time distinct from the optional target date. | Checked |
| 8 | Tasks can be edited and deleted independently; meeting retranscription/notes regeneration does not silently change accepted tasks. | Checked |
| 9 | The to-do view filters open/completed and dated/undated tasks and links back to source audio/transcript when available. | Pending |
| 10 | Meeting deletion/audio expiration has an explicit policy preserving accepted tasks and accurately marking unavailable sources. | Checked |
| 11 | Accepted tasks are durable, local, and never sent elsewhere automatically. | Checked |

## [#16: Add a local chat for questions about meetings with cited transcript evidence](https://github.com/augustocbx/heed-macos/issues/16)

Issue state: open. Remaining gate: Physical citation/audio navigation and capture/final-ASR scheduling; bilingual semantics passed on both actual models.

| Criterion | Requirement | Snapshot |
|---|---|---|
| 1 | Users can ask follow-up questions, cancel generation, clear history, retry failures and select an installed compatible model. | Checked |
| 2 | Factual answers cite meeting/segment evidence; missing evidence produces an explicit “not found in this meeting” response. | Pending |
| 3 | Citation links open the correct meeting/segment and seek within available audio; text-only sources remain navigable. | Pending |
| 4 | Chat handles English and Portuguese questions/content, independently of UI language. | Pending |
| 5 | Transcript edits/retranscription update retrieval indexes and mark answers based on older revisions as stale. | Checked |
| 6 | Imported transcripts are treated as data; instructions inside them cannot trigger tools, send messages, alter recordings or override application rules. | Checked |
| 7 | Context truncation/retrieval limitations are surfaced; long recordings must not be silently answered from only their first paragraphs. | Checked |
| 8 | Chat does not invent decisions, speakers, deadlines or external information as though stated in the meeting. | Pending |
| 9 | Chat/history/indexes remain local by default; resource scheduling prioritizes recording and final ASR on both Macs. | Pending |
| 10 | Multi-meeting mode, if implemented, identifies its selected scope and source meeting for every citation. | Checked |

## [#17: Add a general meeting chat scoped to one or more selected labels](https://github.com/augustocbx/heed-macos/issues/17)

Issue state: open. Remaining gate: Physical scoped citation/audio navigation and resource scheduling; contradiction/missing-fact semantics passed on both models.

| Criterion | Requirement | Snapshot |
|---|---|---|
| 1 | A user can select one or several labels, ask follow-up questions and change the scope without editing meetings. | Checked |
| 2 | Selecting Entrevistas excludes every unlabelled/nonmatching meeting even when its text would be a closer semantic match. | Checked |
| 3 | Any/all semantics are visible and produce the expected included meeting set. | Checked |
| 4 | Zero matching meetings produces a clear message; it never silently falls back to the full library. | Checked |
| 5 | No selection requires choosing a scope explicitly or remains unready; it is not mistaken for label-filtered access. | Checked |
| 6 | Answers cite the correct meeting and segment; clicking a citation opens that source and seeks audio where available. | Pending |
| 7 | Facts absent from the eligible set are reported as unsupported; contradictory statements cite both sources without inventing a resolution. | Pending |
| 8 | Scope changes prevent previous broader-scope chat turns from leaking excluded facts into new answers; begin a separate context or strictly re-ground history. | Checked |
| 9 | Label edits/deletion, meeting deletion and retranscription invalidate affected indexes/snapshots and mark old answers as historical. | Checked |
| 10 | Label filtering is enforced consistently in retrieval, cache keys, summaries, conversation memory and generation. | Checked |
| 11 | English/Portuguese cross-meeting questions work locally with resource-aware scheduling; model and source limitations remain visible. | Pending |

## [#18: Synchronization roadmap: local AI-ready storage and Samba-first provider delivery](https://github.com/augustocbx/heed-macos/issues/18)

Issue state: open. Remaining gate: Actual writable provider round trips/deletion; signed legacy read-only import is a separate narrow pass. Deferred cloud milestones stay open.

| Criterion | Requirement | Snapshot |
|---|---|---|
| 7 | All six child issues implement one documented schema/identity/quota contract, with legacy path/ID migration. | Checked |
| 8 | Imported transcripts remain searchable and usable by local meeting/label-scoped AI when the provider is offline. | Pending |
| 9 | Connect/reconnect/import is resumable and idempotent; incomplete/corrupt bundles never enter AI sources. | Checked |
| 10 | Quota accounts for temporary and derived working data, protects pending/active work and has no contradictory hidden fixed audio-only limit. | Checked |
| 11 | Two Macs preserve labels, speaker names, corrections, notes and model/language metadata across round trips. | Pending |
| 12 | Cache cleanup, disconnect and explicit remote delete are independent operations. | Pending |
| 13 | Provider outage, missing mounts and partial listings never imply deletion. | Checked |
| 14 | Each provider reports supported account types/capabilities and actual confirmation guarantees. | Checked |
| 15 | Settings/preferences/credentials remain device-local and are not overwritten from a remote library. | Checked |

## [#25: Connect SMB/Samba shared folders as the first meeting synchronization provider](https://github.com/augustocbx/heed-macos/issues/25)

Issue state: open. Remaining gate: Mounted NAS v2 exclusive atomic operations are unsupported; actual writable publication, visible connection flow and fault recovery remain open.

| Criterion | Requirement | Snapshot |
|---|---|---|
| 1 | A user can connect, test, rename, temporarily disable and disconnect a mounted share without changing recording settings. | Pending |
| 2 | Authentication, read/write capability and destination identity are checked; read-only libraries may be imported but cannot appear upload-capable. | Pending |
| 3 | Losing a mount never creates an ordinary local directory at the old mount path or writes queued data there. | Checked |
| 4 | First connection imports eligible transcripts/metadata within the local quota and makes committed imports searchable/chat-ready offline. | Pending |
| 5 | No existing media is bulk-downloaded during discovery; quota reservation covers partial downloads and import/index staging. | Checked |
| 6 | Committed local changes publish durably to the share; acknowledge only after all required remote objects can be read and hashes verified. | Pending |
| 7 | Define the server-side durability boundary honestly; client read-back does not prove survival of server power loss. | Checked |
| 8 | Disconnection, sleep/wake, permission changes, partial writes and server unavailability retain a bounded retryable queue without blocking ordinary local use. | Pending |
| 9 | Conflicts retain both revisions; clock skew and last-modified timestamps never silently decide the winner. | Checked |
| 10 | Evicting local cached audio or disconnecting the share never deletes remote meetings. | Checked |
| 11 | Verify path containment, reject unsupported schema/corrupt data and symlink/path-traversal imports. | Checked |
| 12 | Surface transport/security capabilities and required access; no silent downgrade or credential-bearing debug output. | Pending |

## [#26: Define portable meeting storage, local AI-ready transcripts and quota-aware remote import](https://github.com/augustocbx/heed-macos/issues/26)

Issue state: open. Remaining gate: Final writable/provider round-trip acceptance; preserve local committed imports and quota reservations.

| Criterion | Requirement | Snapshot |
|---|---|---|
| 1 | Document and validate schema, identity migration, relative paths, hashes and revision/conflict semantics. | Checked |
| 2 | Import is idempotent and resumable across crash/restart without partial meetings appearing in AI/search. | Checked |
| 3 | A source library larger than the quota imports only eligible text that fits and reports imported/skipped/pending counts. | Checked |
| 4 | Remote-only meetings are visibly excluded from local AI until their transcripts are imported. | Checked |
| 5 | Labels, speaker names, model/language metadata and transcript corrections survive round trips between Macs. | Pending |
| 6 | Text/metadata/index/transfer reservations and pending audio participate in quota accounting by counting each managed physical file once; distinct staged copies count separately. | Checked |
| 7 | Remote playback downloads only requested audio and accurately reports quota-blocked/unavailable sources. | Checked |
| 8 | Native/live databases, credentials and absolute device paths are never synchronized. | Checked |
| 9 | Define integrity versus encryption separately, transport requirements per provider and any optional client-side encryption/key lifecycle. | Checked |
| 10 | A provider-folder local write is not reported as confirmed remote publication. | Checked |
| 11 | Failed import/upload/migration retains recoverable state without unbounded temporary files or data loss. | Checked |

## [#27: Make the local meeting storage limit configurable in Settings with a 2 GB installation default](https://github.com/augustocbx/heed-macos/issues/27)

Issue state: open. Remaining gate: Actual fresh/upgrade persisted quota, menu/multiple-tab propagation and capture under quota pressure on both Macs.

| Criterion | Requirement | Snapshot |
|---|---|---|
| 1 | Fresh install and config without the field use 2,000,000,000 bytes; upgrade/reinstall preserves an existing valid user choice. | Pending |
| 2 | Settings reads/writes the authoritative persisted value and updates status across open tabs/menu without requiring manual file editing. | Pending |
| 3 | Invalid/zero/negative/nonfinite/overflow values are rejected; the documented supported range uses safe integer-byte accounting. | Checked |
| 4 | Every recording, retention, import, retranscription, lazy-audio fetch and sync-stage path uses the same quota/reservation service. | Checked |
| 5 | New work reserves enough space for temporary/derived files; active recording finalizes gracefully before exceeding available working space. | Pending |
| 6 | Concurrent downloads/recording cannot each consume the same unreserved allowance. | Checked |
| 7 | Lowering the limit requires review of destructive local-media cleanup and never removes remote copies. | Checked |
| 8 | Existing transcripts remain searchable/AI-ready after media eviction; additional transcript import pauses when no budget remains. | Checked |
| 9 | Pending uploads stay protected until the provider's defined acknowledgment/verification condition is met. | Checked |
| 10 | User-facing messages include the actual configured value instead of hardcoded “2 GB limit.” | Checked |
| 11 | Reset restores the default only after appropriate change validation. | Checked |
| 12 | Four locales use consistent units, accessible form controls and clear quota-blocked explanations. | Checked |

## [#28: Synchronize portable meeting libraries with Google Drive](https://github.com/augustocbx/heed-macos/issues/28)

Issue state: closed. Remaining gate: Owner planning closure: public OAuth application ID, deliberate enablement and real-account QA deferred to #56; connection fixed off.

| Criterion | Requirement | Snapshot |
|---|---|---|
| 1 | Connect, revoke/disconnect, reconnect and switch explicitly chosen library folders without losing local transcripts. | Pending |
| 2 | Demonstrate supported personal/organization/shared-folder scenarios under the documented scope and permissions. | Pending |
| 3 | Initial import discovers manifests with pagination and respects the managed local quota (default 2 GB) without bulk media downloads. | Checked |
| 4 | Incremental discovery uses persisted changes checkpoints advanced only after all pages are processed safely; invalid/expired checkpoints trigger a bounded reconciliation. | Checked |
| 5 | Uploads are resumable; preserve session/job state across restart and recover cleanly when sessions expire. | Checked |
| 6 | Distinguish provider acknowledgment from integrity verification; unsupported provider hash algorithms do not get mislabeled as verified SHA-256. | Checked |
| 7 | Existing provider revisions are not the only history mechanism; immutable Heed revisions preserve conflicts independently of Drive retention. | Checked |
| 8 | Shared edits from both Macs retain both revision branches instead of overwriting a shared latest pointer. | Pending |
| 9 | Repeated retries/imports are idempotent and neither duplicate meetings nor create uncontrolled orphan objects. | Checked |
| 10 | Authorization expiry, quota errors, rate limits, account restrictions and network failure leave pending local copies protected. | Pending |
| 11 | Cache eviction never deletes a Drive object; explicit remote deletion follows the separate tombstone policy. | Pending |
| 12 | Show local managed usage separately from Drive capacity and any Drive for desktop cache usage. | Pending |

## [#29: Synchronize portable meeting libraries with Microsoft OneDrive](https://github.com/augustocbx/heed-macos/issues/29)

Issue state: closed. Remaining gate: Owner planning closure: public OAuth application ID, deliberate enablement and real-account QA deferred to #56; connection fixed off.

| Criterion | Requirement | Snapshot |
|---|---|---|
| 1 | Users can connect/disconnect, select an eligible library and reauthorize without losing local meetings. | Pending |
| 2 | Initial discovery/import is paginated, validates manifests and imports only text that fits the configured managed quota. | Checked |
| 3 | Incremental discovery processes delta responses safely, handles repeated entries and has a bounded full-rescan path for invalid checkpoints. | Checked |
| 4 | Persist durable checkpoints only after local processing succeeds; a partial response is not evidence that absent meetings were deleted. | Checked |
| 5 | Resumable upload sessions respect documented fragment ordering/size and expiry; restarts retry without duplicate publication. | Checked |
| 6 | Use conditional updates where mutable provider bookkeeping is unavoidable; an ETag mismatch is a conflict, not permission to overwrite. | Checked |
| 7 | Provider completion and hash verification have separate states; fallback verification is explicit when a common hash is unavailable. | Checked |
| 8 | Publish independent immutable commit markers and preserve divergent changes from both Macs. | Pending |
| 9 | Offline/account/network/rate-limit failures retain pending copies and obey reservation limits. | Pending |
| 10 | Cache eviction stays in Heed's private cache and does not delete synchronized OneDrive files everywhere. | Checked |
| 11 | Show local quota, remote capacity and provider-controlled residency as separate concepts. | Checked |
| 12 | Disconnect stops future jobs and removes/revokes credentials under a documented policy; local transcripts remain usable. | Pending |

## [#30: Synchronize portable meeting libraries through a user-selected iCloud Drive folder](https://github.com/augustocbx/heed-macos/issues/30)

Issue state: open. Remaining gate: Selected native folder/bookmark permissions, actual account replication and two-Mac conflict/offline recovery.

| Criterion | Requirement | Snapshot |
|---|---|---|
| 1 | Document supported public APIs, folder authorization, OS availability and signing/entitlement/distribution requirements. | Checked |
| 2 | Account signed-out, iCloud disabled, unavailable folders and missing permissions produce actionable connection states. | Pending |
| 3 | Import validates complete committed revisions and copies eligible transcripts locally before AI/search indexes expose them. | Checked |
| 4 | Placeholder hydration, staging and private copies have distinct accounting; explain that OS/iCloud caches outside Heed are not governed by its 2 GB quota. | Checked |
| 5 | Observe status asynchronously without deadlocking coordinated reads; handle pending upload, cloud-full and ineligible/error states. | Checked |
| 6 | Uploaded-state and integrity conditions are explicitly tested; do not claim remote confirmation from an ordinary local read-back. | Checked |
| 7 | Two-Mac concurrent edits preserve branches/commit markers; partial bundles are never visible as complete meetings. | Pending |
| 8 | Local media eviction only touches Heed-managed copies. Never delete an iCloud library file to reclaim private cache space. | Checked |
| 9 | Restart, sleep/wake, temporary offline state and sign-out preserve recoverable jobs without unlimited storage growth. | Pending |
| 10 | When protected pending files fill the quota, pause optional jobs and show options rather than discarding data. | Checked |
| 11 | Disconnect removes future synchronization access under a documented policy while retaining imported local transcripts. | Checked |
| 12 | No private account connection or production iCloud capability is enabled by this research issue. | Checked |
