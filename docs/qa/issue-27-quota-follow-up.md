# Issue #27: capture cleanup and installer quota verification

This approved follow-up addresses implementation and automated verification gaps in [#27](https://github.com/augustocbx/heed-macos/issues/27), related to [roadmap #18](https://github.com/augustocbx/heed-macos/issues/18). The baseline is main commit `d48244d1e1330a55fd01a8817043a36b9e6be958`.

## Reproduced failure and correction

Two isolated production-API recording starts with a 1 MiB quota returned HTTP 409, a failed coordinator with no audio path and zero reservations. Each attempt nevertheless left an empty `library/staging/capture-<meetingId>` directory. The new HTTP regression failed on that leftover directory before the correction.

The startup error handler now removes the current attempt's capture staging before releasing its allocation, only when no WAV was retained. The regression repeats the rejection with separate request IDs, preserves an unrelated transfer and checks the state after restart. A second test uses a synthetic native helper in a temporary public-source copy to fail after retaining a WAV and checkpoint; their exact bytes, meeting identity and reservations survive another rejected start and restart. No physical capture is performed.

## Installer verification

The release simulation now seeds a non-default 3 GB setting and checks persisted configuration, `/api/storage` and `/api/desktop/control/status` after installation, upgrade and reinstall. Missing-field initialization is checked separately using the actual initializer in a disposable app directory. The read-only quota verifier rejects disagreement or noninteger configuration; its focused tests check all three boundaries and preserved files. The quota HTTP test also runs the verifier against the actual isolated production API after a settings change and restart.

## Fresh local validation

- Full server suite: **586 tests, 3,324 assertions, zero failures**.
- Interface suite: **307 tests across 59 files**, plus the production build.
- Release helper, integration and quota-verifier suite: **30 tests** on both the available Python and the system Python used by CI.
- Bash syntax, frozen dependency installation and `git diff --check` passed.
- An independent read-only review found no blockers in the correction, test scope or related SMB documentation.

The first full server run started before this worktree's interface dependencies had been installed and failed two Vite startup tests, including a missing Vite module. Frozen dependency installation resolved that setup fault; the seven affected service-entrypoint/diagnostic tests and the subsequent complete server suite passed without changes to their source.

## Remaining acceptance

The full release simulation was expanded but was not executed in this follow-up. Actual fresh installation/update/reinstall on both Macs, visible cross-tab/menu propagation and physical recording/finalization under quota pressure remain pending. These synthetic and isolated checks do not complete those compound acceptance criteria or close #27. Exact-head CI, merge and installed runtime are separate gates. No real account, private meeting, mounted-share write or installed application was changed during local validation.
