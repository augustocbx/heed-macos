# Issue #65: explicit provider inference Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. The approved design uses one focused issue implementer at a time, coordinator-owned Git/integration, and independent review.

**Goal:** Add secure optional inference to existing durable notes/tasks/chat workflows.

**Architecture:** Provider adapters normalize only transport results. Server-owned plans authorize exact content, and durable services retain their existing revision and domain guards. Remote execution stays disabled until downstream cost and disclosure gates exist.

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

- Credential rotation while a job is queued or running must invalidate admission and cancel work (Task 2/3).
- Capture preemption after a remote dispatch must not replay a paid attempt on the next timer tick (Task 3).
- Reopening a remote preview after source/history changes must require renewed content review (Task 3).
- Named/custom endpoint redirects or injected response bodies must never expose a key or reach an untrusted destination (Task 1/2).
- A provider completing malformed/citation-invalid output must not create accepted notes/tasks/answers (Task 3).

---

### Task 1: shared contracts, prompts, and adapter fixtures

**Files:** Create `packages/shared/types/ai.ts`, `packages/server/lib/inference/{contracts,prompts,transport,adapters}.ts`, vendor modules `inference/providers/{openai,anthropic,deepseek,xai,compatible}.ts`, and `inference/adapters.test.ts`; modify `packages/shared/types/index.ts`, `ollama-notes.ts`, and `task-generation.ts`.

**Interfaces:** Produce `AiProviderId = "ollama" | "openai" | "anthropic" | "deepseek" | "xai" | "compatible"`; `AiFeature = "notes" | "tasks" | "chat" | "library-chat"`; `AiSelection {provider, connectionId: string | null, model: string | null}`; `AiCapabilities {features, structuredOutput: "schema" | "validated-json" | "none", streaming, contextTokens, maxOutputTokens, usageCategories}`; `AiUsage {inputTokens?, cachedInputTokens?, cacheWriteTokens?, outputTokens?, reasoningTokens?, supported: boolean}`; `AiResult {text, usage, finish: "completed", provenance}`. Server contracts produce `AiCall {id, system, data, schema?, contextTokens, maxOutputTokens}` and `AiAdapter.generate(input: AiAdapterRequest): Promise<AiResult>`. Adapter request carries frozen selection/endpoint, key, call, signal, and optional token callback; keys are server-only. Preserve existing local exported function signatures through wrappers.

- [ ] Write behavioral tests: each named vendor and custom adapter maps its own completion/usage/error fixtures; malformed or truncated output fails; remote HTTPS redirects/userinfo fail; loopback/local metadata protections remain; unsupported schema/stream/usage combinations are explicit. Preserve prompt grounding and language behavior byte-for-byte where applicable.
- [ ] Run `bun test packages/server/lib/inference/adapters.test.ts packages/server/lib/ollama-notes.test.ts` before implementation; confirm the new tests fail for the intended missing behavior while existing controls remain valid.
- [ ] Implement vendor-specific bounded transport using official API documentation verified at implementation time. Remote buffered completion is acceptable where declared; do not advertise unsupported streaming. Separate normalized cache/reasoning categories without inferring absent usage. Requests have a 300-second maximum and 2,000,000-byte response cap; key/model validation requests have a 15-second maximum. Default transport attempts are one, with no hidden SDK retries. Errors use allowlisted codes and discard raw vendor bodies. Extract provider-neutral prompts and retain the local wrapper safeguards.
- [ ] Run the same command; require zero failures. Inspect the actual diff and record criterion evidence.
- [ ] Coordinator commits the verified deliverable with `feat(ai): add explicit provider contracts and bounded adapters`; no Co-Authored-By trailer.

### Task 2: protected connection configuration and HTTP boundary

**Files:** Create `inference/{connections,http}.ts`, `inference/{connections,http}.test.ts`, `packages/client/src/api/ai.ts`; reuse `connectors/keychain-vault.ts`; modify `packages/server/server.ts`.

**Interfaces:** Produce `AiConnections.snapshot(): AiSettingsSnapshot`, `.saveSelection(feature, selection)`, `.register(input): Promise<AiConnectionSnapshot>`, `.validate(id): Promise<AiConnectionSnapshot>`, `.remove(id): Promise<void>`, and `.resolve(selection): Promise<ResolvedAiConnection>`. Snapshots exclude keys and credential references. Private records contain UUID references, connection/credential/trust generations, and pending cleanup. `aiResponse(request, runtime, allowed): Promise<Response | null>` serves GET/POST `/api/ai/settings` and POST `/api/ai/connections` actions `register|validate|replace|remove`; the client exposes only safe snapshots.

- [ ] Write behavioral tests: local/no-key default; no generation on selection/register/validate; content-free vendor validation; endpoint trust invalidation; replace/remove/restart cleanup; locked Keychain fails closed; secrets absent from JSON responses, browser storage, argv, journals, exports and error messages; loopback/Origin, body caps and no-store headers.
- [ ] Run `bun test packages/server/lib/inference/connections.test.ts packages/server/lib/inference/http.test.ts packages/server/lib/connectors/keychain-vault.test.ts` before implementation; confirm the new tests fail for the intended missing behavior while existing controls remain valid.
- [ ] Implement private 0600 configuration under APP_DIR/ai, outside portable catalog/storage; reuse existing protected vault without plaintext fallback. Custom connections require displayed exact HTTPS endpoint and deliberate versioned trust. Preserve established localhost/Origin policy and bound body size to 65,536 bytes. Keep secret input only in the request and vault, and redact all feedback.
- [ ] Run the same command; require zero failures. Inspect the actual diff and record criterion evidence.
- [ ] Coordinator commits the verified deliverable with `feat(ai): protect provider credentials and connection settings`; no Co-Authored-By trailer.

