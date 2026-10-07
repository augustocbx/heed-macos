# Integrated acceptance review: issues 4, 6, 9, 13 and 22

The live issues, existing implementation, current main and independent review
findings were audited before extending behavior. Each issue has its own branch
and worktree; this integrated branch combines them against the v0.1.6 main
baseline. It preserves the existing coordinator, authoritative finalizer,
atomic session store, media normalizer, quota owner and localization systems.
The main checkout and unrelated issue worktrees are preserved.

## Resulting behavior

- #4 extends the existing no-tab/multi-tab recording replay. No second recording
  implementation was added.
- #6 adds a versioned local vocabulary, validated import/export, per-run snapshots
  and honest actual-engine provenance. Native Heed Parakeet reports unsupported
  assistance; Whisper uses first-window context. Meeting additions are consumed
  only after successful admission and never leak into another meeting.
- #9 adds local audio/video import using the existing full-audio finalizer. Durable
  jobs expose phases, cancellation and recoverable errors. Unconfirmed sidecar
  ownership blocks new mandatory work until the owning retry confirms retirement.
  Saved-meeting recovery never requires a deleted source or repeated ASR. Every
  retained job remains visible. URL import is not exposed by this milestone.
- #13 adds an acknowledged, frozen transcript-only mode. Temporary managed audio
  remains protected until canonical final text is durable, exact owned audio is
  removed and a cleanup receipt is saved. Pending recovery survives restart;
  intentional unavailable audio returns 410 with its reason. Portable meetings
  carry the archival intent, while cleanup paths and raw vocabulary stay local.
- #22 delivers an offline FR/DE evaluation and NO-GO decision for product options.
  It does not change the established EN/PT admission policy.

Import admission freezes the default glossary once, stores it privately in the
job and includes it in deduplication identity. Restart/reattachment uses that
same snapshot; subsequent glossary edits cannot change the sidecar signature.
Import and capture share one exact-owned cleanup helper. The integrated tests
verify the intentional 410 response together with import cleanup and provenance.

## Validation

| Check | Result |
|---|---|
| Complete server library suite, M1 Air and M4 Pro | 913 tests, 5,476 assertions, 129 files on each; no failures |
| Complete client suite, M1 Air and M4 Pro | 541 tests, 91 files on each; no failures |
| Python transcription/worker suite | 131 tests; no failures |
| Public QA/scoring/evaluator suite | 25 tests; no failures |
| Production interface typecheck/build | Passed; existing large-bundle warning remains |
| Native menu, credential helper and updater fixture build/self-tests | Passed with the macOS 14 deployment target, without installation |
| Production built UI on both Macs | Seven scenarios, zero page errors per host; synthetic capture/ASR and actual FFmpeg/API/session persistence |
| Narrow four-locale visual checks | Vocabulary, archival-mode and import controls; horizontal DOM checks and reviewed screenshots |
| Actual full import finalizer on both Macs | Same public EN/PT files, native Parakeet plus diarization, explicit and automatic language, outbound network denied |

The synthetic replay starts only the API and its owned responder. Its service
diagnostic notices do not establish readiness of the installed three-service
application. Browser microphone access is explicitly denied.

The actual-finalizer public files are 10.56 seconds (EN) and 17.76 seconds (PT).
The explicit runs took 2.873 / 2.491 seconds for EN and 2.112 / 1.576 seconds
for PT (Air / Pro), including their different cold/warm order. Both hosts
reported successful diarization, valid segment bounds, unchanged original
hashes and no remaining derived WAVs. EN WER was 26.32% and PT WER was 0% on
these two small files; this is not a general quality guarantee. The caller used
the real import event adapter and authoritative finalizer, separately from the
built UI replay's synthetic ASR. It did not install the branch or access device
capture. Actual finalizer SHA-256 on both hosts:
`d8f69519385690c301b838af235bd375a4dbe183cbd3b845ca015430f8b30652`.

The vocabulary benchmark uses the same licensed public and authored fixtures
on both hosts. Target recall improved 4/38 to 24/38, with synthetic false
insertions increasing 0 to 8; public unrelated-speech error counts were
unchanged. See [the vocabulary report](issue-6-local-vocabulary.md) for the
cohort, artifact hashes, timings and limitations. FR/DE research completed
108 calls per host; see [the evaluation](../language-expansion-evaluation.md).

Fault regressions cover save/cleanup receipt failures, crashes/restarts,
quota protection, unresolved worker admission, partial normalization, cancellation,
canonical saved-meeting recovery, repeated submissions, private provenance,
manual speaker preservation and old-meeting compatibility. Independent reviewers
reproduced and verified fixes before the final integrated suites. CI also runs
the new vocabulary/import Python checks and integrated production UI replay.

All evidence remains outside Git under
`/private/tmp/heed-issues-4-6-9-13-22`: server/client/native/Python logs,
`integrated-{air,pro}-ui-verified`, `issue9-{air,pro}-{actual,auto}` and the
separate vocabulary/language benchmark reports. No private recording, personal
transcript, credentials or generated runtime evidence is committed.

## Acceptance marks and remaining gates

Acceptance checkboxes refer to verified implementation/research in the linked
PR, not deployment. Issues remain open pending merge and applicable external
acceptance. The existing #4 checked criteria are preserved; its four compound
installed-menu/device gates remain unchecked. The eight functional #6 criteria,
eight applicable local-import #9 criteria, eight #13 criteria and eight research
#22 criteria have implementation and automated/controlled evidence above and
in their individual reports. The conditional URL criterion is not applicable:
this local-file milestone adds no URL import interface.

Physical installed native-menu EN/PT capture without tabs, permission and quit/
restart/update boundaries, real capture in both storage modes with device-level
faults/quota/crash inspection, diverse natural bilingual conversation and regional
accents remain unverified. Both current Macs run macOS 27.0.1. Compiler targeting
macOS 14 does not establish end-to-end execution on macOS 14 or every supported
OS release. FR/DE live chunks, natural same-speaker switching, production detection
metadata and perceptual listening/timing remain future NO-GO release gates.
