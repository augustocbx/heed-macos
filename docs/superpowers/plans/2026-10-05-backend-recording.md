# Backend Recording Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans and test-driven-development. The user approved implementation, independent QA, finding fixes and merge after exact-head CI succeeds.

**Goal:** Make issue #4 recording and durable finalization independent of browser ownership.

**Architecture:** A filesystem-backed RecordingCoordinator serializes acknowledged lifecycle transitions through capture/finalization/persistence adapters. One live worker broadcasts authoritative snapshots to the menu and browser subscribers.

**Tech Stack:** Bun/TypeScript, React/Zustand, existing native Swift capture/menu, atomic JSON persistence, Bun/Vitest.

**Spec:** ../specs/2026-10-05-backend-recording-design.md

## Global Constraints

- English repository content; preserve en/pt-BR/fr/de interface translations.
- Keep private data and existing runtime untouched; synthetic tests and isolated application directories.
- No Co-Authored-By trailers. All work stays in this issue's dedicated worktree.
- Save only final en/pt transcription with real WAV timestamps and manual speaker choices.
- Every mutation retains loopback/origin checks; application binds to 127.0.0.1.

## Review Focus

- Save failure after successful ASR must remain retryable without duplicating sessions.
- A stale stop must never stop a later capture.
- Client disconnect and reconnect cannot duplicate or cancel live ASR.
- Speaker edits made while stopping must be durably reflected in final names.
- Maintenance and unexpected native exits cannot leave a false recording status.

## Task 1: Durable coordinator

**Files:** shared/types/recording-coordinator.ts, server/lib/recording-coordinator.ts and recording-coordinator.test.ts (under packages).

**Interfaces:** RecordingCoordinator.snapshot/start/stop/retry/rename/live/subscribe/setMaintenance/captureFailed; RecordingAdapter.start/stop/finalize/save. Shared snapshot and final capture contracts are the server/client boundary.

- [x] Write and run failing tests for serialized commands, stale targets, persisted ASR retry, restart recovery, speaker reconciliation and maintenance.
- [x] Implement atomic manifest checkpoints, receipt validation and bounded snapshot fan-out.
- [x] Run the coordinator/server suite and commit the complete module.

## Task 2: Server/native lifecycle integration

**Files:** packages/server/server.ts, server lifecycle HTTP tests, desktop/macos menu/control/policy files, installer guards.

**Interfaces:** Adapt existing native start/stop/finalizer and notesService.create to RecordingAdapter. GET /api/recording/status; revision-checked speakers; retry/maintenance mutations; existing recording and desktop controls delegate to the coordinator.

- [x] Write failing no-tab lifecycle/fan-out/guard tests; run to establish missing behavior.
- [x] Move live ASR worker ownership out of SSE, start independently after capture readiness, replay latest snapshot to subscribers.
- [x] Wire durable saving, failure/quota handling, menu acknowledgments and quit/update guards.
- [x] Run server and native tests; commit after integration with Task 3.

## Task 3: Browser subscriber and QA

**Files:** packages/client/src/api/recording.ts, hooks/useRecording.ts, hooks/useDesktopControl.ts, recording store, speaker persistence helpers and client tests.

**Interfaces:** Browser commands carry request/meeting IDs. Snapshot subscriber restores elapsed time, segments, processing status and saved session; browser never creates the finished recording session.

- [x] Write failing tests for server-saved result, reload attachment, two tabs and stale speaker writes.
- [x] Implement snapshot synchronization and subscriber visualization; remove browser-owned finalization.
- [x] Run full CI command set, independent review and synthetic API/UI QA; correct findings with regression tests.
- [ ] Push all repository work, verify remote HEAD and CI, stop issue services, safely remove worktree, merge PR, then update only proven issue criteria.
