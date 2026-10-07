# Issue #6: local transcription vocabulary

The live issue, current code and recent merged PRs were audited before implementation. The patch extends existing local session storage, frozen recording admission, MLX/faster-whisper `initial_prompt`, recognition candidates and portable projections. It adds no replacement pass, native CTC model or parallel ASR pipeline.

| Acceptance criterion | Implementation and evidence | Status |
| --- | --- | --- |
| Create/edit/delete/search/import/export local glossary | Versioned atomic JSON library, validated HTTP endpoints and Settings CRUD/search/confirmed import/explicit export; storage/HTTP and component regressions | Automated checks satisfied |
| Preserve accents and mixed EN/PT terms; optional language/pronunciation context | Unicode terms remain unchanged, scope filtering and textual hints use existing recognition context; JS/Python validation and scoped prompt tests | Automated checks satisfied; hints are context, not phoneme instructions |
| Reflect actual engine assistance support | Report existing MLX/CT2 initial_prompt and unsupported current native Parakeet path; native stream-open response records the actual admitted identity/snapshot; distinct native-live/Whisper-final regression | Automated checks satisfied; native recognition assistance remains unsupported |
| Record glossary version and effective configuration per run | Admission freezes library/glossary revisions and additions; live/final/candidate generations retain engine/model/language/prompt/used/excluded/status; restart and two-meeting isolation tests | Automated checks satisfied |
| Do not alter existing transcript/notes/speaker names | CRUD has no transcript rewrite; explicit retranscription remains a reviewable candidate; actual session-service unchanged-source regression | Automated checks satisfied |
| Reject malformed/duplicate/overlong terms without ASR crash | UTF-16 budgets, normalized duplicate detection, strict schema and bounded JSON before inference; invalid-manual-request-before-worker and prompt-budget regressions | Automated checks satisfied |
| Controlled useful benefit without hiding unrelated errors or insertions | Fixed public human EN/PT read-speech and authored formant fixtures, paired existing MLX base, two repeats on each Mac; results below include false insertions | Measured on both Macs for this cohort; real bilingual meetings/regional accents remain unverified |
| Repeat latency and memory measurements on both Macs | Same fixture hashes/model identity/decode settings and outbound-denied offline execution; cold/warm and memory limits below | Measured descriptive runs; no causal performance improvement claim |
| Vocabulary stays local unless explicitly exported | Local JSON0600 and frozen private metadata omitted from portable schema/history, meeting exports, notes/chat input; portable privacy regression | Automated checks satisfied |
| Preserve four interface locales and desktop/default behavior | Existing locale dictionaries extended; full translation coverage; desktop/automatic admission uses saved default | Automated checks satisfied; installed UI acceptance remains unverified |

## Paired evaluation, 2026-10-07

The MacBook Air M1 and MacBook Pro M4 Pro ran existing `mlx:mlx-community/whisper-base-mlx` under `sandbox-exec` with outbound networking denied and Hugging Face/Transformers offline cache settings. No download or alternate model fallback was used. Each machine completed 84 decode calls: 21 audio/language cases, two repeats, baseline and vocabulary enabled. Eight fixed FLEURS test clips (first four `en_us` and first four `pt_br`, selected before inference, CC-BY-4.0) provide public human read-speech. Authored eSpeak formant fixtures add names, mixed terminology, unrelated/ambiguous speech, acronyms and silence. Repeated clips are not independent speakers. No private meeting audio or transcript was used or committed.

Fixed terms were Sintra, Lord Byron, Bieber, Giancarlo Fisichella, Goethe, Fichte, Schlegel, Beatriz Vieira, João Pereira, Kubernetes, PostgreSQL, API, TLS and SNE. Audio hashes and the shared manifest hash were checked on each machine. Baseline/enabled runs differ only by `initial_prompt`; both use the same model, explicit language, temperature zero and `condition_on_previous_text=False`.

Recognition results were identical on the two machines:

