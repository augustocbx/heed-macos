# Issue 70 language evaluation

## Current evidence

The implementation includes immutable English/PT admission, registered actual live/final identities, compatible adaptation, four interface locales, browser/native controls, explicit persistent final-only fallback and controlled PCM/FFmpeg/SSE/correction/recovery tests. Python lifecycle/worker tests cover admission leases, bounded transport, cancellation and owned cleanup. The public scorer and harness have 14 golden/integrity/identity/sandbox/log-bound tests; all eight checked-in WAV hashes, annotated spans, PCM formats and durations validate.

No actual inference benchmark, human regional-accent evaluation, physical capture or installed-app acceptance is claimed by this authoring commit. Initial integrated full server validation has inherited #7 portable/raw-writer fixture failures that must be resolved by complete #7 integration before issue completion. Client/Python/native scoped checks are recorded by the execution controller.

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
| Explicit engine/model matrix and English/PT selection | Registered Python/shared capabilities, health, preference/admission HTTP, browser/native tests | Actual cached weights and engine identities on both Macs |
| Genuine PT and unchanged final-only preference | PT immutable PCM/FFmpeg workflow, task/language checks, zero-live-job final-only and retry tests | Actual MLX PT predictions and paired resource replay |
| Accents, names, vocabulary and code switching | Public annotated synthetic fixtures and scorer golden cases | Three repeats per fixed choice/Mac; public prediction review; honest absent human-accent cohort |
| Provisional/final timing, speakers and corrections | Source guards/history, completed hydration, correction/retry/audio digest workflow | Actual native final timing/speaker output; complete #7 integration regression |
| Resource limits and independent UI locale | Compatible governor/lifecycle/priority tests, four locales, isolated native self-tests | Actual sampled variability and responsive synthetic browser/native UI on both Macs |

The controller appends actual result identities, report locations, quantitative limits and visual/manual findings after execution. This record deliberately contains no invented measurements or capability evaluation ID.
