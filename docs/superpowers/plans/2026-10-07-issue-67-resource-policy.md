# Issue #67: local resources and measured profiles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. The approved design uses one focused issue implementer at a time, coordinator-owned Git/integration, and independent review.

**Goal:** Protect capture headroom and measure smaller local model tradeoffs on both Macs.

**Architecture:** Extend existing admission/preemption and model leases, retaining the live governor. Reproducible synthetic workloads provide configuration-matched memory profiles and quality evidence.

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

- Model release must not unload unrelated Ollama users or finalization leases (Task 2).
- Successful unload API completion may leave physical memory/pressure unchanged (Tasks 2–3).
- Unified memory, Metal allocations and RSS are overlapping metrics (Task 3).
- Long EN/PT sources must not be silently truncated by an optional smaller context (Tasks 1 and 3).
- Unknown resource measurements or stale sampler data must postpone safely, never upload (Task 1).

---

### Task 1: configurable shared resource admission

**Files:** Create `packages/shared/types/ai-resources.ts`, `inference/{resources,memory-profiles}.ts`, `inference/resources.test.ts`; modify `inference/runtime.ts`, `server.ts`, transcription lifecycle as needed, and shared exports.

**Interfaces:** Produce `AiResourcePolicy {captureHeadroomMiB, applicationHeadroomMiB, maxOptionalConcurrency: 1, contextTokens, maxOutputTokens, idleReleaseSeconds, allowContextReduction, allowModelReduction, allowUnmeasuredLocal}`; default reductions and unmeasured-local opt-in false, context 8192, max output 1800, idle release 0 seconds after the last owned lease. Default total reserved headroom is max(4096 MiB, 25% physical RAM), split as capture=ceil(total/2) and applications=total-capture with visible configuration. `AiResources.admit(plan, sample): AiResourceDecision`, `.acquire(plan): AiLease`, `.release(lease)`. `AiMemoryProfile` keys exact hardware/runtime/engine/model digest/quantization/context/concurrency and separately represents measured RSS/physical indicators and estimated incremental/total memory.

- [ ] Write behavioral tests: headroom/config bounds enforce waiting under pressure; capture/final ASR have priority; optional concurrency never exceeds one; unknown/stale sampler/profile states remain visible and cannot imply free RAM; reductions require visible explicit policy and preserve source coverage/provenance; local/remote choices never change on resource failure; live governor remains active independently.
- [ ] Run `bun test packages/server/lib/inference/resources.test.ts packages/server/lib/ai-queue.http.test.ts` before implementation; confirm the new tests fail for the intended missing behavior while existing controls remain valid.
- [ ] Implement admission integrated with current isBusy/preemption hooks rather than a second independent governor. Bound sample age to five seconds. Validate settings against physical RAM and supported model contexts, preserving legacy local selection. Unknown/mismatched profile waits by default; a visible explicit allowUnmeasuredLocal choice permits local-only work under actual pressure/headroom/concurrency guards and never claims a measured bound. Define conservative unsupported-profile behavior and expose `/api/ai/resources` settings/status plus configuration-matched `/api/ai/memory-profiles`.
- [ ] Run the same command; require zero failures. Inspect the actual diff and record criterion evidence.
- [ ] Coordinator commits the verified deliverable with `feat(ai): reserve capture headroom through shared admission`; no Co-Authored-By trailer.

### Task 2: owned on-demand model residency and verified release

**Files:** Create `inference/residency.ts`, `inference/residency.test.ts`; modify `ollama-notes.ts`, `runtime.ts`, and affected Python preview lifecycle; extend `packages/transcription/preview_preference_test.py`, `lifecycle_worker_test.py`, `managed_work_test.py`.

**Interfaces:** Produce `AiResidency.acquire(model, owner, signal): Promise<AiModelLease>`, `.release(lease): Promise<AiReleaseObservation>`, `.snapshot()`. Lease identity binds model digest, owned request and runtime; release observes before/after residency/physical/pressure samples and reports verified/unverified/failed separately. Existing generate wrappers remain protected and receive lifecycle options without breaking legacy callers.

