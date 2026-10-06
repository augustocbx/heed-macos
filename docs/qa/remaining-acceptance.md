# Remaining acceptance and consolidated implementation

This report tracks the owner-authorized follow-up in [#62](https://github.com/augustocbx/heed-macos/issues/62). It distinguishes code verification, actual local-model/native-file checks, installed application behavior and external provider/device acceptance. Update it with fresh evidence before merge; do not promote a compound criterion from a narrower check.

## Verified baseline

The initial implementation PRs #42–#54, browser-help correction #55 and cloud block #57 were merged after their applicable exact-head CI checks. Google Drive and OneDrive are fixed off; #28/#29 are closed **not planned**, reflecting the owner's OAuth/account-setup deferral. #56 stays open for public desktop application IDs, deliberate enablement and real-account QA. Preserve that decision during this follow-up.

All 128 original acceptance bullets were reviewed. There are currently **85 checked** implementation/acceptance bullets and **43 unchecked** acceptance bullets, plus the six unchecked #18 delivery milestones. #15 generation/evidence and date criteria were promoted after actual bilingual local-model output on both Macs: exact supporting quotes, explicit/inferred distinction, ISO dates and nullable relative dates. Its task-filter/source-audio criterion remains pending.

Controlled English/Portuguese synthetic-file transcription passed on M1 and M4 Pro. English WER was 0%; Portuguese WER was 3.12%. Timestamp ranges passed. These were isolated native workers using cached models; they do not establish physical capture, stereo/intelligibility, native menu wiring or deployed target-version behavior.

Actual corrected chat semantic retakes passed representative single-meeting and broad-to-narrow label-scoped fixtures on both Macs. M1 used isolated production APIs; M4 used the exact production functions/validators with its installed local model. These are model/grounding checks, not M4 installed UI or capture-preemption acceptance.

Additional English/Portuguese queries over two different contradictory meetings passed on both installed models using the bundled consolidated production functions. Every response cited each meeting's current revision and kept approval/non-approval separate without inventing a resolution. Alongside the earlier missing-fact results, this supplies representative semantic evidence for #17 criterion 7 after the code merge. Citation clicking/audio and resource-priority acceptance remain distinct.

## Implementation integration

| Work | Required behavior | Status |
|---|---|---|
| #16/#17 structured local chat | Mandatory full response schema, exact eligible citation IDs, unchanged strict validation; sampler-compatible grammar | Reviewed feature commits integrated; final consolidated verification pending |
| #58 service ports | API 48100 / UI 48101 / transcription 48102, coherent validated device-private overrides, identified checkout-owned services, safe migration/rollback | Reviewed feature commit integrated; focused server 13 tests / 93 assertions and Python 15 tests passed; installed-device migration pending |
| #59 conflict notification | Actionable four-locale service/port notice, safe application name, native startup visibility, no unrelated termination or private process data | Reviewed commit integrated; feature branch server 510 tests / 2,969 assertions, UI 260 tests, Python 26 tests and native checks passed; final consolidated verification and applicable installed-device acceptance pending |
| #18 physical remote deletion | Explicit stale-bound confirmation, physical effects, protected shared revisions/objects, durable retry and honest provider boundaries | Native/provider/core implementation and independent recovery findings are under final review; real mounted SMB compatibility is blocked as detailed below |
| #15 source/filter/audio | Actual task-source navigation and complete global/meeting filter cases; fix any reproducible fault | Revision-safe navigation integrated; focused 27 tests, full UI 263 tests and production build pass; M1 browser retake passed representative global/meeting filters and exact English/Portuguese source/audio navigation, unavailable/deleted controls; full applicable device acceptance pending |

Heed-owned service and QA ports must avoid 3000–3999, 5000–5999, 7000–7999 and 8000–8999. Existing Ollama 11434 is unaffected. Old QA listeners on prohibited ports were stopped and their clean worktree removed. An unrelated Ruby listener on the previous M4 transcription port was preserved.

## Remaining device and external gates

The owner's Air recording retake exposed an older installed checkout (`800faf0`), rather than this consolidated implementation. Its browser coordinated stopping/saving and could retain elapsed time after a stop error. Read-only inspection also found unbounded sidecar HTTP/native-worker waits; a dedicated #4 follow-up covers silent or partial-response workers with synthetic regressions. Do not infer the exact cause of the reported capture failure from these compatible code paths alone.

At the owner's explicit request, the old checkout-owned services were stopped and the complete dirty checkout, local state and application were preserved before reinstalling consolidated commit `80dc9ef` on the Air. Native capture/menu self-tests, production build and bundled-sample transcription/diarization checks passed. All three live services identified the installed checkout on ports 48100–48102; previous recording/session file hashes stayed unchanged. Backend and visible UI were idle at `00:00`; the old 5001/5002/5170 listeners were absent. This is deployment/readiness evidence for that intermediate commit, not final-head CI, a new physical recording, or acceptance on the second Mac. The owner was invited to retest start/stop/save on the updated interface.

- **#4:** actual menu-started recording with tabs closed; live multiple-tab attachment/duration; real capture/finalization indication; quit/restart/update guards on both devices.
- **#14:** actual conferencing joins/ends, capture-readiness gates, reconnect/sleep/crash handling and permission/changed-format failures for supported current application versions.
- **#15:** complete applicable device retake for task status/date filters and task-origin audio/text navigation. M1 browser controls passed: global open/completed/all and dated/undated partitions; meeting completed/dated and completed/undated empty-state intersection; exact English/Portuguese segment highlight and matching WAV seeks, unavailable-audio text navigation and preserved deleted-meeting quotes. Navigation fixtures were accepted through the production task store; actual model semantics have separate evidence.
- **#16:** actual citation/audio navigation, recording/final-ASR preemption and applicable installed-device acceptance; review the semantic retakes before promoting their individual criteria.
- **#17:** actual scoped citation/audio navigation and device/resource-aware acceptance beyond isolated model inference; representative multi-meeting contradiction semantics passed on both devices.
- **#18/#25/#26:** real writable SMB publication, two-device conflicts/fault recovery and provider durability; physical remote-delete provider acceptance. Signed legacy read-only import and offline source availability passed on both Macs as described below; visible connection controls and final-head revalidation remain distinct.
- **#27:** actual fresh/upgrade quota persistence on both devices, native-menu/multiple-tab propagation and recording under quota pressure.
- **#30:** selected iCloud folder/bookmark/account error states, actual two-device concurrent publication/integrity, offline/sleep/restart recovery. Account/container metadata alone is insufficient.
- **#56:** deferred Google/Microsoft application IDs, owner authorization and real-account/two-Mac tests. The connections remain blocked.

No fully unmet external gate should be silently relabeled implemented, accepted or deployed. Close an issue only when its complete acceptance set has evidence, or when the owner explicitly records a planning closure such as #28/#29.

## Actual macOS SMB compatibility

The owner authenticated the ordinary NAS share personally on both Macs. Read-only session inspection verified SMB 3.1.1 with signing active and client-required signing. Authentication and transport protection therefore passed their narrow prerequisites.

Production library creation in one uniquely named disposable child refused the required exclusive publication primitive. Both physical Macs returned `ENOTSUP` for exclusive file and directory rename; exclusive hardlink publication was also unsupported. These are capabilities of the mounted macOS SMB filesystem interface. The result does not establish a NAS authentication or signing failure.

No production library header, persistent claim, meeting publication or physical deletion was established during this attempt. Only known synthetic capability probes were created in the disposable child. A file or directory move that can overwrite an unknown target is not an acceptable fallback. The corrected native capability gate was retested on both Macs: preparation and v2 transaction startup returned the typed unsupported-filesystem result, the disposable remote root names stayed unchanged, and neither header nor lease was created. A local guard can be provisioned, but a fresh refused attempt leaves no recovery journal. Four-locale regressions cover the actionable incompatibility notice.

Actual writable publication, two-Mac conflict/deletion and server freshness/durability criteria remain open. Production shared-audio garbage collection remains disabled.

A separate source-only legacy-v1 read-only retake passed on both Macs using the final frozen source. Two English/Portuguese bundles were generated with the production portable schema and **manually seeded** in the dedicated disposable child; this is not successful application publication or a provider-confirmed round trip. Both production importers committed two local sessions under a 1 MiB managed quota (26,262 bytes used, zero remaining reservations), preserving exact payload hashes, labels, manual speaker names, corrected text, saved notes, language and model provenance. Discovery/import made zero audio-object reads. One explicit audio request fetched only its exact object and verified its hash.

After disabling only the evaluator's provider and restarting its isolated core, the production search predicate and revision-qualified chat source/citation retrieval still found both committed local meetings with zero remote calls. All 93 copied public-source hashes matched the frozen source; both Macs executed the same bundle and native helper. No model answer was generated and no installed settings/browser flow was exercised. These narrow passes do not complete the compound writable, visible-device or fault-recovery criteria. The nine manual synthetic fixture files were unchanged and retained; no owned evaluator or service remained on either Mac.

## Independent review

Independent reviewers checked the default-off gate and chat correction. Claude's requested read-only second opinion confirmed the chat approach and identified port issues that were independently reproduced and corrected: inherited legacy `PORT` in native launch, Python URL port 0 acceptance and Foundation/POSIX checkout-path canonicalization. Additional regressions cover startup rollback with surviving wrapper descendants, separately managed IPv6 sidecars and the fork CLI's clone/update source contract. Its proposed double-scan deletion approach is not sufficient proof against a pending publisher; safe shared-object deletion needs an enforceable writer/deletion protocol. Record fresh review/test outcomes here before claiming completion.

Claude also reviewed the physical-deletion design. The resulting specification requires a persistent native guardian, physical-origin recovery proof, durable checkpoints before lease release, atomic whole-claim release, canonical manifest admission before publication and permanent deletion fences. Production SMB shared-audio collection stays disabled until real cross-host coherence is established; iCloud shared-layout audio is retained. Synthetic provider/fault tests cannot replace those external gates.

The task source retake reproduced stale-revision audio navigation and added regressions before correction. Same-meeting and freshly fetched global revisions are checked before focusing or seeking; valid tasks preserve exact segment focus and revision-qualified pending seeks. The dedicated issue branch was pushed and fetched at identical HEAD `49d5f0248654656f7e3c4bd71a75e00134d6df3b`, its owned API on 48110 was stopped, and the clean worktree was safely removed before integration.

Actual Claude source review and a second peer review reproduced deferred audio requests surviving load failure/expiration or departure, and an old queued seek superseding a newer direct citation. These were corrected with failing-then-passing tests, including StrictMode and rapid revisit controls. The final task follow-up branch was pushed/fetched at identical HEAD `4f9f4c745fff95789baf54bfb124acc2cf8a424b`; no services were started for that recreated worktree and it was safely removed before integration.

The M1 visible service-notice retake used only disposable wrong HTML/JSON responders on allowed ports. Both notices displayed the correct role/port, safe executable basename and recovery guidance; the transcription details suppressed misleading CPU defaults. Both-Mac source-only helper/native CLI tests are distinct from actual M4 visible menu or installed migration acceptance. Claude's reproduced findings were corrected; unsupported non-loopback URL and already-blocked Vite Host claims were not treated as confirmed defects. An additional actual native regression covers an exited helper whose descendant retains stdout: the bounded check reports unavailable, preserves unverified descendants and allows the next queued refresh to run.

The final #59 branch was pushed/fetched at identical HEAD `04a85b30b57f04a233ebab7be6c0bcf41322ee6e`. Cwd-based process checks found no owned services or helpers on either Mac. The clean worktree was safely removed before integration. One intermittent existing cloud-settings fixture race was observed in a full UI run; the focused suite and final full 260-test run passed without cloud production or fixture changes. Exact-head CI remains the merge gate.
