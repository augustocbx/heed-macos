# Issue 4 acceptance follow-up

The October 7 audit of `41e1c194e86a8cef4f367d45037c97940f7900f2`
found the authoritative recording implementation already present. This follow-up
extends the existing production-client replay instead of adding another recording
coordinator, capture process, browser owner or finalization pipeline.

## Coverage

`scripts/qa/live-language-ui.mjs` uses the built production client, protected
production HTTP API, real FFmpeg PCM writer and actual saved meeting store. Its
owned helper produces synthetic PCM; its ASR responder returns authored text.
Browser microphone access is denied. No installed configuration or meeting is
opened or changed.

The additional scenario starts with every tab closed, submits the same desktop
start receipt twice, opens and reloads two tabs, checks their advancing elapsed
timers, closes every tab again, and submits concurrent desktop stops. While the
one finalizer is held, actual capture indication is off, finalization is visible
in a newly opened tab, and maintenance acquisition fails. Both stop responses
observe one completed meeting; the persisted duration equals FFprobe's actual WAV
duration. Reload restores the saved final transcript.

The existing scenarios continue to cover both capture channels, immutable live
language, runtime model adaptation, explicit final-only admission and all four
interface locales. Native menu self-tests verify the red recording image and
quit restrictions independently. Existing coordinator, HTTP, maintenance,
worker and updater suites retain their failure/restart/origin coverage.

| Acceptance criterion | Implementation/evidence | Remaining validation |
|---|---|---|
| Menu recording without tabs and one stop/save | Existing coordinator/desktop protocol; built-client synthetic replay | Actual installed native menu and physical EN/PT capture on both Macs |
| Reload/multiple tabs attach with correct duration | Production polling/store; two-tab replay and persisted WAV duration comparison | Installed physical-device replay |
| Idempotent acknowledged commands | Existing durable receipts; repeated start and concurrent stop replay | Already checked in issue; retain existing checked state |
| Recording indication vs finalization | Production capture-process status, visible finalization, native red-symbol self-test | Installed menu indication during physical capture/finalization |
| Durable lifecycle recovery | Existing manifest/finalCapture checkpoints and fault/restart tests | Already checked in issue; retain existing checked state |
| Quit/restart/update guards | Existing fresh-status native quit check and processing-maintenance/update tests; replay denies maintenance while finalizing | Installed quit/restart/updater across physical boundaries on both Macs |
| Localhost origin enforcement | Existing API checks and hostile-origin regressions | Already checked in issue; retain existing checked state |
| Retained audio/names and durable save | Existing checkpoint, speaker reconciliation and persistence-failure tests | Already checked in issue; retain existing checked state |

The complete issue remains open while the physical-device compound acceptance
is pending. Synthetic replay demonstrates the implemented coordination and
actual managed-file lifetime; it does not establish device permissions, audio
intelligibility or subjective recognition quality. The native compiler target is
macOS 14; these current-Mac runs do not establish runtime acceptance on macOS 14.

## Verification

Baseline: 865 server tests / 5,149 assertions, 520 client tests, successful
production client build/typecheck, and native menu/update self-tests. The extended
Air M1 replay reported four scenarios, zero page errors and 172,914 synthetic
captured audio bytes; the Pro M4 Pro reported the same four successful scenarios,
zero page errors and 172,914 bytes. Both new finalization screenshots were
inspected. The replay starts only the production API plus synthetic sidecar; its
service-diagnostics notices therefore do not establish a complete installed
three-service setup. Generated logs, screenshots, audio and transcripts stay
outside Git at `/private/tmp/heed-issues-4-6-9-13-22/issue4-air-reviewed` and the same
controller directory's `issue4-pro-reviewed` on the Pro.

```sh
PATH="$HOME/.bun/bin:/opt/homebrew/bin:$PATH" node scripts/qa/live-language-ui.mjs \
  --output /private/tmp/heed-issue4-evidence
```
