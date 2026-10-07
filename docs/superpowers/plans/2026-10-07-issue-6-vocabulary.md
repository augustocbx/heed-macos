# Implementation plan

1. Add bounded vocabulary types, validation and atomic local storage; verify CRUD/import/export/restart/concurrency with failing then passing tests.
2. Extend existing Python live/file/final Whisper calls with validated frozen snapshots and per-run provenance. Keep native paths honestly unsupported. Verify option forwarding and malformed rejection.
3. Freeze selection at capture and manual-transcription admission, preserve recovery/candidate/generation metadata, and test portable omissions.
4. Add Settings management and explicit recording/retranscription selection; translate strings in the four supported locales and verify UI behavior.
5. Extend existing consented benchmark tooling for baseline/enabled vocabulary metrics; coordinate actual model resource runs with the coordinator.
6. Run relevant suites/build, review final diff and record acceptance limitations. Coordinator owns Git and service/worktree handoff.
