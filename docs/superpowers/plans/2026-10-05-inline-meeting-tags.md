# Inline Meeting Tags Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement simple inline creation, assignment, renaming, removal and global deletion of meeting tags, without a dedicated management screen.

**Architecture:** Keep the existing `Session.tags` arrays and hashtag shortcut. Add shared normalization, explicit backend tag operations and a reusable inline editor in meeting cards and detail. Global changes use a recoverable synchronous file transaction, and tag revisions prevent stale clients from overwriting assignments.

**Tech Stack:** Bun, TypeScript, React 19, Zustand, existing JSON session files, Bun tests and Vitest/Testing Library. No new product dependencies.

**Spec:** https://github.com/augustocbx/heed-macos/issues/3, updated on 2026-10-05 following the user's inline CRUD requirement.

## Global Constraints

- No dedicated tag-management screen, page or navigation entry.
- Preserve existing hashtag-created tags and the `Session.tags` classification model.
- English source, documentation, technical logs and GitHub content; English, Brazilian Portuguese, French and German interface translations with English fallback.
- User-authored tags never change with the interface language.
- Global rename/delete preserves all unrelated meeting metadata and content.
- Implementation and validation stay in `/private/tmp/heed-issue-3`, branch `feat/issue-3-inline-tags`.
- Do not change the main checkout's `AGENTS.md`, the issue #8 worktree, private recordings or the installed application.
- No `Co-Authored-By` trailers.
- M1 Air/M4 Pro and macOS 14+ compatibility are acceptance targets; report physical-machine validation separately from automated checks.

## Review Focus

- Interrupted multi-file writes: recover before reading or mutating sessions; never expose partially applied global edits.
- Two tabs: reject stale tag writes while allowing unrelated notes, speaker and transcript edits.
- Old labels with mixed case or Unicode composition: compare normalized names without silently losing historical assignments.
- Changing a filtered tag: carry the filter to the renamed tag, or clear it after deletion, including when returning from detail.
- Large suggestion sets and save failures: keep keyboard access, unsaved input and accurate errors usable.

## Task 1: Shared normalization and safe backend tag operations

**Files:**
- Create `packages/shared/lib/tags.ts` and export from the existing `packages/shared/types/index.ts` entry point.
- Create `packages/server/lib/session-tags.ts` and `packages/server/lib/session-tags.test.ts`.
- Modify `packages/shared/types/session.ts` and `packages/server/server.ts`.
- Modify `packages/client/src/lib/tags.ts` to share normalization and support Unicode hashtags while preserving existing shortcuts.

**Interfaces:**
- `normalizeTag(value: string): string`: trim, NFC-normalize and collapse internal whitespace; preserve display case and accents. Reject empty names at mutation boundaries.
- `tagKey(value: string): string`: normalized, locale-independent lowercase comparison key. Case and canonical Unicode duplicates represent the same reusable tag.
- Export `TagMutation` from `packages/shared/types/session.ts`: `{ action: "add" | "remove"; sessionId: string; tag: string; expectedRevision: string }` or `{ action: "rename" | "delete"; tag: string; name?: string; expectedRevision: string }`.
- Export `TagSnapshot` from `packages/shared/types/session.ts`: `{ tags: Array<{ name: string; meetingCount: number }>; sessions: Session[]; revision: string }`.
- `GET /api/tags`: return the current snapshot. `POST /api/tags`: validate and apply one mutation, then return the committed snapshot.
- Existing session responses expose an optional `tagsRevision`; session patches containing tags must carry the corresponding expected revision and return HTTP 409 on a stale write.

- [ ] Write tests against synthetic session directories for Unicode/spaces/hyphens, empty names, normalized duplicates, legacy tags, assignment-only removal, global rename/delete, rename collisions and stale revisions.
- [ ] Add tests asserting notes, transcript, speakers, files, titles and unrelated tags remain unchanged; metadata-only edits must not invalidate a tag-only revision.
- [ ] Add filesystem-failure and interruption fixtures: stage every replacement before modifying originals; recover unfinished transactions before list/create/patch/delete/tag operations, or fail the request if recovery cannot finish.
- [ ] Run `bun test packages/server/lib/session-tags.test.ts`; verify the new behavior fails before implementation.
- [ ] Implement synchronous tag read/mutation functions with an injectable filesystem adapter for failure tests. Keep the commit section free of `await`, stage original/replacement files and a recovery journal, and mark commit only after all replacements succeed. Restore originals for unfinished transactions; block reads if restoration fails.
- [ ] Route existing session CRUD through transaction recovery, validate tag revisions when patching assignments, and read current metadata after parsing the request body to avoid overwriting intervening edits.
- [ ] Implement the tag routes with structured error codes for localized client errors. Validate session IDs and avoid following session symlinks. A rename to another existing normalized key is a conflict, not a merge; a case-only rename of the same tag is allowed.
- [ ] Run the server suite and commit the backend and shared behavior.

