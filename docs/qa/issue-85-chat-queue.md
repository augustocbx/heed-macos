# Issue 85: local AI queue admission and waiting status

The background notes/task admission checks now yield while an explicit meeting or label-scoped chat request is pending. The checks are synchronous and apply to all worker entry points; priority does not depend on interval registration order. Active generation may finish and existing audio preemption still applies. When both chat queues are waiting, the existing timer checks meeting chat first. This is priority over automatic work, not a new FIFO contract across all chat threads.

Read-time waiting status names recording, transcription, notes generation, task suggestions, another chat answer or queue admission. It is optional for compatibility, does not change chat/source revisions, and is stripped before durable chat/notes writes. The notes fallback includes other local AI work rather than implying unfinished transcription. The four UI locales remain supported.

## Validation

- Before the correction, the strengthened production HTTP regression started a second task before the accepted chat question (`taskCalls: 2`, expected `1`); the live-blocker regression also failed because waiting status was absent.
- After the correction, real isolated HTTP tests passed for meeting and label-scoped chat with both automatic notes and tasks pending. The accepted question started immediately after the held task, ahead of background work; maximum simultaneous generation remained one and citation revision/quote were preserved.
- Server suite after integration with main `74a5832`: 616 tests passed across 91 files, 3,467 assertions, zero failures.
- Interface suite: 321 tests passed across 60 files using the CI-compatible `NODE_OPTIONS=--no-experimental-webstorage`.
- Main integration preserves update-maintenance admission guards alongside chat priority and initializes the live waiting-status projection after recording maintenance recovery.
- Client typecheck and production build passed. The existing bundle-size warning remains.
- Component regressions cover blocker updates through actual polling, historical-answer preservation, cancellation identity and waiting-note status. Existing queue/preemption/history/retry/source guards remain covered by the full suites.

All execution used disposable synthetic libraries and isolated transports. No installed application, personal meeting, recording, or existing desktop service was changed. Actual installed-model latency/semantic output and physical-device acceptance remain separate checks on the MacBook Pro and MacBook Air; the automated queue tests do not claim those outcomes. This PR references #85 without closing its physical acceptance gate.
