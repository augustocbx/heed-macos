# Issue #101 validation record

The native menu now uses one readiness decision for its summary, Start availability, and immediate recovery action. The installed version appears once in the main menu. Automatic recording, settings and permissions, updates, and diagnostics have separate one-level groups.

| Check | Result |
| --- | --- |
| Native `--build-only` compile and self-tests | Passed. Includes main-menu grouping, recording-action visibility, the disabled-Start/missing-permission regression, retained-recording recovery, active recording/processing priority, serialized permission reporting, update states, and all four locale dictionaries. |
| Update client fixture self-tests | Passed. A new check clears the previous completed phase from the interim display. |
| Server tests | 865 passed, 0 failed. |
| Client tests | 520 passed, 0 failed with `NODE_OPTIONS=--no-experimental-webstorage`; Node 25's experimental global storage caused 40 unrelated JSDOM failures without this setting. |
| Client production build | Passed. Vite reported its existing large-chunk advisory. |
| QA permission fixture tests | 2 passed. The isolated helper rejects malformed state and clears a synthetic warning after an explicit recheck. |
| Instrumented pre-change baseline | The test-only patch applies cleanly to commit `a4a0e982704a43d7381a9cbdfcf7b425b811cee6`; its native binary compiled and passed `--self-test`. This establishes a reproducible way to render old states, not visual acceptance by itself. |
| Isolated QA update transaction | The local 0.1.0 → 0.1.1 fixture completed; replacement, a matching permission report, and five synthetic data digests verified. A synthetic denied microphone and screen report produced `attention` with both missing permissions; a later authorized report produced `authorized` with an empty missing list. This transaction was started through the CLI fixture, not the native menu. |

Native before/after screenshots for ready idle, recording, processing, unavailable service, update in progress, update complete, and permission attention remain **pending**. Computer Use timed out twice when binding the separate, windowless QA status app (`timeoutReached`, code `-10005`), so there is no observed menu click or screenshot evidence. The desktop was in an active Google Meet during the later QA attempt; the session was left undisturbed. Keyboard navigation, VoiceOver, long-label fit in English/Brazilian Portuguese/French/German, and fit across supported Mac display sizes/scaling remain **pending**. The observed display was 3840×2160 physical, 1920×1080 logical; that observation does not establish menu fit.

After the PR branch was integrated with the newer `main`, the isolated native build and self-tests passed again. The review findings about a fresh but unready controller, update-row identity during refresh, and a transient message obscuring a blocker were fixed. The older baseline binary ignores synthetic `menu-state.json`, so the documented older-binary launch is not evidence for the seven before states. A later isolated QA run again failed to bind the menu through Computer Use; it was stopped without changing the installed app. These checks still need a supported native interaction path and recorded observations before acceptance.

The two disposable QA processes were stopped and verified absent. No production Heed process, service, recording, privacy permission, or saved meeting data was changed for this validation. Follow [the isolated QA procedure](README.md) on a desktop available for interaction, then add the requested screenshots and a tested display/locale/accessibility matrix before treating the issue as accepted.