## Task 2: Client state and inline editor

**Files:**
- Create `packages/client/src/api/tags.ts`.
- Modify `packages/client/src/stores/sessions.ts` and `packages/client/src/api/sessions.ts`.
- Create `packages/client/src/components/sessions/TagEditor.tsx`, `TagEditor.module.css` and `TagEditor.test.tsx`.
- Modify `packages/client/src/components/sessions/SessionItem.tsx`, `SessionDetail.tsx`, `SessionsPage.tsx` and `TitleInput.tsx`.
- Modify `packages/client/src/lib/translations-content.ts`.
- Create focused store/filter tests under `packages/client/src/stores/` and `packages/client/src/components/sessions/`.

**Interfaces:**
- `tagsApi.list(): Promise<TagSnapshot>` and `tagsApi.mutate(mutation: TagMutation): Promise<TagSnapshot>`.
- Sessions store adds `loadTags(): Promise<void>` and `mutateTag(mutation: TagMutation): Promise<void>`; apply successful snapshots consistently to list and viewing state, and retain saved state on failure.
- `TagEditor({ session, onTagClick? }: { session: Session; onTagClick?: (tag: string) => void })`: render tag chips, an inline add input and a compact action menu. Use ordinary accessible buttons/forms and a searchable suggestion list.

- [ ] Write failing interaction tests for inline creation/reuse, multiple assignment, assignment removal, global rename with save/cancel and global deletion with name/count confirmation. Assert rendered saved state, not only mocked call counts.
- [ ] Add tests for failed saves retaining input and current saved tags, stale-write errors with reload/retry, 100 searchable suggestions, keyboard-only operation and all four interface locales preserving user-authored text.
- [ ] Add filter integration tests for rename/delete while searching and after returning from detail. Add a store test that a stale request response cannot revert a newer tag snapshot.
- [ ] Run the focused Vitest files and verify missing inline behavior causes failures before implementing it.
- [ ] Implement the API/store and shared inline editor. Keep global deletion distinct from detaching the current meeting; show the scope of global renaming before saving. Disable duplicate submissions and keep errors next to the relevant input/action.
- [ ] Render the editor in cards and detail, stop card navigation when using editor controls, and preserve tag-click filtering and the title hashtag shortcut.
- [ ] Keep active filter state synchronized with successful rename/delete snapshots; refresh tags when regaining focus to reconcile another tab's changes. Metadata updates send only the intended fields.
- [ ] Add English fallback and pt-BR/fr/de translations for every new control, scope message and error.
- [ ] Run the client suite and build, then commit the inline feature.

## Task 3: Integration validation, documentation and PR handoff

**Files:**
- Create `docs/meeting-tags.md` describing inline controls, global versus assignment-only scope, normalization, duplicate/collision rules and failure recovery.
- Update the relevant README link and this plan's execution status.

- [ ] Run `bun test packages/server/lib`, `NODE_OPTIONS=--no-experimental-webstorage bun run --cwd packages/client test`, and `bun run build` with Bun on PATH.
- [ ] Run the Python policy tests and installer syntax checks from `.github/workflows/ci.yml`; report any pre-existing failure explicitly.
- [ ] Use only synthetic meetings for a browser smoke test on separate ports and isolated application data. Verify create/reuse, rename/delete across several meetings, assignment removal, reload, text-plus-tag filtering and localization. Do not start capture, model downloads or the installed application's services.
- [ ] Review the complete branch diff and obtain an independent review of persistence, concurrency and keyboard accessibility. Resolve findings and rerun the checks affected by fixes.
- [ ] Record physical-machine and OS coverage honestly; automated checks on one host do not satisfy both-Mac acceptance.
- [ ] Review status, staged/unstaged diffs and outgoing commits; commit and push all issue-related repository work. Open an English PR referencing #3 and describe validation and remaining manual checks.
- [ ] Fetch the PR branch and verify remote SHA equals local HEAD, with a clean issue worktree and no outgoing commits.
- [ ] Stop and verify only services started for this worktree. Preserve any retained local evidence outside it.
- [ ] Remove the clean worktree from outside it with `git worktree remove`, verify it is absent from `git worktree list`, and provide the PR link for merge. Do not delete the remote PR branch or force removal.

## Execution status

The plan has been checked against issue #3. The worktree and dependencies are prepared. Baseline verification passed: 44 server tests, 73 client tests and the production interface build. Product implementation awaits the plan-review gate required by the `writing-plans` skill.
