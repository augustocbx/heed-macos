# Automatic notes follow-up validation — October 5, 2026

This is bounded evidence for issue #8, not full physical acceptance or an installation report. The follow-up strengthens the shared automatic/manual notes prompt, adds a repeatable live evaluator, and aligns the menu app with the declared macOS 14 minimum.

## Automated and build checks

- 83 server tests and 100 interface tests passed, including the supported interface locales and isolated HTTP failure/preemption scenarios.
- 18 Python policy/identity tests passed; Python syntax, installer shell syntax, and the production interface build passed.
- Native capture self-test passed. Compilation emitted existing Swift `Sendable` capture warnings.
- Menu app build-only self-tests passed; the compiled executable is arm64 with `LC_BUILD_VERSION` minimum `14.0` and SDK `27.0`. The bundle now declares `LSMinimumSystemVersion` `14.0`.
- The evaluator's controlled-transport smoke checks verified four result records, job identity/provenance, private report permissions, temporary queue cleanup, and nonzero missing-model failures. Those synthetic responses establish evaluator behavior, not model quality.
- Independent review found no blocking code defects.

## Live local model experiment

Host: MacBook Air M1 (`MacBookAir10,1`), 16 GiB RAM, macOS 27.0.1 build 26A434. Runtime: Bun 1.4.2, Ollama 0.33.0, installed local `gemma4:e4b` model (digest `dc35e8d9c6061baa6f0fa870975ab6932e2542b579b13ea0f199fa4bb7300c9c`). Four synthetic saved-final-transcript cases ran sequentially through the production adapter and durable notes service, using a custom fixture template and each meeting's language. No personal meeting data, physical recording, app installation, or service restart was involved.

| Case | Time | Reviewed observation |
| --- | --- | --- |
| English grounding | 90 seconds | Kept the launch date tentative, recorded keeping the free plan and rejecting premium, assigned only Bruno's explicit report commitment, and left deadlines unspecified. Checklist ownership remained open. |
| Portuguese grounding | 83 seconds | Preserved the tentative publication date; assigned the report to Bruno and left the checklist owner/deadline unspecified. |
| English, no commitments | 46 seconds | Explicitly reported no confirmed decisions or actions; redesign remained a suggestion. |
| Portuguese, no commitments | 89 seconds | Explicitly reported no confirmed decisions or actions; redesign remained a suggestion. |

No case turned the quoted sample instruction into Carla's task or the date `2030-01-01` into an assigned deadline. All four jobs completed, retained a single job, preserved notes after duplicate finalization, and recorded the final source revision. Source excerpts were useful for review, but some shortened excerpts changed terminal punctuation. The English action cited its missing deadline rather than the commitment itself. These are observed evidence-quality limitations: requested exact source excerpts and adequate support are not guaranteed by the prompt. Outputs still require review against the transcript.

One-second samples reached approximately 6.5 GiB aggregate Ollama process RSS. This includes the server and model process, is not a complete physical/GPU memory measurement, and does not establish the actual peak. `/api/ps` returned no loaded models after completion; that observation does not prove memory-pressure behavior when capture preempts generation or unload cannot be acknowledged.

Raw synthetic reports and process samples were retained outside the repository. The evaluator leaves quality as `pending-human-review`; generation success is separate from factual acceptance.

## Remaining acceptance

Real English/Portuguese capture, memory pressure and responsiveness during notes preemption, installed-app crash/restart recovery, and the full failure/refresh/localization scenarios still need acceptance on the M1 Air and M4 Pro. This experiment did not test the M4 Pro or runtime compatibility on macOS 14 or other supported OS releases. See [the acceptance scenarios](automatic-notes.md#repeatable-live-model-quality-review) and [macOS compatibility](macos-compatibility.md). Issue #8 should remain open for those outcomes and broader generated-note quality.
