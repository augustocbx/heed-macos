# Meeting Tasks Implementation Plan

> **For agentic workers:** Execute this approved plan inline with test-driven development and independent review.

**Goal:** Create evidence-grounded, selectively accepted, durable local meeting tasks.

**Architecture:** Dedicated atomic store and local generation queue with revision checks; HTTP commands wrap synchronous task mutations. React task panels expose the same store globally and within meeting details.

**Tech Stack:** Existing Bun, TypeScript, React, Ollama transport, Vitest/testing-library.

**Spec:** `docs/superpowers/specs/2026-10-05-meeting-tasks.md`

## Global Constraints

English project-facing source/docs; four supported UI locales; no new dependencies; local-only model transport; dedicated issue worktree; synthetic isolated validation data; never automatic acceptance or external publishing.

## Review Focus

- Two tabs and retries must return one accepted task per suggestion, including after deletion.
- Persistence failures must leave suggestions and accepted tasks recoverable without partial acceptance.
- Transcript changes during generation must reject stale results and keep accepted tasks immutable.
- Relative/fabricated dates must remain nullable; explicit ISO dates must be cited.
- Meeting deletion/audio expiry must preserve tasks and accurately describe unavailable sources.

### Task 1: Durable tasks and evidence

Files: `packages/shared/types/tasks.ts`, `packages/server/lib/meeting-tasks.ts`, `packages/server/lib/meeting-tasks.test.ts`.
Interface: `MeetingTasksService.snapshot(sessionId?)`, `accept(sessionId, revision, items)`, `dismiss`, `update`, `delete`, `tick`, `retry`.

- [x] Write failing tests for evidence/date validation, subset acceptance, retry/two-store idempotency, persistence failure, dates/completion, source loss and stale generation.
- [x] Run the focused Bun suite and confirm the feature is absent.
- [x] Implement the atomic store, guarded queue and source projection.
- [x] Run focused suite; confirm durable state after reloading the service.

### Task 2: Routes and local generation

Files: `packages/server/lib/tasks-http.ts`, `packages/server/lib/tasks-http.test.ts`, `packages/server/lib/task-generation.ts`, `packages/server/server.ts`.
Interface: `tasksResponse(request, service)` and `generateTaskSuggestions(session, signal)` via installed loopback-only Ollama transport.

- [x] Write failing tests for forbidden origins, malformed commands, retries and JSON model evidence.
- [x] Run focused tests; implement routes and scheduler/resource preemption.
- [x] Confirm no implicit acceptance and bounded model calls.

### Task 3: Meeting/global task review

Files: `packages/client/src/components/tasks/*`, `packages/client/src/api/tasks.ts`, navigation/App/SessionDetail, `packages/client/src/lib/translations-tasks.ts`.
Interface: `TasksPanel({session?, onSeek?})` backed by task API.

- [x] Write failing UI tests for accepting two of five, editing and clearing dates, none selection, failure/retry and four locales.
- [x] Run Vitest red; implement UI and source navigation without overwriting dirty edits on polling.
- [x] Run client suite and production build.

### Task 4: Review and handoff

- [x] Run complete CI commands, inspect every failure and fix findings.
- [x] Obtain independent code review and address findings.
- [x] Record acceptance evidence and physical-validation gaps.
- [ ] Commit/push, verify exact remote head, create English PR with `Refs #15`.
- [ ] Leave clean branch to root for review, exact-head CI gate and safe worktree cleanup before merge.
