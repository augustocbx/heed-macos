# Issue 70 language evaluation

## Current evidence

The implementation includes immutable English/PT admission, registered actual live/final identities, compatible adaptation, four interface locales, browser/native controls, explicit persistent final-only fallback and controlled PCM/FFmpeg/SSE/correction/recovery tests. Python lifecycle/worker tests cover admission leases, bounded transport, cancellation and owned cleanup. The public scorer and harness have 14 golden/integrity/identity/sandbox/log-bound tests; all eight checked-in WAV hashes, annotated spans, PCM formats and durations validate.

Actual inference completed on the MacBook Air M1 (16 GiB) and MacBook Pro M4 Pro (48 GiB), macOS 27.0.1, against frozen implementation `bdb0f07fd77e130c931f7ad0c684fdffea7fbed1`: 12 cohorts per Mac, eight fixtures per cohort, three repetitions for each fixed EN/PT choice with preview on/off. All 192 finalizations preserved retained audio bytes; all 24 cohorts verified owned-worker shutdown. Disabled cohorts issued zero live jobs; each enabled fixed-language condition issued 45 live jobs across its three repetitions. No fallback engine or weight download occurred.

The actual live path was `mlx:mlx-community/whisper-base-mlx`, revision `1e3e249fb8d01c655324bd6841b1deadffd6d04c`, weight SHA-256 `2f57d5f3ef473054c638961f90716f4ee415e8108de81313eccb2c5fd62eff0b`. Final processing used Parakeet v3 and the existing EN/PT detector; the native executable SHA-256 was `e6ef715394dbf454ba40e63cd84f5f76aad123e4dd7f304a07bbe2c1a6d4a0c0` on both Macs. Both used MLX 0.32.3, mlx-whisper 0.4.3 and NumPy 2.5.3; Air Python was 3.12.12/Hugging Face Hub 1.33.0, Pro Python 3.14.8/Hub 2.1.1. Identical weights do not remove runtime, decoder or hardware variability.

### Measured quality and language limits

The following live results aggregate **all eight synthetic fixtures**, including speech outside the selected fixed language; they are stress-cohort measurements, not a Portuguese-only accuracy estimate. WER is aggregate errors/reference words and can exceed 100% with insertions. CER is the median non-silent fixture/channel CER. Mixed lexical preservation covers alternating/within-turn/two-channel fixtures, 18 annotated spans per condition.

| Mac / fixed live language | Aggregate live WER | Median CER | Mixed lexical preservation | Missed mixed spans | Exact names | Exact technical terms |
|---|---:|---:|---:|---:|---:|---:|

| Air M1 / EN | 1.057 | 0.714 | 0/18 | 9 | 0/12 | 6/21 |
| Air M1 / PT | 1.146 | 0.674 | 3/18 | 9 | 0/12 | 2/21 |
| Pro M4 Pro / EN | 2.008 | 0.714 | 0/18 | 8 | 0/12 | 6/21 |
| Pro M4 Pro / PT | 1.073 | 0.708 | 3/18 | 11 | 1/12 | 1/21 |

The correctly selected two-second Portuguese greeting had zero WER in all three PT-preview repetitions on each Mac. This proves genuine PT inference on that fixture, not general conversational accuracy. Manual review of every public prediction found substantial omissions, nonsensical multilingual output, malformed names, and repetitive hallucinated phrases on other short/technical/mixed fixtures. In PT mode, the alternating fixture's Portuguese clause was recognizable, but its English clause was usually corrupted or omitted; within-turn and dual-channel fixtures did not preserve their annotated languages reliably. Exact-span duplicate and known-translation counters were zero, but that detector cannot clear unfamiliar translations or repeated unrelated text: manual review confirms the mixed reliability gate **fails**. Capability remains `mixedLanguage:unverified`; no live automatic choice or reliable mixed-language claim is offered.

Final aggregate WER was 0.561 on Air and 0.610 on Pro. Exact full-name preservation was 0/48 per Mac, while exact technical-term preservation was 60/84. Both short greetings finalized correctly; several synthesized Portuguese names/phrases became unrelated English-looking output. Silence produced no live/final hallucination in this cohort. These are disclosed existing final-path limitations, not evidence that final recognition is accurate on human regional accents. When an exact phrase aligned, final boundary error was approximately 0.15–0.29 seconds on the short/alternating/within-turn fixtures; unmatched names/overlap have null timing scores. Synthesis-window annotations are not human-aligned word boundaries, and live times are chunk boundaries.

### Latency and owned process resources

