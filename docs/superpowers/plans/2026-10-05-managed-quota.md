# Managed Meeting Quota Implementation Plan

> Use executing-plans and test-driven-development. The user authorized implementation, QA corrections and merge after green exact-head CI.

**Goal:** Make one persisted device quota govern all managed meeting data and working reservations.

**Architecture:** A synchronous authoritative quota service counts regular managed files, tracks durable remaining reservations and protects active/pending data. Settings previews media cleanup before applying a reduction. Storage providers use the same service.

**Tech Stack:** Bun, atomic JSON, React, four existing locales.

**Spec:** GitHub issue #27 and the approved #18 storage contract.

## Global Constraints

- Default 2,000,000,000 integer bytes; valid safe integers from 1,048,576 through 8,000,000,000,000 bytes.
- Count transcripts, metadata, tasks, chat, media, indexes and staging; exclude credentials, logs, models, app binaries and external caches.
- Protect text, active recording/finalization, unresolved conflicts and pending uploads. Never remove remote objects during local cleanup.
- Dedicated issue worktree; English source/docs; en, pt-BR, fr and de interface copy.

## Review Focus

- Concurrent jobs must not reserve the same allowance.
- A reservation survives restart without treating staged file bytes as additional unused reservation.
- Changed file usage invalidates a destructive preview.
- Protected-only usage rejects reductions and preserves the existing limit.
- Symlinks and overlapping managed roots cannot inflate accounting or authorize deleting external files.

## Task 1: Authoritative accounting and reservations

**Files:** packages/server/lib/managed-quota.ts, managed-quota.test.ts; packages/shared/types/storage.ts.

**Interfaces:** ManagedQuota.snapshot(), reserve(id, bytes, paths), release(id), preview(limit), apply(limit, token); configuredManagedLimit(value). Snapshots expose limit/used/reserved/protected/reclaimable/available and category totals. Reservations count max(0, promised allocation minus existing assigned files).

- [x] RED tests for file accounting, durable allocation, concurrent claims, unsafe paths and reduction review.
- [x] Implement counting, atomic ledger and reviewed media eviction.
- [x] Run service tests and commit.

## Task 2: Recording and persistence integration

**Files:** packages/server/server.ts, app-config.ts, audio-retention.ts, persistence service adapters, installer configuration.

- [x] RED HTTP tests for default/preservation, settings origin checks, protected reduction and fresh status.
- [x] Replace fixed audio budget with shared accounting/reservations for capture, import and temporary work; protect finalization output.
- [x] Persist default on missing/invalid legacy settings and preserve valid preferences during upgrade.
- [x] Validate full server suites and native guards.

## Task 3: Settings and final QA

**Files:** client storage settings/API/locales and focused interaction tests; documentation.

- [x] RED tests for save/reset/preview confirmation, rejected values and accessible four-locale controls.
- [x] Implement category usage, reclaimable preview and reviewed apply flow.
- [x] Run complete local CI commands and independent review; correct all Important findings.
- [ ] Push and verify exact-head hosted CI.
- [ ] Stop services, safely remove worktree, merge, then mark only evidenced issue acceptance criteria.
