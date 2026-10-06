# Label-scoped meeting chat implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Ask grounded questions across explicitly eligible local meetings without cross-scope leakage.
**Architecture:** A scoped service reuses answerMeetingQuestion and installed local model transport; source snapshots and separate scope-keyed ledgers constrain retrieval and history. A general page previews server-authoritative scope and opens citations in existing meeting detail.
**Tech Stack:** Bun, TypeScript, React, existing atomic JSON and four-locale dictionaries.
**Spec:** docs/superpowers/specs/2026-10-05-issue-17-label-chat-design.md

## Global constraints

- English project content; preserve en/pt/fr/de interface locales; no new dependencies.
- Dedicated issue worktree; synthetic isolated state; no physical capture or user model/config changes.
- Empty selection never expands to all meetings; all is explicit; any is default.

## Review focus

- Excluded overlapping secret markers must never enter prompts, history or citations.
- Membership/revision edits during generation discard results and retain historical evidence.
- Two tabs and transport retries require revision guards and idempotent sends.
- Large corpora expose partial coverage and avoid unsupported exhaustive claims.
- Imported complete sessions participate naturally through the existing session store.

### Task 1: scope and durable worker

Files: shared/types/library-chat.ts, server/lib/library-chat.ts and library-chat.test.ts.
Interfaces: preview(scope): LibraryChatPreview; get(scope): LibraryChatContext; command(scope, ChatCommand): LibraryChatThread; tick/preempt/busy mirror existing chat worker. Reuse answerMeetingQuestion with eligible Session[] only.
- [x] Write failing tests for any/all/empty/all, exact snapshot pinning, secret isolation across scopes/history, in-flight changes, restart/clear/cancel/retry, long corpus and malformed paths.
- [x] Run Bun tests and observe missing behavior, implement immutable source snapshots and guarded durable worker, then rerun green.

### Task 2: HTTP and resource scheduling

Files: server/server.ts and server/lib/library-chat.http.test.ts.
Routes: POST /api/library-chat/context {scope}; POST /api/library-chat/command {scope,command}. A third POST /api/library-chat/source route validates a citation against the current scope snapshot before returning its meeting. All routes share the desktop origin guard. Existing /api/chat/models lists installed compatible models.
- [x] Write failing real-server scoped marker tests, stale/hostile requests, restart and worker serialization.
- [x] Wire library chat into notes/tasks/single-chat busy guards, recording preemption and shutdown; run HTTP tests green.

### Task 3: general interface and citation navigation

Files: client/components/chat/LibraryChat.tsx, api/library-chat.ts, stores/ui.ts, App.tsx, layout/Nav.tsx, SessionDetail.tsx, translations-library-chat.ts and tests.
- [x] Write failing UI tests for explicit scope, searchable multiple labels, any/all preview, new context on narrowing, historical/partial coverage, cancellation/retry/clear and correct citation source navigation.
- [x] Implement current-scope persistence and request-sequence guards; add four locales and source revision validation; rerun interface tests and build.

### Task 4: verification and handoff

- [x] Run the complete workflow server/interface/Python/syntax/native commands; document remaining physical-model/Mac acceptance.
- [x] Review full status/diffs, commit English changes without coauthor, notify root for independent review/publish/merge. Rebased onto merged #16 and #14 before final checks.
