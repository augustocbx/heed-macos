# Synchronization remaining-work TODO

Source: [roadmap #18](https://github.com/augustocbx/heed-macos/issues/18), its four active provider/foundation issues (#25, #26, #27 and #30). Active scope updated October 6, 2026 against merged main `880a0bf6f17128e5bff57854cc4a7337e338d29d` at the owner's request.

This ledger preserves the original acceptance requirements. An unchecked criterion means acceptance is incomplete; it does not mean its implementation is absent. Code, automated checks, installed runtime, actual models and external-device/provider acceptance must be recorded separately.

## Delivery order

- [x] Correct the SMB documentation for v2 destinations, explicit confirmed metadata deletion, retained shared audio and unsupported mounted-filesystem capabilities. See [SMB synchronization](../smb-synchronization.md); this documentation correction does not complete mounted-provider acceptance.
- [ ] Complete the local quota acceptance slice (#27): installation/update persistence, authoritative Settings/tab/menu status, and bounded recording/finalization under quota pressure. Use isolated disposable data before physical retakes.
- [ ] Complete offline imported-transcript AI acceptance (#18 criterion 2 / #25 criterion 4), including actual cited answers from fully imported English/Portuguese transcripts with the provider unavailable.
- [ ] Resolve the macOS mounted SMB write blocker before claiming writable publication, remote deletion or between-Mac round trips. An alternative SMB server is not a proven workaround: the mounted client interface lacks the required exclusive rename capability. Implement the owner-selected direct public SMB3 transport with protected Keychain credentials under a reviewed design; keep unsupported v2 operations refused in the meantime.
- [ ] Complete mounted SMB UI/access/fault acceptance (#25), then actual metadata round trips (#26 / #18).
- [ ] Complete explicitly selected iCloud folder/bookmark/account and independent-device replication/fault acceptance (#30).
- [ ] Complete the applicable English/Portuguese, four-interface-locale and two-Mac matrix. Record macOS 14 interoperability separately from compilation.

## Active acceptance checklist

### [#18: Synchronization roadmap: local AI-ready storage and Samba-first provider delivery](https://github.com/augustocbx/heed-macos/issues/18)

Current state: open; 7/9 original acceptance criteria addressed.

- [ ] **#18 criterion 2:** Imported transcripts remain searchable and usable by local meeting/label-scoped AI when the provider is offline.
- [ ] **#18 criterion 5:** Two Macs preserve labels, speaker names, corrections, notes and model/language metadata across round trips.

### [#25: Connect SMB/Samba shared folders as the first meeting synchronization provider](https://github.com/augustocbx/heed-macos/issues/25)

Current state: open; 6/12 original acceptance criteria addressed.

- [ ] **#25 criterion 1:** A user can connect, test, rename, temporarily disable and disconnect a mounted share without changing recording settings.
- [ ] **#25 criterion 2:** Authentication, read/write capability and destination identity are checked; read-only libraries may be imported but cannot appear upload-capable.
- [ ] **#25 criterion 4:** First connection imports eligible transcripts/metadata within the local quota and makes committed imports searchable/chat-ready offline.
- [ ] **#25 criterion 6:** Committed local changes publish durably to the share; acknowledge only after all required remote objects can be read and hashes verified.
- [ ] **#25 criterion 8:** Disconnection, sleep/wake, permission changes, partial writes and server unavailability retain a bounded retryable queue without blocking ordinary local use.
- [ ] **#25 criterion 12:** Surface transport/security capabilities and required access; no silent downgrade or credential-bearing debug output.

### [#26: Define portable meeting storage, local AI-ready transcripts and quota-aware remote import](https://github.com/augustocbx/heed-macos/issues/26)

Current state: open; 10/11 original acceptance criteria addressed.

- [ ] **#26 criterion 5:** Labels, speaker names, model/language metadata and transcript corrections survive round trips between Macs.

### [#27: Make the local meeting storage limit configurable in Settings with a 2 GB installation default](https://github.com/augustocbx/heed-macos/issues/27)

Current state: open; 9/12 original acceptance criteria addressed.

- [ ] **#27 criterion 1:** Fresh install and config without the field use 2,000,000,000 bytes; upgrade/reinstall preserves an existing valid user choice.
- [ ] **#27 criterion 2:** Settings reads/writes the authoritative persisted value and updates status across open tabs/menu without requiring manual file editing.
- [ ] **#27 criterion 5:** New work reserves enough space for temporary/derived files; active recording finalizes gracefully before exceeding available working space.

### [#30: Synchronize portable meeting libraries through a user-selected iCloud Drive folder](https://github.com/augustocbx/heed-macos/issues/30)

Current state: open; 9/12 original acceptance criteria addressed.

- [ ] **#30 criterion 2:** Account signed-out, iCloud disabled, unavailable folders and missing permissions produce actionable connection states.
- [ ] **#30 criterion 7:** Two-Mac concurrent edits preserve branches/commit markers; partial bundles are never visible as complete meetings.
- [ ] **#30 criterion 9:** Restart, sleep/wake, temporary offline state and sign-out preserve recoverable jobs without unlimited storage growth.

## Concrete implementation and environment findings

- [x] Fix failed capture-start cleanup when quota rejects before an audio writer exists. On source `d48244d`, two isolated 1 MiB quota start attempts returned HTTP 409 with `failed` state, null audio path and zero reservations, but left one then two empty `library/staging/capture-*` directories. Release only the current failed attempt's staging and allocations; preserve any retained audio and its recovery state.
- [x] Add a regression for repeated pre-capture quota rejection, plus a retained-audio failure control that proves recovery data is preserved.
- [x] Expand isolated installer verification to preserve a non-default 3 GB setting through release migration/upgrade/reinstall and compare persisted config with `/api/storage` and `/api/desktop/control/status`. Verify missing-field/default behavior separately. These checks supplement, rather than replace, actual two-Mac installation and visible menu acceptance.
- [x] Update [SMB synchronization](../smb-synchronization.md): new destination headers use v2, while existing v1 remains unchanged.
- [x] Document explicit confirmed v2 metadata deletion, exact-version preview/confirmation, retained shared audio and the [original-owner recovery policy](../remote-deletion.md), replacing the obsolete no-deletion-API statement.

Preserve explicit no-overwrite publication and canonical deletion fences. Both actual macOS NAS mounts rejected exclusive rename/hardlink primitives; signing/authentication passing does not resolve this filesystem capability.

Retain shared audio in production until cross-host freshness and object-liveness acceptance is established. SMB shared-audio garbage collection stays disabled; iCloud shared-layout audio stays retained.

## Evidence and completion rules

- For every retake, record source commit, installed commit where applicable, device/model, locale/content language, exact scenario/result and known limitations. Do not retain private meetings, credentials or token-bearing URLs.
- Repeat actual two-Mac acceptance with disposable libraries and consented synthetic or owner-selected test content; credentials remain owner-entered.
- Mark an original criterion only when all clauses have evidence; do not replace a pending full criterion with a narrower new checkbox.
- Close an issue only after its complete acceptance set is met, preserving not-planned closures for excluded integrations.
- Before merge handoff, commit/push all issue changes, verify fetched remote HEAD equality, stop only owned development services and safely remove this issue worktree.

This active ledger contains **15 pending original criteria** in #18, #25, #26, #27 and #30. Excluded account integrations are outside implementation and acceptance scope; their historical criteria remain in the original snapshot, not in this TODO. Parent/child requirements overlap; these counts are traceability counts, not distinct implementation tasks.

Baseline evidence: [remaining acceptance](remaining-acceptance.md), [original snapshot](original-acceptance-snapshot.md), [confirmed deletion](../remote-deletion.md), merged [PR #76](https://github.com/augustocbx/heed-macos/pull/76), and the updated roadmap review.

Baseline local verification in this dedicated worktree passed **18 quota/capture-allocation/installer-initialization tests, 74 assertions**. The pre-fix production HTTP reproduction used only disposable local data and controlled sidecar responses; no native capture, real account, mounted-share write or installed-app change was performed. Its owned API/sidecar were stopped and the disposable data was removed.

## Merged first implementation follow-up

[PR #78](https://github.com/augustocbx/heed-macos/pull/78), head `6433bf3`, implements the three checked quota cleanup/regression/installer-verification tasks above. The new production-HTTP regression failed on abandoned staging before correction; repeated rejection, unrelated-transfer preservation and retained-WAV/checkpoint/reservation recovery now pass. Fresh local validation passed 586 server tests / 3,324 assertions, 307 interface tests, the production build and 30 release/helper tests on both available and system Python. Independent review found no blockers. PRs #78/#79/#81 are merged, and [integrated main CI](https://github.com/augustocbx/heed-macos/actions/runs/37500635011) passed for `880a0bf`. Installed-device/provider acceptance remains separate.

The expanded complete release simulator exposed outdated migration and detached native self-test fixtures. Both were corrected; the rebuilt complete retake passed **73 checks**, including custom quota preservation through upgrade/reinstall. See [the source-bound evidence](synchronization-completion-evidence.md). No physical capture, installed app, account or real mounted provider was changed. The original pending criteria and full quota/provider milestones remain unchecked: a completed implementation task does not complete the original physical/two-Mac acceptance.