First-preview values are medians of fresh-process first fixtures (cold, with already cached weights) or subsequent fixtures (warm). Call p95 is the median of per-fixture p95 values, not a pooled percentile. RSS and CPU peaks are sampled aggregate values for the owned sidecar/descendants; CPU can exceed 100% across processes. GPU/shared residency and sampling error prevent interpreting RSS as total model memory.

| Mac / language / preview | Cold first preview (s) | Warm first preview (s) | Call p95 (s) | Capture peak RSS (MiB) | Final peak RSS (MiB) | Capture peak CPU (%) |
|---|---:|---:|---:|---:|---:|---:|
| Air M1 / EN / on | 4.028 | 3.805 | 0.780 | 739.9 | 1031.7 | 100.4 |
| Air M1 / EN / off | — | — | — | 253.6 | 575.3 | 40.0 |
| Air M1 / PT / on | 4.871 | 3.895 | 0.884 | 683.4 | 1006.3 | 104.4 |
| Air M1 / PT / off | — | — | — | 253.3 | 576.8 | 42.7 |
| Pro M4 Pro / EN / on | 3.604 | 3.388 | 0.360 | 753.7 | 1040.8 | 105.2 |
| Pro M4 Pro / EN / off | — | — | — | 260.2 | 559.4 | 35.2 |
| Pro M4 Pro / PT / on | 4.139 | 3.397 | 0.374 | 755.7 | 1054.1 | 94.7 |
| Pro M4 Pro / PT / off | — | — | — | 263.3 | 587.6 | 29.9 |

Preview-off reduced sampled capture residency and removed live work, but final processing still peaked. System-wide pressure/swap was recorded before/after each cohort and includes unrelated applications, so this experiment does not attribute global swap changes to Heed. Both Macs ran from AC power. Raw phase samples, quantitative scores, identities and authored predictions remain outside tracked source in the controller's QA directory.

### Built interface and native checks

The `live-language-ui.mjs` runner passed independently on both Macs with the built production client, actual protected HTTP/coordinator/FFmpeg and a temporary synthetic PCM capture helper. It verified both-channel PT requests, compatible base→tiny runtime identity, persisted next-recording English while admitted PT stayed unchanged, authoritative final source, unsupported `.en` rejection before capture, and the explicit final-only action persisting off with zero further live jobs. Browser microphone access was explicitly denied; no physical devices or installed application were used. Four narrow interface locales independently saved speech/preview preferences and displayed actual live/final metadata; screenshots were visually inspected for wrapping and unclipped controls. Both runs reported zero browser page errors and verified their API port could be rebound after cleanup. The final combined production browser runs at `cdab13c7a1c53d01987233e1f082b88c371ffe04` on both Macs reported all three checks passed, zero external requests, zero page errors and 172,914 unchanged synthetic audio bytes. Reviewed offline-export integration removes inherited Google Fonts links. All six final screenshots per host were independently inspected, including the four narrow locales and active PT/final-only states.

Isolated menu builds/self-tests passed on both Macs and cover native saved-language actions, bounded service identity checks, saved-off-before-normal-start ordering, active PT/runtime labels and all four translations. They do not substitute for physical installed menu/recording permission acceptance.

### Integrated verification

Reviewed issue 7 correction/candidate/history and issue 71 offline-export interfaces are integrated. Full combined server regression passed **757 tests / 4,463 assertions / 107 files**; final client regression passed **494 tests / 85 files**, with a successful production build/typecheck. The language-policy Python suite passed six tests; actual inference and isolated native builds described above ran against unchanged recognition/native implementation files. Final source integration, independent review and exact-head CI are checked separately before the authorized merge. Physical capture permissions, human regional accents and subjective meeting quality are separate unevaluated cohorts; they are not inferred from synthetic replay.

## Reproduce actual engine replay

Run serially on Air M1 and Pro M4 Pro with an explicitly selected existing interpreter and existing native final binary, using the same frozen implementation and fixtures:

```sh
PATH=/opt/homebrew/bin:/usr/local/bin:$PATH /existing/environment/bin/python3 scripts/qa/evaluate-live-languages.py \
  --python /existing/environment/bin/python3 \
  --native-binary /existing/native/build/heed-parakeet \
  --fixture-manifest scripts/qa/fixtures/live-languages/manifest.json \
  --live-model base --repeats 3 --languages en pt --modes on-off \
  --output /private/tmp/heed-language-evidence/air-m1.json
```

