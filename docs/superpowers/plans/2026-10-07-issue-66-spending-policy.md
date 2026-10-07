# Issue #66: predictable provider spending Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. The approved design uses one focused issue implementer at a time, coordinator-owned Git/integration, and independent review.

**Goal:** Bound optional provider spending and show a private auditable usage ledger.

**Architecture:** Dated model metadata feeds conservative whole-job estimates. SQLite reservations precede dispatch and retain uncertain liability across cancellation, retries, restarts and period transitions.

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

- Cache writes may exceed ordinary input prices, and cached input/reasoning can overlap totals (Task 1).
- A second concurrent request cannot reserve the same remaining funds (Task 2).
- A dispatched cancelled/timed-out/rejected response may still incur charges (Task 2).
- Midnight or a policy change must not erase an unfinished reservation (Task 2).
- Unknown/stale prices or missing usage must never become zero-cost claims (Tasks 1–3).

---

### Task 1: dated presets and conservative price/category estimates

**Files:** Create `packages/shared/types/ai-cost.ts`, `inference/{catalog,cost}.ts`, `inference/cost.test.ts`; export shared types.

**Interfaces:** Produce `AiPriceSnapshot {provider, model, currency: "USD", verifiedAt, sourceUrl, dataUrl, categories, contextTiers, premiums}`; category prices use integer micro-USD per million tokens. `estimateAiPlan(plan, priceSnapshot, now): AiCostEstimate` returns known/stale/unknown state, conservative bound in micro-USD, category assumptions, per-call bounds and uncertainty. `AiPreset` binds exact capability/price metadata and labels local/free-quota/promotional-credit/paid distinctly. Default local cost is zero API charges, not zero device resources.

- [ ] Write behavioral tests: UTF-8 multilingual/system/schema input is bounded conservatively rather than characters/4; all four planned calls are included; cold cache/write and peak/context/region premiums use worst applicable rate; reasoning/output and cached/total overlap are not double counted; missing unsupported categories/price are unknown; verification older than 30 days is stale; subscriptions do not establish API entitlement.
- [ ] Run `bun test packages/server/lib/inference/cost.test.ts` before implementation; confirm the new tests fail for the intended missing behavior while existing controls remain valid.
- [ ] Implement officially verified exact model/capability catalog entries without paid autoselection. Use a provider-proven conservative local token bound when available; otherwise label a declared-context estimate as conditional on accepted input. Separate token-fit evidence from whole-attempt billing coverage. Reject known context overflow and enforce byte/output limits without truncation. Unproven fit is disclosed; unknown whole-attempt cost requires the existing single-use explicit exception and durable unknown liability, never a claim that strict thresholds bound its charge. Known bounds exceeding thresholds stay blocked. Never send text to a remote token-count service without separate consent. Store dated official URLs, eligibility/rate/data caveats, and evaluate cache/batch economics while leaving unsupported/unbeneficial hosted caching/batching disabled.
- [ ] Run the same command; require zero failures. Inspect the actual diff and record criterion evidence.
- [ ] Coordinator commits the verified deliverable with `feat(ai): add dated presets and conservative usage estimates`; no Co-Authored-By trailer.

### Task 2: atomic durable reservations and attempt settlement

**Files:** Create `inference/{budget,usage}.ts`, `inference/budget.test.ts`; modify `inference/runtime.ts`, `http.ts`, and domain attempt handling.

**Interfaces:** Produce `AiBudgetPolicy {jobLimitMicroUsd, periodLimitMicroUsd, periodDays, periodStart, maxRemoteAttempts, unknownCost: "block" | "explicit"}`; validated periodDays is 1–366, maxRemoteAttempts is 1–3 with default one, and limits are nonnegative safe integers. `AiBudget.reserve(plan, estimate, decision): AiReservation`, `.dispatch(reservationId, callId, attemptId)`, `.settle(attemptId, outcome)`, `.cancelUnsubmitted(reservationId)`, `.recover()`, `.snapshot(): AiUsageSnapshot`. SQLite transactions deduplicate plan/call/attempt IDs. Unknown override is single-use and never represented as enforcing a known cap. Remote defaults deny spending: both thresholds are zero until configured.

- [ ] Write behavioral tests: concurrent admission cannot exceed aggregate cap; whole-job reservation includes calls and authorized retry; each dispatched uncertain attempt retains conservative liability; predispatch cancel releases only unused allocation; 429/missing usage/rejected output retains uncertainty unless no-charge evidence exists; duplicate settlement is idempotent; crash recovery never resubmits; period transitions and lowered limits retain existing liability; unknown price requires explicit override.
- [ ] Run `bun test packages/server/lib/inference/budget.test.ts packages/server/lib/inference/jobs.test.ts` before implementation; confirm the new tests fail for the intended missing behavior while existing controls remain valid.
- [ ] Implement private SQLite ledger under APP_DIR/ai, containing metadata/counts/price snapshots but no keys/transcript text. Runtime reserves before any call and settles in finally even when domain publication fails. Maximum automatic attempts remain one; a user-authorized retry within the configured 1–3-attempt bound has a new durable attempt/reservation and cumulative job charges. Counters and held liabilities never reset just because a queue goes waiting. Add GET `/api/ai/usage` and guarded POST `/api/ai/budget`.
- [ ] Run the same command; require zero failures. Inspect the actual diff and record criterion evidence.
- [ ] Coordinator commits the verified deliverable with `feat(ai): enforce durable job and period spending reservations`; no Co-Authored-By trailer.

### Task 3: spending controls and usage view

**Files:** Create `packages/client/src/components/ai/{AiSpendingSettings,AiUsageView}.tsx`, matching tests, `packages/client/src/lib/translations-ai.ts`; modify `api/ai.ts` and `lib/i18n.ts`.

**Interfaces:** Produce `AiSpendingSettings({policy, onSave})` and `AiUsageView({snapshot})`; client API exposes budget save and usage GET. `AI_TRANSLATIONS` follows existing English-key and pt-BR/fr/de dictionary conventions.

- [ ] Write behavioral tests: all four locales explain estimate vs reported usage vs invoice; account-wide cap limitations are visible; limits/currency/period have accessible labels; uncertain charged cancellations and retries remain visible; stale/unknown pricing and quota errors offer waiting/change-settings/local operation without switching provider or purchasing access.
- [ ] Run `bun run --cwd packages/client test -- src/components/ai/AiSpendingSettings.test.tsx src/components/ai/AiUsageView.test.tsx src/lib/translations-ai.test.ts` before implementation; confirm the new tests fail for the intended missing behavior while existing controls remain valid.
- [ ] Implement compact cards and a content-free local usage table, with inline validation/error/status feedback. Include free-quota versus credit versus paid distinctions and official dated links. The final #64 Settings section consumes these components.
- [ ] Run the same command; require zero failures. Inspect the actual diff and record criterion evidence.
- [ ] Coordinator commits the verified deliverable with `feat(ai): expose spending policy and auditable local usage`; no Co-Authored-By trailer.

**Issue coverage:** 66.1–66.3 → Tasks 1 and 3; 66.4 → Tasks 2–3; 66.5 → Task 1 and #65 immutable source plan; 66.6 → Tasks 2–3; 66.7 → all tasks.