| Cohort, per machine | Target recall baseline → enabled | False insertions baseline → enabled | Unrelated speech errors/reference words baseline → enabled |
| --- | --- | --- | --- |
| Public human read-speech | 2/14 (14.29%) → 14/14 (100%) | 0 → 0 | 24/158 → 24/158 |
| Authored formant speech | 2/24 (8.33%) → 10/24 (41.67%) | 0 → 8 | 82/120 → 80/120 |
| Combined | 4/38 (10.53%) → 24/38 (63.16%) | 0 → 8 | 106/278 → 104/278 |

The 14 public target occurrences are seven unique spoken terms counted across two repeats. Enabled synthetic distractor/acronym cases produced eight excess glossary occurrences across repeats, demonstrating that prompting can insert unspoken terms. Neither mode produced a silence hallucination. This is useful benefit for the selected public cohort and explicit evidence of insertion risk, not guaranteed correction or a blanket no-regression result. The small fixed glossary remains opt-in and bounded; native Parakeet still reports unsupported.

| Machine (macOS 27.0.1) | Baseline/enabled total ASR seconds | First baseline call seconds | Warm baseline/enabled median seconds | Process peak RSS bytes | MLX peak bytes |
| --- | --- | --- | --- | --- | --- |
| MacBook Air M1 | 9.5158 / 8.9714 | 0.5375 | 0.2127 / 0.2034 | 487,063,552 | 593,058,374 |
| MacBook Pro M4 Pro | 3.7185 / 3.4878 | 0.2833 | 0.0807 / 0.0796 | 496,287,744 | 593,911,386 |

“Cold” means the first inference in a fresh evaluator process, not an emptied OS disk cache. Baseline always precedes enabled, sharing the loaded model and lazy caches; warm medians exclude the first case. Timings include decoding/load work in the existing wrapper and are descriptive, not randomized treatment comparisons. Process RSS is cumulative process high-water memory; MLX is GPU/unified allocator memory and must not be added to RSS. These are bounded short-fixture runs, not sustained production-memory measurements.

Evidence is retained outside Git under `/private/tmp/heed-issues-4-6-9-13-22`: the shared `issue6-cohort/manifest.json`, Air `issue6-air-benchmark/vocabulary-evaluation.json`, Pro `issue6-pro-benchmark/vocabulary-evaluation.json` (controller copy `issue6-pro-benchmark.json`) and run logs. Manifest SHA256: `2be8ce1bf1a71b4b0c0ecf97d0ac811d51c9697d8ef0ac08fe9febea75dad92c`. Air report SHA256: `6acdeecbb83c0e5283b838bf06e841a41c671e83a8c3ad51795bfff27e265f44`. Pro report SHA256: `cde74cbeea747bf6d0c07ae7dbe80351d02b330c5a07a313581e24b96347e582`. Owned evaluators exited on both machines; no native worker was created.

## Validation and remaining gates

Before independent review, the server library suite passed 870 tests/5,190 assertions across 124 files; the full client suite passed 524 tests across 89 files; Python passed 124 tests; production client build passed. Reviewer feedback then exposed inherited live metadata and hidden meeting-addition carryover. Red/green regressions now cover two consecutive meetings, failed admission/retry and selector remount; actual native streaming provenance is covered at its existing handler. After the fixes, the full client suite passed 526 tests/89 files, Python passed 125 tests, the affected coordinator/provenance suite passed 29 tests/119 assertions, and the client typecheck/production build passed. The integration coordinator records final merged checks and commit identity.

Generic legacy uploads with `language:auto` exclude language-scoped terms because that path does not detect language before its first prompt; their configuration records exclusions. Authoritative capture finalization, saved-audio retranscription and local import use their existing explicit/detected language. Use unscoped entries on automatic legacy uploads or an explicit language. Long-recording first-window behavior, consented natural bilingual conversation, regional-accent/ambiguous-name meeting acceptance, installed UI on both Macs and execution on macOS 14 remain unverified. Issue #6 must remain open until the applicable external acceptance gates are evidenced.
