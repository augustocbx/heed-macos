# Issues #64–#67 coordinated implementation

The user approved the architecture on 2026-10-07. The user approved this plan. Product implementation is in progress, beginning with #65.

Execution uses one focused issue implementer at a time and independent review, with coordinator-owned shared Git operations. Independent investigations may run separately; overlapping writes and shared tests are serialized.

## Order and branches

| Order | Plan | Worktree and branch | Dependency |
| --- | --- | --- | --- |
| 1 | [#65 provider inference](2026-10-07-issue-65-provider-inference.md) | `.claude/worktrees/issue-65-ai-providers`, `feat/issue-65-ai-providers` | Current `origin/main` baseline |
| 2 | [#66 spending policy](2026-10-07-issue-66-spending-policy.md) | `.claude/worktrees/issue-66-ai-spending`, `feat/issue-66-ai-spending` | Validated #65 HEAD |
| 3 | [#67 resource policy](2026-10-07-issue-67-resource-policy.md) | `.claude/worktrees/issue-67-ai-resources`, `feat/issue-67-ai-resources` | Validated #66 HEAD |
| 4 | [#64 selection/disclosure](2026-10-07-issue-64-selection-disclosure.md) | `.claude/worktrees/issue-64-ai-selection`, `feat/issue-64-ai-selection` | Validated #67 HEAD |

Create each worktree before changing its issue files or starting development services. Do not expose remote inference as complete until all four deliverables are integrated. A final coordinated PR may include the dependency commits; preserve each issue branch and its validation evidence.

## Execution prerequisites

- Read approved spec, exact acceptance checklist, target issue plan, AGENTS.md and CONTRIBUTING.md before implementation.
- Establish a clean baseline in the existing #65 worktree: `bun install --frozen-lockfile`, `bun run --cwd packages/client test`, `bun run build`, `bun test packages/server/lib`. Record preexisting failures separately; preserve lockfiles and unrelated user work.
- Verify provider API/capability/pricing documentation live before catalog/adapter implementation. No credential entry or personal-content live requests are authorized.
- Verify compatible runtime, native helpers, permissions and model availability on M1 Air and M4 Pro before profiling. Run expensive/shared host work serially and use owned services.
- Every task follows failing behavior test, implementation, focused passing verification, actual diff review and coordinator commit. No source edits begin until plan review completes.

## Exact acceptance mapping

| Criterion | Owning tasks | Evidence required |
| --- | --- | --- |
| 64.1 | 64/T1; 67/T3 | Matched estimated/measured ranges; separate download/LLM/ASR/total metrics |
| 64.2 | 64/T1; 67/T3 | Reproducible dated profile; unknown/mismatch UI; no double-counting |
| 64.3 | 64/T1 | Four-locale plain advantage disclosure |
| 64.4 | 64/T1; 65/T3; 66/T1 | Adjacent tradeoffs, exact source review, current dated pricing/privacy links |
| 64.5 | 64/T1; 66/T1; 67/T3 | Free/smaller/local and verified inexpensive options, no paid autoselection |
| 64.6 | 64/T1 | Live-transcription link, conditional residency/final-peak explanation |
| 64.7 | 64/T1–2; 65/T2–3 | Four locales, accessibility, local/no-key and explicit content choice |
| 65.1 | 65/T1 | Named/custom adapter and capability fixtures |
| 65.2 | 65/T2–3; 64/T1 | Feature selection and durable/portable safe provenance |
| 65.3 | 65/T1–2 | Default local guards, remote HTTPS and deliberate endpoint trust |
| 65.4 | 65/T2; 64/T1 | Protected credentials lifecycle, content-free validation, secret exclusions |
| 65.5 | 65/T3; 64/T1 | Immutable exact-content authorization and excluded-marker requests |
| 65.6 | 65/T3; 66/T2; 67/T1–2 | Abort/retry/rate feedback and cost/resource admission without fallback |
| 65.7 | 65/T3; 64/T2 | Capture preemption, durable identity, revision/language/source/review regressions |
| 65.8 | 65/T1,T4 | Each adapter contract plus documented opt-in synthetic live checker |
| 66.1 | 66/T1,T3; 64/T1 | Capability-backed dated preset metadata and visible caveats |
| 66.2 | 66/T1,T3; 64/T1 | Quota/credit/paid/subscription/eligibility/data/rate distinctions |
| 66.3 | 66/T1–3 | Scoped conservative multi-call category estimates; usage/bill distinctions |
| 66.4 | 66/T2–3 | Job/period/concurrent/retry/unknown budget controls and local audit |
| 66.5 | 66/T1; 65/T3 | Bounded necessary scope and documented cache/batch evaluation |
| 66.6 | 66/T2–3 | No upgrade/fallback/implicit retry; waiting/local/settings choices |
| 66.7 | 66/T1–3 | Current links, stale/unknown/missing/cache/quota/retry/concurrency fixtures |
| 67.1 | 67/T3 | Both-host workload/overlap matrix with all required metric definitions |
| 67.2 | 67/T3 | Identical EN/PT smaller-preset quality/context/concurrency comparisons |
| 67.3 | 67/T1 | Configurable headroom/policy coordinated with existing governor/preemption |
| 67.4 | 67/T2–3 | Owned on-demand/release, physical/pressure observations, unrelated/final lease exclusion |
| 67.5 | 67/T1,T3; 64/T1 | Honest matched profile contract and shared UI |
| 67.6 | 67/T3 | Baseline/optimized M1 Air/M4 Pro quality/savings/responsiveness/finalization evidence |

## Final verification and handoff

Run `bun run --cwd packages/client test`, `bun run build`, and `bun test packages/server/lib`, plus affected Python/native checks and integrated browser acceptance. Review actual diff, all 28 criteria, measured two-host evidence and safe key/provider boundaries independently. No completed-issue claim while any criterion is pending, blocked or unverified.

All intended repository changes must be committed and pushed; fetched remote HEAD must equal local HEAD with no outgoing issue work. Stop and verify only owned issue services, preserve required local evidence outside worktrees, remove clean pushed issue worktrees without force, and verify their absence. The final PR handoff lists test results, exact commit, profile evidence, criterion status and service/worktree cleanup. CI and manual/provider/physical acceptance remain distinct.
