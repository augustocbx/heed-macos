# Remaining acceptance and consolidated implementation

This report tracks the owner-authorized follow-up in [#62](https://github.com/augustocbx/heed-macos/issues/62). It distinguishes code verification, actual local-model/native-file checks, installed application behavior and external provider/device acceptance. Update it with fresh evidence before merge; do not promote a compound criterion from a narrower check.

## Verified baseline

The initial implementation PRs #42–#54, browser-help correction #55 and cloud block #57 were merged after their applicable exact-head CI checks. Google Drive and OneDrive are fixed off; #28/#29 are closed **not planned**, reflecting the owner's OAuth/account-setup deferral. #56 stays open for public desktop application IDs, deliberate enablement and real-account QA. Preserve that decision during this follow-up.

All 128 original acceptance bullets were reviewed. There are currently **85 checked** implementation/acceptance bullets and **43 unchecked** acceptance bullets, plus the six unchecked #18 delivery milestones. #15 generation/evidence and date criteria were promoted after actual bilingual local-model output on both Macs: exact supporting quotes, explicit/inferred distinction, ISO dates and nullable relative dates. Its task-filter/source-audio criterion remains pending.

Controlled English/Portuguese synthetic-file transcription passed on M1 and M4 Pro. English WER was0%; Portuguese WER3.12%. Timestamp ranges passed. These were isolated native workers using cached models; they do not establish physical capture, stereo/intelligibility, native menu wiring or deployed target-version behavior.

Actual corrected chat semantic retakes passed representative single-meeting and broad-to-narrow label-scoped fixtures on both Macs. M1 used isolated production APIs; M4 used the exact production functions/validators with its installed local model. These are model/grounding checks, not M4 installed UI or capture-preemption acceptance.

## Implementation integration

| Work | Required behavior | Status |
|---|---|---|
| #16/#17 structured local chat | Mandatory full response schema, exact eligible citation IDs, unchanged strict validation; sampler-compatible grammar | Feature branch verified; consolidation pending |
| #58 service ports | API48100/UI48101/transcription48102, coherent validated device-private overrides, identified checkout-owned services, safe migration/rollback | Implementation and review corrections in progress |
| #59 conflict notification | Actionable four-locale service/port notice, safe application name, native startup visibility, no unrelated termination or private process data | Pending |
| #18 physical remote deletion | Explicit stale-bound confirmation, physical effects, protected shared revisions/objects, durable retry and honest provider boundaries | Design in review |
| #15 source/filter/audio | Actual task-source navigation and complete global/meeting filter cases; fix any reproducible fault | Pending acceptance |

Heed-owned service and QA ports must avoid3000–3999,5000–5999,7000–7999 and8000–8999. Existing Ollama11434 is unaffected. Old QA listeners on prohibited ports were stopped and their clean worktree removed. An unrelated Ruby listener on the previous M4 transcription port was preserved.

## Remaining device and external gates

- **#4:** actual menu-started recording with tabs closed; live multiple-tab attachment/duration; real capture/finalization indication; quit/restart/update guards on both devices.
- **#14:** actual conferencing joins/ends, capture-readiness gates, reconnect/sleep/crash handling and permission/changed-format failures for supported current application versions.
- **#15:** complete task status/date filters and task-origin audio/text navigation, including unavailable/deleted sources.
- **#16:** actual citation/audio navigation, recording/final-ASR preemption and applicable installed-device acceptance; review the semantic retakes before promoting their individual criteria.
- **#17:** actual scoped citation/audio navigation, multi-meeting contradiction scenario and device/resource-aware acceptance beyond isolated model inference.
- **#18/#25/#26:** real disposable mounted SMB access/security/durable publication, offline imported-AI use and two-Mac metadata roundtrips; physical remote-delete provider acceptance after implementation.
- **#27:** actual fresh/upgrade quota persistence on both devices, native-menu/multiple-tab propagation and recording under quota pressure.
- **#30:** selected iCloud folder/bookmark/account error states, actual two-device concurrent publication/integrity, offline/sleep/restart recovery. Account/container metadata alone is insufficient.
- **#56:** deferred Google/Microsoft application IDs, owner authorization and real-account/two-Mac tests. The connections remain blocked.

No fully unmet external gate should be silently relabeled implemented, accepted or deployed. Close an issue only when its complete acceptance set has evidence, or when the owner explicitly records a planning closure such as #28/#29.

## Independent review

Independent reviewers checked the default-off gate and chat correction. Claude's requested second opinion confirmed the chat approach and identified port issues to reproduce and correct: inherited legacyPORT in native launch, PythonURL port0 acceptance and Foundation/POSIX checkout-path canonicalization. Its proposed double-scan deletion approach is not sufficient proof against a pending publisher; safe shared-object deletion needs an enforceable writer/deletion protocol. Record fresh review/test outcomes here before claiming completion.
