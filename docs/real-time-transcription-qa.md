# Real-time transcription preference: behavior and QA

The device-local `real_time_transcription` boolean in `~/.heed-app/config.json` defaults to
true. Only an explicit saved `false` disables it; unknown configuration fields are preserved.
A data-preserving upgrade keeps this file. Browser, menu, and automatic capture share the
backend coordinator's admission snapshot; request bodies cannot override this setting.
Changes during capture apply to the next recording. Recording continues in its admitted mode.
A Python-only restart checks a valid active checkpoint against the matching local API
identity and compact capture status before any preview startup work. Unverified/stale active
ownership suppresses preview startup until an admitted-mode handshake. Live ticks detect
sidecar PID generation changes and restore the immutable mode before sending inference.

When disabled, PCM microphone/system capture, audio persistence, metering, stop, final ASR,
timestamps, final speaker labels, recovery and final-source notes/tasks retain their existing
behavior. There is no live ASR, live diarization, mic-filter inference or preview-only warm-up.
This preference does not implement pause/resume (#12) or the pending audio-lifecycle work (#13).
It does not select or upload to a cloud provider.

## Model ownership and readiness

On the native Apple Silicon path, disabled startup skips capability inference benchmarks,
MLX preview loading/warming, and native diarizer acquisition. Native final ASR/diarization
remain lazy. Installer language-detection preparation still prepares its final-only tiny model,
but skips base preview warm-up when the saved preference is off.

MLX keeps weights in a module cache, so preview Whisper now uses an exclusively owned process
through the existing `NativeWorker` deadlines and shutdown registry. Release waits for the last
live HTTP lease; stopping or failing capture applies a deferred saved preference. Closing this
worker releases its cache without unloading an unrelated application's models. Governor swaps
close their replaced owned preview worker. Final ASR and native final/live diarization use their
existing resources and locks. A diarization instance already used for final work is retained.
Fallback engines may keep shared final ASR/pyannote resident; an identical live/final instance
is never closed when disabling preview. Fallback final loading is retained to preserve existing
readiness and failure behavior; replacing it with universal lazy loading would require wider
lifecycle changes.

Re-enabling is lazy and does not perform preview-only warm-up. `/health.preview_state` reports
`awaiting-capture`, `disabled`, `lazy`, `loaded`, or `failed`. Failed owned workers are
retired under the model lock and replaced for the next request; shared final instances remain
untouched. Re-enabling non-native preview restores adaptation using the actual loaded model
and retained safe governor ceiling. The legacy `warm` flag remains an admission gate; it does not
promise every kernel or model has already warmed. The first enabled chunk may have cold latency.
Settings reports saved-but-service-unavailable errors honestly; recording preparation may be
retried after the local transcription service becomes ready.

Turning the setting off should reduce capture-time processing. RAM savings depend on shared
model residency and allocator behavior; final processing can still peak. No fixed percentage,
zero-AI-memory, or battery improvement is promised.

## Acceptance evidence

| Issue criterion | Automated evidence | Measured evidence and limitations |
| --- | --- | --- |
| Default on, validation, restart, preserving upgrades | `recording-preference.test.ts` runs real config reads/writes across independent processes; `recording-http.test.ts` rejects malformed/nonlocal writes, persists false through server restart and preserves unknown config. | Upgrade preservation follows the existing installer contract; no installed-app upgrade was run here. |
| Browser and menu use one preference, next-recording changes | `real-time-capture.http.test.ts` runs production HTTP/coordinator/FFmpeg with synthetic native PCM. A disabled menu start ignores a client override, a setting change stays deferred, browser stop saves the meeting; next browser start uses saved on despite another override, then menu stop succeeds. | The stereo fixture also passed on the Pro; paired actual-engine replay completed in both orders on both Macs below. Synthetic capture does not prove physical device permission/completeness. |
| No live work when off, final text/speakers preserved | Same fixture counts every sidecar POST: off has only preference configuration and finalization; it verifies stereo 16 kHz retained WAV, final text and speaker labels. Python `PreviewHTTPTests` exercises production HTTP and rejects all nine live boundaries when off. | Sixteen actual-engine EN/PT runs preserved final text and timed labels with zero OFF live jobs. Physical input completeness is distinct from inference replay. |
| No startup preview work and safe release | Python `PreviewPreferenceTests` guards native startup/capability calls, in-flight live leases, preserved shared final instance, and lazy re-enable. `InstallerWarmupTests` exercises the real installer warm-up function. `PreviewHTTPTests` runs actual owned subprocess stdio transport and verifies release/reaping. | Measured startup/capture/finalization process residency is reported below. Cold re-enable and shared ownership are covered by isolated worker tests; cache variants may differ. |
| Recovery, final-source notes/tasks and priority | Coordinator regression preserves admitted mode through restart/retry and final timed speaker-labelled saving. Existing recording recovery, automatic-notes/task and preemption suites run with the full server/client/Python suites. | Existing recovery/preemption/retention contracts were retained. Physical crash/long-recording checks were not exercised; #12/#13 remain pending separate work. |
| Four-locale Settings/recording/menu feedback | Settings component tests use literal accessible EN/PT-BR/FR/DE labels and success prefixes, test save failure/retry; snapshot/RecordPage tests show final-only capture. Native self-tests decode final-only status and verify localized menu labels. | Automated semantic/localization evidence is available; manual visual/screen-reader checks were not run. |
| Paired CPU/RAM/swap/energy/finalization evidence | Executable production-engine replay harness below; controlled fixtures prove scheduling and transport, not real-engine accuracy/performance. | Both orders completed on each Mac with content-free measurements below; direct energy consumption was unavailable. Production synthetic stereo capture complements inference replay. |

Manual upgrade/reinstall, long physical recording/crash-recovery and screen-reader checks may
be useful follow-up QA. They are not additional issue-63 blockers by themselves; this change
does not reopen unrelated historical acceptance gates. The paired resource/final-output
evidence below maps to the live issue.

## Reproducible paired resource measurement

Use licensed/public or authored synthetic fixtures. Do not use private meetings. Fixtures must
be 16 kHz PCM16 mono/stereo WAVs, with identical SHA-256 hashes on both hosts. The harness installs
nothing, binds a fresh allowed loopback port, uses isolated device configuration/voices/capability
state and working audio, and shuts down only its own service and registered workers. Existing
public model caches are reused. Prepare the required cached models and a verified native binary
before running; do not infer native performance from a fallback engine.

```sh
python3 scripts/check-real-time-resources.py \
  --python /Users/augustocbx/heed/.venv/bin/python3 \
  --native-binary /Users/augustocbx/heed/packages/transcription/native/heed-parakeet/.build/release/heed-parakeet \
  --fixture /path/to/public-english.wav \
  --fixture /path/to/synthetic-portuguese.wav \
  --output /private/tmp/heed-preview-on-off.json \
  --order on-off
```

Repeat with `--order off-on` and a distinct output on the same hardware/load/power conditions.
Run the same commands on each Mac. Record interpreter/dependency versions, binary provenance,
commit, ambient meeting/browser load, power source and fixture provenance beside the JSON.

The report contains hashes, actual selected engine/model, byte-identical retained audio,
request counts, final text presence/timed-turn/speaker counts, startup/capture/finalization
seconds, sampled service-descendant CPU/RSS, system memory pressure/swap, and battery snapshots.
It does not include transcript text or audio. Native selection is verified when the explicit
binary is supplied. Off must issue zero live inference jobs; both modes must produce final text
and timed speaker turns. Compare capture and finalization phases separately, include transient
peaks and per-process samples, and report noisy or unavailable measurements.

This is fixture replay through production inference HTTP/worker boundaries. It does not use
physical capture devices or prove device permission, complete real microphone/system capture,
subjective accuracy, or speaker identity. `ps %cpu` is sampled and RSS can double-count shared
pages. Memory pressure, swap and battery describe the whole system and include other apps.
Direct energy consumption is not measured; use a separately authorized profiler if available.
Never promote passing fixtures or a single timing into both-Mac physical acceptance.

## Measured native-engine fixture replay on both Macs

Measured on 2026-10-06 at product commit `ff7b261bca697da15e1ae4cce308dd72dff03043`. The subsequent `f45d101` change installs FFmpeg in CI and improves a synthetic test failure message; it changes neither the inference product nor this measurement harness. These results describe isolated production-inference HTTP/worker replay, not physical meeting capture. Both ON-OFF and OFF-ON orders are complete on each Mac.

The M1 Air has 16 GiB RAM (`MacBookAir10,1`); the M4 Pro has 48 GiB (`Mac16,7`). Both recorded macOS 27.0.1. Interpreter versions differ: Air Python 3.12.12, Pro Python 3.14.8. Both use MLX 0.32.3, mlx-whisper 0.4.3, Torch 2.14.1 and NumPy 2.5.3; huggingface-hub is 1.33.0 on Air and 2.1.1 on Pro. Host differences prevent treating this as a controlled hardware-only comparison.

The EN fixture is 30.00 seconds of bundled public-domain speech; the PT fixture is 19.31 seconds of authored synthetic speech using the installed macOS Luciana voice. Both are mono PCM16 at 16 kHz. Their hashes match the fixture manifest and actual local WAV files across all reports:

- EN SHA-256: `b2db5de0c0e4e5fd3a7e25071f901f60e047329d2ad630c7ec041f90ebe503c2`.
- PT SHA-256: `00aa8c9433afff2a5a814508eacde257d336abdd2f0d19e127d3c25bad9fbd02`.
- Native binary SHA-256 on both Macs: `e6ef715394dbf454ba40e63cd84f5f76aad123e4dd7f304a07bbe2c1a6d4a0c0`.

All 16 completed runs used native Parakeet v3 for final recognition; enabled preview used the configured MLX Whisper base path. Retained fixture audio was byte-identical; every OFF run sent zero jobs across all nine live ASR/diarization/mic-filter boundaries. ON runs sent four EN or three PT live ASR jobs. Every final result contained EN/PT text respectively, timed turns and one speaker label (EN three turns; PT four). These are presence/timing/label checks, not measured word accuracy or verified speaker identity. Mono replay does not exercise two-channel separation or live system diarization.

Capture-phase samples below show `ON → OFF`, with each cell `arithmetic mean / sampled peak`. CPU is summed descendant `ps %cpu`, which can exceed 100% across cores. RSS is summed descendant process RSS in GiB; it can double-count shared pages and is not total physical/GPU/unified-memory use. Samples are approximately half a second apart, so brief peaks can be missed.

| Host | Run order | Fixture | CPU % mean/peak, ON → OFF | RSS GiB mean/peak, ON → OFF | Capture samples ON/OFF |
| --- | --- | --- | --- | --- | --- |
| Air | ON-OFF | EN | 4.2/64.9 → 0.1/6.3 | 0.306/0.561 → 0.028/0.028 | 55/56 |
| Air | ON-OFF | PT | 4.0/48.4 → 0.3/10.5 | 0.346/0.440 → 0.026/0.028 | 36/35 |
| Air | OFF-ON | EN | 3.4/72.5 → 0.2/9.7 | 0.525/0.557 → 0.028/0.028 | 57/57 |
| Air | OFF-ON | PT | 4.0/76.3 → 0.2/7.8 | 0.533/0.548 → 0.028/0.028 | 36/36 |
| Pro | ON-OFF | EN | 1.7/46.3 → 0.1/7.0 | 0.720/0.724 → 0.031/0.031 | 56/56 |
| Pro | ON-OFF | PT | 2.9/55.2 → 0.2/5.9 | 0.719/0.726 → 0.031/0.031 | 36/36 |
| Pro | OFF-ON | EN | 2.0/52.6 → 0.1/4.6 | 0.723/0.727 → 0.031/0.031 | 56/56 |
| Pro | OFF-ON | PT | 3.1/49.6 → 0.1/4.7 | 0.717/0.722 → 0.031/0.031 | 36/36 |

The measured OFF capture phase consistently did less processing and retained less sampled process RSS in this isolated fixture workload. This supports the inference-scheduling behavior; it does not establish a fixed percentage saving for meetings, a physical-memory saving, or battery-life improvement. Replay duration stayed near fixture duration: EN approximately 30.02 seconds and PT approximately 19.32–19.33 seconds. Audio was copied before replay, so matching hashes/duration do not measure real capture completeness.

Finalization remains a separate active inference phase. Values below are `ON → OFF`; CPU/RSS cells remain `mean / sampled peak`.

| Host | Run order | Fixture | Finalization seconds ON → OFF | CPU % mean/peak ON → OFF | RSS GiB mean/peak ON → OFF |
| --- | --- | --- | --- | --- | --- |
| Air | ON-OFF | EN | 7.60 → 6.30 | 57.6/169.4 → 76.1/186.6 | 0.299/0.517 → 0.161/0.304 |
| Air | ON-OFF | PT | 4.72 → 10.16 | 72.6/161.3 → 52.7/115.1 | 0.424/0.675 → 0.166/0.355 |
| Air | OFF-ON | EN | 5.07 → 6.53 | 72.2/200.3 → 79.2/184.0 | 0.624/0.853 → 0.190/0.374 |
| Air | OFF-ON | PT | 5.51 → 5.33 | 75.6/166.6 → 73.6/146.5 | 0.610/0.812 → 0.179/0.372 |
| Pro | ON-OFF | EN | 4.31 → 3.41 | 35.4/95.6 → 53.8/115.4 | 0.865/1.076 → 0.210/0.380 |
| Pro | ON-OFF | PT | 2.97 → 3.16 | 42.1/76.7 → 52.1/122.9 | 0.838/1.075 → 0.162/0.244 |
| Pro | OFF-ON | EN | 3.20 → 3.45 | 43.0/98.2 → 53.1/112.0 | 0.802/0.881 → 0.210/0.371 |
| Pro | OFF-ON | PT | 2.84 → 3.12 | 30.4/95.6 → 52.3/126.2 | 0.779/0.859 → 0.164/0.246 |

Finalization still produced substantial CPU/RSS peaks in OFF mode and did not become consistently faster. Air OFF finalization varied from 5.33 to 10.16 seconds for PT, illustrating variability. Pro finalization across both orders ranged 2.84–4.31 seconds ON and 3.12–3.45 seconds OFF. These small samples and differing interpreter/cache states are insufficient for a general speed claim.

Startup is affected by model/kernel cache state. OFF startup was approximately 0.21–0.23 seconds. ON startup on Air was 66.00 seconds for its first EN run, then 9.04–10.90 seconds for the other EN/PT runs; Pro ON startup was 4.05–5.09 seconds. OFF startup has only one sample per run, so its near-idle readings cannot characterize startup peaks. After finalization and explicit preview disable, short post-finalization RSS samples declined, but remaining final/shared resources and RSS accounting prevent a claim of complete physical-memory release. Raw JSON retains per-process/phase samples.

System observations: Air `memory_pressure -Q` reported system-wide free-memory percentages of 34–55% across phase snapshots; Pro 72–77%. These are whole-system free percentages, not a measured app pressure level or app-specific unified memory. Air already had 2,417.75 MiB of used swap at the first snapshot; it varied to 2,200.88–2,248.88 MiB later. Pro already had 7,808.62 MiB of used swap and it stayed unchanged in both orders. Existing swap and unrelated workloads prevent attributing these movements to Heed. Raw `vm_stat`, pressure and swap snapshots remain in the content-free JSON reports.

Both hosts were on AC power at 100% charge. No direct energy or battery consumption estimate is available; these short powered runs cannot support battery-saving claims. Public model caches were reused and are another source of order/cold-state effects.

Evidence files: `resources-air-on-off.json`, `resources-air-off-on.json`, `resources-pro-on-off.json`, `resources-pro-off-on.json`, `resource-environments.json`, and `fixtures/manifest.json`. JSON results contain hashes, configuration and measurements, not transcript text or audio. Published measurements omit local absolute paths, PIDs and battery identifiers.

Acceptance mapping for issue #63 combines complementary evidence: the production Bun/coordinator/FFmpeg synthetic stereo fixture checks actual capture-service audio persistence, browser/menu preference, immutable admitted mode and zero off-mode scheduling; the 16 actual-engine mono replays check native final EN/PT availability, timed labels and paired resource behavior. The capture fixture uses synthetic native PCM and controlled final responses; replay uses actual inference on a copied WAV. Neither layer alone proves a physical microphone/system path, acoustic quality or human speaker identity. Physical device permission, acoustic quality, human speaker identity, upgrades and manual accessibility were not exercised in these measurements. Pause/resume #12, retention #13 and live PT #70 remain separate issue scope.

Production stereo-fixture supplement: the independently reviewed local fixture passed at `ff7b261` (1 test, 18 expectations). The Pro `capture-pro.log` also records Bun 1.4.2 running that production-boundary fixture: 1 passed, 0 failed, 18 expectations, 7.34 seconds. This supplemental test uses controlled inference responses, so its final speaker/text checks complement rather than replace actual-engine replay. Synthetic PCM traverses the production capture/coordinator/FFmpeg persistence path; copied replay hashes are not represented as evidence of physical capture.