Replace the explicitly labeled existing paths and output filename for each Mac. `--validate-only` verifies integrity without model inference. The evaluator starts an isolated production sidecar with a temporary app/config/work/voice/capability directory. It forces the explicit native final engine, resolves cached MLX weights offline, records repository revision/file hashes/dependencies/native binary hash, and rejects changed actual live engine/model/task/language. A macOS sandbox denies all outbound connections, including local proxy forwarding; inbound fixture HTTP replies remain allowed. No dependency install, model download or installed application configuration write is performed.

This quality replay admits only the explicitly selected model identity, so measurements cannot silently combine fallback weights. Actual capture governor adaptation is covered separately by the production PCM workflow. Each fixed-language/repeat/on-or-off cohort starts a fresh process with existing offline weights; its first fixture includes production lazy warmup and later fixtures reuse residency. The harness accumulates audio at fixture cadence, records first text and call/available-to-result p50/p95, final automatic EN/PT/timed speakers, verified audio digest/duration, on/off job counts and sampled process CPU/RSS/system pressure/swap. Resource phases distinguish capture and final processing. Registry shutdown closes only owned workers before the sidecar terminates. The evaluator snapshots registry/descendant PID, creation time and executable identity, then verifies those processes are gone after parent exit; PID reuse is not mistaken for surviving ownership. Bounded cleanup failure fails the run.

JSON metrics contain counts/rates/identities rather than recognized text. A separate `.predictions.json` retains only public authored predictions for review outside the repository. Bounded owned-service stderr is written to the adjacent `.stderr.log` (or `--diagnostics-output`), with clipping disclosed, so startup/cache failures are diagnosable without installed-app data. Generated reports must stay outside the checkout. CPU/RSS is sampled and shared pages may be counted twice; pressure/swap includes unrelated applications. Replay does not prove capture permissions or subjective meeting quality.

## Scoring and claim gate

WER uses NFC, case folding, punctuation removal and whitespace tokens, preserving accents. CER counts Unicode code points of that comparison copy, including internal spaces and accents. Neither normalization changes output or persisted source. Proper names and terms use exact normalized phrase preservation; insertions/deletions/substitutions, duplicated exact spans and silence hallucinations are reported explicitly. Language-span preservation uses authored original-language lexical anchors, never the forced ASR language field. Known annotated translation alternatives detect specific substitutions; unfamiliar translations require manual review. Missing timestamp alignment remains null; live timing is chunk boundaries rather than word alignment. Fixture annotations mark synthesis windows, not manually aligned word onsets, so final timing errors carry that reference limitation.

Review public EN/PT and code-switch predictions against annotated original language/text/time/channel. Record omissions, duplication, translated spans and whether each language span retains its original language. TTS, two-channel overlap and concatenated within-turn switching have the limits listed in the fixture manifest; licensed human regional accents and same-channel human overlap are absent cohorts.

No automatic mixed-language claim is granted by the scorer. Reliable mixed behavior requires no silent translation, no missed/duplicated annotated spans and at least 90% manually assessed EN/PT span-language preservation on both Macs across all three repeats for the exact live weights/cohort. Publish WER/CER/names/terms/timing/latency/resource variability even when this gate fails. Keep unverified/evaluated-limited copy when applicable; do not reduce the gate to obtain a pass.

## Acceptance evidence map

| Criterion | Current evidence | Remaining applicable evidence |
|---|---|---|
| Explicit engine/model matrix and English/PT selection | Registered Python/shared capabilities, health, preference/admission HTTP, browser/native tests | Passed: pinned actual weights/engine identities on both Macs |
| Genuine PT and unchanged final-only preference | PT immutable PCM/FFmpeg workflow, task/language checks, zero-live-job final-only and retry tests | Passed: three actual repeats, paired on/off resources and zero disabled jobs |
| Accents, names, vocabulary and code switching | Public annotated synthetic fixtures and scorer golden cases | Passed: three repeats/fixed choice/Mac, all public predictions reviewed; natural accents explicitly absent |
| Provisional/final timing, speakers and corrections | Source guards/history, completed hydration, correction/retry/audio digest workflow | Actual native output evaluated with disclosed quality/timing/attribution limits; final reviewed #7 integration completed |
| Resource limits and independent UI locale | Compatible governor/lifecycle/priority tests, four locales, isolated native self-tests | Actual two-Mac resource samples and built browser controls passed; isolated native checks recorded above |

The controller appends actual result identities, report locations, quantitative limits and visual/manual findings after execution. This record deliberately contains no invented measurements or capability evaluation ID.
