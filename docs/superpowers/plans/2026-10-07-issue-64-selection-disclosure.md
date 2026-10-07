# Issue #64: clean selection and honest disclosures Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. The approved design uses one focused issue implementer at a time, coordinator-owned Git/integration, and independent review.

**Goal:** Deliver one organized AI Settings area with local/provider choice and evidence-backed disclosures.

**Architecture:** Reuse provider, budget and measured-profile contracts in a shared disclosure component. Feature-specific content review is explicit and the four existing locales remain complete.

**Tech Stack:** Bun/TypeScript, React, Bun SQLite, macOS Keychain, Python/native transcription.

**Spec:** [../specs/2026-10-07-issues-64-67-ai-selection-design.md](../specs/2026-10-07-issues-64-67-ai-selection-design.md). Read its full content and the exact acceptance checklist before execution.

## Global Constraints

- Local operation remains available without keys, internet, or API charges.
- Project source, identifiers, documentation, technical evidence, commits, and pull requests are in English.
- The English, Brazilian Portuguese, French, and German interfaces remain complete.
- No meeting bots, audio uploads, private fixture data, or automatic paid/provider fallback are introduced.
- Default optional LLM concurrency is one.
- Implement every issue in a dedicated Git worktree with its own issue branch; preserve unrelated services and modified root AGENTS.md.
- Existing source/citation validation, task review, transcript guards, and capture/finalization priority remain required.
- No new production dependencies are planned; use Bun, React, SQLite, existing Keychain storage, and existing Python/native engines.

## Review Focus

- A remote credential existing must not automatically select or authorize paid processing (Task 1).
- A measured profile with a different digest/context/host is not evidence for the selected settings (Task 1).
- Browser history/source edits can stale a consent dialog while it remains open (Task 1).
- Narrow screens, keyboard focus and translated labels must keep selectors and errors usable (Task 2).
- Stored keys must never be revealed/recovered in browser state (Tasks 1–2).

---

### Task 1: shared disclosure, settings selectors and content review

**Files:** Create `packages/client/src/components/ai/{AiSettings,AiModelDisclosure,AiContentReview}.tsx`, `AiSettings.module.css`, related tests; modify `settings/PermissionsPage.tsx`, `ai-notes/AutomaticNotesSettings.tsx`, `models/ModelPicker.tsx`, `chat/{MeetingChat,LibraryChat}.tsx`, `tasks/TasksPanel.tsx`, manual notes call sites, API modules, `lib/translations-ai.ts`, `lib/i18n.ts`, and existing locale tests.

**Interfaces:** Produce `AiSettings()` consuming safe configuration/catalog/resource snapshots; `AiModelDisclosure({selection, model, price, profile, resourcePolicy})`; `AiContentReview({preview, onAuthorize, onCancel})`. Notes/tasks/chat each expose the same AiSelection controls; library chat uses chat selection with separately selected source scope. Use shared AiSpendingSettings/AiUsageView from #66 and complete source-bound preview/authorize API from #65.

- [ ] Write behavioral tests: local no-key remains default/usable; unsupported capabilities disabled with reasons; setting/key save performs no content request; entered key cleared and stored key never returned/revealed; provider benefits/tradeoffs precede registration; exact selected text/provider/model/cost reviewed before upload; source/model changes invalidate preview; matched measured vs estimated/download/incremental/total/ASR distinctions; unknown profile shows Not measured; all four locales cover new controls/status/errors; link live setting and explain conditional savings/final peaks.
- [ ] Run `bun run --cwd packages/client test -- src/components/ai src/components/ai-notes/AutomaticNotesSettings.test.tsx src/components/chat src/components/tasks src/lib/translations-ai.test.ts` before implementation; confirm the new tests fail for the intended missing behavior while existing controls remain valid.
- [ ] Implement one AI settings section reusing existing visual tokens/cards and accessible native controls; essential selection/status first, expandable comparison/pricing/privacy/resource/usage details below. Keep automatic template/language controls nearby; eliminate conflicting duplicate selections. Add dated official links, allowance/credit/subscription caveats, and low-cost/smaller free options without paid autoselection. Resource model/context changes remain visible and opt-in. Connect feature UI to exact server-created review and guarded remote generation.
- [ ] Run the same command; require zero failures. Inspect the actual diff and record criterion evidence.
- [ ] Coordinator commits the verified deliverable with `feat(ai): organize provider selection and source review`; no Co-Authored-By trailer.

### Task 2: integrated browser acceptance and delivery evidence

**Files:** Create `scripts/qa/ai-providers-ui.mjs`, `docs/qa/issues-64-67-acceptance.md`; update the exact acceptance checklist and approved design status after verified outcomes.

**Interfaces:** Browser harness starts only owned API/client services in isolated APP_DIR/ports, uses synthetic provider contracts, and records exact commit/configuration/screenshots. Acceptance report maps every 64.x–67.x criterion to files, tests, measured profiles and independent review. Coordinator owns final commit/push/PR/worktree cleanup.

- [ ] Write behavioral tests: 320, 375, 768, 1280 and 1920 px plus 200% zoom; four locales; keyboard tab/focus, control labels, details, error associations and consent invalidation; key safety; no request on provider/key selection; budget/concurrent/unknown/uncertain usage flows; capture-priority interruptions; safe provenance in notes/tasks/chat; baseline local workflows survive.
- [ ] Run `node scripts/qa/ai-providers-ui.mjs --output-dir /tmp/heed-ai-ui-evidence` before implementation; confirm the new tests fail for the intended missing behavior while existing controls remain valid.
- [ ] Implement the runnable browser harness, then execute it through its documented full acceptance command with synthetic fixtures. Run client tests/build and full server library suite; affected Python/native checks and both-Mac measurements must already be recorded. Perform independent integrated diff/criterion review and resolve actionable findings. Mark only evidence-confirmed criteria satisfied. Commit/push all intended work; fetch remote and verify equal HEAD; stop/verify owned services; preserve evidence externally; remove each clean pushed worktree from outside and verify git worktree list. Open a coordinated reviewable PR or dependency-linked PRs without merging or claiming any unverified criterion.
- [ ] Run the same command; require zero failures. Inspect the actual diff and record criterion evidence.
- [ ] Coordinator commits the verified deliverable with `test(ai): verify integrated provider selection and acceptance`; no Co-Authored-By trailer.

**Issue coverage:** 64.1–64.7 → Tasks 1–2, with actual profile evidence supplied by #67 and current cost metadata supplied by #66.
