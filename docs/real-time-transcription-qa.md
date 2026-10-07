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

| Issue criterion | Automated evidence | Pending issue evidence or limitations |
| --- | --- | --- |
| Default on, validation, restart, preserving upgrades | `recording-preference.test.ts` runs real config reads/writes across independent processes; `recording-http.test.ts` rejects malformed/nonlocal writes, persists false through server restart and preserves unknown config. | Upgrade preservation follows the existing installer contract; no installed-app upgrade was run here. |
| Browser and menu use one preference, next-recording changes | `real-time-capture.http.test.ts` runs production HTTP/coordinator/FFmpeg with synthetic native PCM. A disabled menu start ignores a client override, a setting change stays deferred, browser stop saves the meeting; next browser start uses saved on despite another override, then menu stop succeeds. | Fixture/resource comparisons on both Macs are pending. Synthetic capture does not prove physical device permission/completeness. |
| No live work when off, final text/speakers preserved | Same fixture counts every sidecar POST: off has only preference configuration and finalization; it verifies stereo 16 kHz retained WAV, final text and speaker labels. Python `PreviewHTTPTests` exercises production HTTP and rejects all nine live boundaries when off. | Actual paired EN/PT engines on both Macs; physical input completeness is distinct from inference replay. |
| No startup preview work and safe release | Python `PreviewPreferenceTests` guards native startup/capability calls, in-flight live leases, preserved shared final instance, and lazy re-enable. `InstallerWarmupTests` exercises the real installer warm-up function. `PreviewHTTPTests` runs actual owned subprocess stdio transport and verifies release/reaping. | Actual process residency before/after toggle, cold re-enable, model cache variants. |
| Recovery, final-source notes/tasks and priority | Coordinator regression preserves admitted mode through restart/retry and final timed speaker-labelled saving. Existing recording recovery, automatic-notes/task and preemption suites run with the full server/client/Python suites. | Existing recovery/preemption/retention contracts were retained. Physical crash/long-recording checks were not exercised; #12/#13 remain pending separate work. |
| Four-locale Settings/recording/menu feedback | Settings component tests use literal accessible EN/PT-BR/FR/DE labels and success prefixes, test save failure/retry; snapshot/RecordPage tests show final-only capture. Native self-tests decode final-only status and verify localized menu labels. | Automated semantic/localization evidence is available; manual visual/screen-reader checks were not run. |
| Paired CPU/RAM/swap/energy/finalization evidence | Executable production-engine replay harness below; controlled fixtures prove scheduling and transport, not real-engine accuracy/performance. | Execute paired EN/PT runs on each Mac, compare capture completeness, CPU/RAM/pressure/swap and finalization; energy evidence where available. Reverse-order repetition improves measurement confidence. |

Manual upgrade/reinstall, long physical recording/crash-recovery and screen-reader checks may
be useful follow-up QA. They are not additional issue-63 blockers by themselves; this change
does not reopen unrelated historical acceptance gates. The pending paired resource/final-output
evidence above maps to the live issue.

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
