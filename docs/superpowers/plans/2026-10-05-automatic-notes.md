# Automatic meeting notes implementation plan

**Goal:** Implement issue #8: opt-in local notes after authoritative, saved final transcription.

**Architecture:** Session JSON is the transaction boundary for transcript revision, a job per revision, and notes provenance. Atomic writes avoid a separate queue/session crash window. A single local worker snapshots the chosen template/model/language, yields to capture/transcription, and commits only if source and notes still match. Existing sessions are not backfilled. Client settings and meeting status use the existing API and session store.

**Tech stack:** Bun/TypeScript server, React/Zustand client, local Ollama, Bun/Vitest tests.

**Spec:** https://github.com/augustocbx/heed-macos/issues/8

## Global constraints

- English source, docs, messages, and GitHub artifacts; preserve supported interface translations and user meeting content.
- No external generation or publication. Reject remote Ollama endpoints/models.
- Disabled by default; select an installed local model and valid template before enabling.
- Final transcript and speaker mapping must be saved before enqueueing. Never use the English live preview as authoritative input.
- Exactly one logical job per transcript/speaker revision. Retry reuses that identity.
- Preserve existing notes unless an explicit replacement request matches their current version. Late results cannot overwrite edits or new revisions.
- One notes worker, preempted by capture/transcription. Persist failures independently of meeting/audio success.
- Keep personal runtime/config/audio untouched; tests use temporary directories and synthetic fixtures.
- Merge only after exact-head CI succeeds; no coauthor trailers.

## Tasks

1. Add shared settings/job/provenance contracts and durable session/worker/Ollama modules. Tests cover disabled/final-only enqueue, duplicates, revisions, restart, cancellation/preemption, compare-and-save, missing/unavailable/local-only models, malformed/incomplete streams, and custom templates/languages.
2. Integrate persistence/settings/job controls and resource holds in the server. Atomically save/reconcile sessions; guard new mutation endpoints. Final saves from capture/recovery/retranscription carry explicit finality. Tests cover speaker edits during save and failed persistence.
3. Add opt-in settings, list/detail/result status, cancel/retry/explicit replacement, stale/provenance presentation, and live session synchronization. Preserve all four locales. Tests cover prerequisites, error persistence, controls, refresh, and localization. Await manual notes persistence and use the final meeting language.
4. Review the complete diff, run the full existing CI command set, perform isolated UI/API checks, document concurrency and limits, open an English PR, wait for CI, and merge when green.

## Review focus

Check crash consistency, race boundaries, cancellation and model locality before polish. Verify jobs never turn a successful recording into a failed recording. Automated fixtures cover English and Portuguese; do not claim physical M1/M4 or live model acceptance unless actually tested.

## Interface overlap review

| Tasks | Shared boundary | Resolution |
| --- | --- | --- |
| 1 / 2 | Worker/session service imported by server | Backend implementer owns new modules; root owns server wiring and shared types. |
| 2 / 3 | Finalized marker, job records, settings/control API | Shared contracts written first; root owns recording/recovery helpers, UI implementer owns status/settings/manual notes. |
| 1 / 3 | Job states and error reasons | Stable codes translated by shared UI status component. |
| 1 | Tests vs durability design | Real temporary files and controlled fake transport; no personal config. |
| 2 | Final mapping timing | Finality is committed only with the latest saved names. |
| 3 | Polling vs detail state | Refresh viewing and result notes from saved session records. |
| 4 | Integration vs authorization | User already authorized merging with green CI. |