### Task 3: exact-content authorization and durable domain integration

**Files:** Create `inference/{planning,authorization,runtime}.ts`, `inference/{authorization,jobs}.test.ts`; modify `automatic-notes.ts`, `meeting-tasks.ts`, `meeting-chat.ts`, `library-chat.ts`, `task-generation.ts`, `notes-settings.ts`, `server.ts`, shared `notes.ts`, `tasks.ts`, `chat.ts`, `library-chat.ts`, and `portable-transcript.ts` with related portable tests.

**Interfaces:** Produce `AiJobPlan {id, jobId, feature, selection, calls: AiCall[], sources: AiSourceGuard[], settingsVersion, connectionGeneration, trustGeneration, payloadHash, expiresAt}` with server-only text; `AiSourceGuard {sessionId, sourceRevision, sourceVersion?, expectedNotesHash?}`; `AiAuthorizationDecision {allowRemote: true, expectedPayloadHash, allowUnknownCost?: true}`; `AiPreview` exposes exact reviewed calls/scoped excerpts and safe provenance. `AiPlanner.prepare(command): Promise<AiJobPlan>` uses current domain sources/history/templates; `AiAuthorizations.preview(plan): AiPreview`, `.authorize(planId, decision): AiAuthorization`, `.assert(plan): void`. Authorization expires after ten minutes and binds the entire immutable plan. `AiRuntime.execute(plan, signal): Promise<AiResult[]>` consumes pluggable budget and resource admission hooks; remote default hooks deny dispatch until #66/#67 are wired. Notes jobs/task reviews/chat turns freeze selection/plan identity; legacy jobs remain local. The local runtime uses existing installed-model wrappers.

- [ ] Write behavioral tests: zero uploads before authorization; synthetic excluded markers never leave selected scope; source/template/history/provider/key changes invalidate review; automatic historical jobs wait for consent; duplicate requests remain one job; source change or invalid citation blocks persistence; notes hashes and accepted tasks remain protected; capture abort cannot cause paid timer replay; retry is explicit; multi-call chat reserves the whole plan; legacy/manual summary and summary-line paths remain local.
- [ ] Run `bun test packages/server/lib/inference/authorization.test.ts packages/server/lib/inference/jobs.test.ts packages/server/lib/automatic-notes.test.ts packages/server/lib/meeting-tasks.test.ts packages/server/lib/meeting-chat.test.ts packages/server/lib/library-chat.test.ts packages/server/lib/ai-queue.http.test.ts packages/server/lib/portable-transcript.test.ts` before implementation; confirm the new tests fail for the intended missing behavior while existing controls remain valid.
- [ ] Implement a prepare/review/authorize flow served by POST `/api/ai/plans` and `/api/ai/authorize`, with cancel/retry retaining domain command identity. Extract chat batch preparation so preview, reservation and execution share precisely the same up-to-four-call plan; preserve 5,500-byte chat input and 8,192-token context guards. Do not persist raw preview content in accounting/authorization state; restart invalidates unsubmitted previews and marks dispatched remote attempts uncertain. Extend only safe provider/model provenance in portable metadata with backward-compatible allowlisted decoding. Preserve mandatory review/grounding.
- [ ] Run the same command; require zero failures. Inspect the actual diff and record criterion evidence.
- [ ] Coordinator commits the verified deliverable with `feat(ai): authorize scoped provider jobs through durable services`; no Co-Authored-By trailer.

### Task 4: opt-in synthetic adapter checker and provider regression evidence

**Files:** Create `scripts/qa/check-ai-providers.ts`, `scripts/qa/check-ai-providers.test.ts`, `docs/ai-providers.md`; extend existing provider/domain HTTP tests.

**Interfaces:** Checker accepts explicit provider/model/connection and `--allow-synthetic-remote` with reviewed bounded EN/PT fixture plans, using AiRuntime and protected credential resolution. Exit zero means contract/request completion; generated factual review is a separate report field. Reports omit keys, private content and credential refs.

- [ ] Write behavioral tests: no network without the opt-in flag; only authored synthetic text is sent; missing key/capability/consent fails; all adapters have offline fixture coverage; cancellation/truncation/rate limits and source-grounding report states differ from successful transport.
- [ ] Run `bun test scripts/qa/check-ai-providers.test.ts packages/server/lib/inference` before implementation; confirm the new tests fail for the intended missing behavior while existing controls remain valid.
- [ ] Implement the documented live checker and feature/provenance guidance, including excluded content and safe key registration. Live provider account checks remain user-opt-in; documented checker plus per-adapter controlled contracts are the acceptance requirement, not agent-supplied credentials.
- [ ] Run the same command; require zero failures. Inspect the actual diff and record criterion evidence.
- [ ] Coordinator commits the verified deliverable with `test(ai): document synthetic provider contract validation`; no Co-Authored-By trailer.

**Issue coverage:** 65.1 → Task 1; 65.2 → Tasks 2–3; 65.3 → Tasks 1–2; 65.4 → Task 2; 65.5–65.7 → Task 3; 65.8 → Tasks 1 and 4. Criterion 65.6 completes with #66/#67 admission integration. User-facing completion also requires #64.