- [ ] Write behavioral tests: no inference preload at settings/idle startup; overlapping owned leases delay release; preexisting unrelated residency and active external/finalization use prevent unload; cancelled generation uses bounded fresh cleanup signal; failed/timeout unload remains unreclaimed; API acknowledgement alone is not verified physical release; disabled preview never acquires shared/native models just for idle warmup.
- [ ] Run `bun test packages/server/lib/inference/residency.test.ts packages/server/lib/ollama-notes.test.ts` before implementation; confirm the new tests fail for the intended missing behavior while existing controls remain valid.
- [ ] Implement best-effort safe owned release only when ownership and active-use exclusion can be established; otherwise expose inability and postpone optional jobs. Preserve finalization leases and coordinate current live preview lifecycle. Run the affected Python suites with the existing compatible interpreter and record exact commands/results.
- [ ] Run the same command; require zero failures. Inspect the actual diff and record criterion evidence.
- [ ] Coordinator commits the verified deliverable with `feat(ai): manage owned inference residency safely`; no Co-Authored-By trailer.

### Task 3: two-Mac resource/quality matrix and matched profile publication

**Files:** Create `scripts/qa/profile-ai-resources.py`, `scripts/qa/profile_ai_resources_test.py`, `scripts/qa/fixtures/ai-resources/{cases.json,README.md}`, `docs/qa/issues-64-67-resource-validation.md`, and reviewed configuration profiles in `packages/server/lib/inference/profiles.json`; reuse `scripts/check-real-time-resources.py`, `scripts/check-notes-quality.ts`, licensed audio fixtures and production engines.

**Interfaces:** Profiler CLI accepts explicit model/configuration, workload, fixture manifest, repetitions, owned ports/APP_DIR and report directory. Outputs versioned AiMemoryProfile-compatible reports, fixture/commit hashes, sampled process identity and physical/pressure definitions. Produce paired baseline/optimized M1 Air and M4 Pro results on identical EN/PT sources; at least three repeated runs per published measured range.

- [ ] Write behavioral tests: missing metrics are unknown; shared memory is not summed twice; process identity guards cleanup; synthetic content/fixture digest is exact; reports distinguish replay from physical capture and sampled ranges from peaks; failed unload and excluded unrelated workload are recorded; source-quality checks compare explicit/tentative/rejected actions, names and citations; all matrix phases exist before acceptance.
- [ ] Run `python3 -m unittest discover -s scripts/qa -p profile_ai_resources_test.py` before implementation; confirm the new tests fail for the intended missing behavior while existing controls remain valid.
- [ ] Implement isolated workloads serially on each host: idle; synthetic system-audio capture with live ASR on/off and completeness checks; final ASR/diarization; notes/chat baseline and smaller free presets; permitted overlap; capture preemption and residency release. Use owned dedicated Ollama/API/transcription services and private fixture directories where required, never stop installed/unrelated services. Observe RSS, physical/unified indicators, pressure/swap, CPU, latency, responsiveness and capture sample completeness. Existing permissions/models must be checked; any needed user-only permission is an explicit blocker. Review authored outputs against identical EN/PT ground truth, publish reproducible measurements and model/context tradeoffs, and retain raw synthetic evidence outside worktrees.
- [ ] Run the same command; require zero failures. Inspect the actual diff and record criterion evidence.
- [ ] Coordinator commits the verified deliverable with `docs(ai): publish paired resource and smaller-model validation`; no Co-Authored-By trailer.

**Issue coverage:** 67.1–67.2 → Task 3; 67.3 → Task 1; 67.4 → Tasks 2–3; 67.5 → Tasks 1 and 3; 67.6 → Task 3. Actual physical release, quality and two-host comparisons require recorded runtime evidence, not fixture-only passes.

**Runtime matrix commands:** expose `python3 scripts/qa/profile-ai-resources.py --matrix --repetitions 3 --fixture-manifest scripts/qa/fixtures/ai-resources/cases.json --report-dir /tmp/heed-ai-resources-m1` locally, and the equivalent command with `/tmp/heed-ai-resources-m4` in the owned M4 measurement checkout. The reviewed manifest pins baseline/smaller model names, downloaded digests, quantization and baseline/optimized contexts before execution. Inspect all phases, metrics and EN/PT quality results; an exit code alone is insufficient.
