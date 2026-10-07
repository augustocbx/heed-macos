# Issues #64–#67 acceptance checklist

Date: 2026-10-07. Owner: coordinator; issue implementers receive every criterion in their brief. All criteria are pending before implementation. Evidence must identify the checked commit and distinguish automated checks, CI, measured runtime, and human quality review.

## #64: Explain local memory ranges and cloud AI benefits on the provider API-key setup screen

Planned verification: Selection/disclosure UI and measured-profile metadata; four-locale and accessible browser checks.

### 64.1

Show a **range of estimated local RAM use**, tied to the selected model, quantization, context length, engine, and concurrency. Separate model download size from runtime memory, local LLM cost from ASR/capture cost, and incremental model usage from estimated total Heed usage.

- Status: pending.
- Owner: issue implementer; coordinator validates coverage.
- Implementation: pending.
- Evidence: pending.
- Blocker: none established; execution prerequisites will be verified.

### 64.2

Use reproducible measured profiles with hardware/runtime/configuration, measurement definition, and date; label estimates versus measurements. Display "not measured" where evidence is missing instead of inventing ranges. Account for Apple Silicon unified memory without adding overlapping metrics twice.

- Status: pending.
- Owner: issue implementer; coordinator validates coverage.
- Implementation: pending.
- Evidence: pending.
- Blocker: none established; execution prerequisites will be verified.

### 64.3

Explain provider advantages in plain language: remote LLM inference reduces local LLM CPU/GPU and RAM demand, avoids downloading those local LLM weights, and provides access to models that may exceed the Mac's capacity. Quality and speed depend on the model/network; do not promise universal superiority or zero local memory.

- Status: pending.
- Owner: issue implementer; coordinator validates coverage.
- Implementation: pending.
- Evidence: pending.
- Blocker: none established; execution prerequisites will be verified.

### 64.4

Explain tradeoffs beside those advantages: internet dependency, API charges/free-tier limits, rate limits, and the exact selected text sent to the provider. Link dated official pricing and data-handling information. Distinguish local ASR from remote notes/tasks/chat; provider keys do not automatically move speech recognition to the cloud.

- Status: pending.
- Owner: issue implementer; coordinator validates coverage.
- Implementation: pending.
- Evidence: pending.
- Blocker: none established; execution prerequisites will be verified.

### 64.5

Present smaller free local models, available free allowances, and low-cost provider options without selecting a paid option automatically. Consumer chat subscriptions do not establish API credit.

- Status: pending.
- Owner: issue implementer; coordinator validates coverage.
- Implementation: pending.
- Evidence: pending.
- Blocker: none established; execution prerequisites will be verified.

### 64.6

Show expected effects of disabling live transcription: less capture-time processing, conditional RAM savings, and final-transcription peaks. Link to the live-transcription setting.

- Status: pending.
- Owner: issue implementer; coordinator validates coverage.
- Implementation: pending.
- Evidence: pending.
- Blocker: none established; execution prerequisites will be verified.

### 64.7

Preserve all four UI locales, accessible labels, local mode without a key, and explicit provider/content choice before any external request.

- Status: pending.
- Owner: issue implementer; coordinator validates coverage.
- Implementation: pending.
- Evidence: pending.
- Blocker: none established; execution prerequisites will be verified.

## #65: Add opt-in BYOK AI providers for notes, task extraction, and meeting chat

Planned verification: Provider/Keychain/consent integration; adapter and durable-job contract tests.

### 65.1

Add a shared provider/capability interface and adapters for OpenAI, Anthropic, DeepSeek, and xAI/Grok. Support explicitly trusted OpenAI-compatible endpoints without assuming every vendor has identical APIs, streaming, structured output, context limits, or usage fields.

- Status: pending.
- Owner: issue implementer; coordinator validates coverage.
- Implementation: pending.
- Evidence: pending.
- Blocker: none established; execution prerequisites will be verified.

### 65.2

Allow provider/model selection for notes (#8), task extraction (#15), and meeting chat (#16/#17), with clear per-feature provenance. Unsupported capabilities are visible rather than silently substituted.

- Status: pending.
- Owner: issue implementer; coordinator validates coverage.
- Implementation: pending.
- Evidence: pending.
- Blocker: none established; execution prerequisites will be verified.

### 65.3

Keep local Ollama the default and its loopback/local-model protections intact. Use a separate explicitly authorized remote transport, HTTPS for remote endpoints, and deliberate trust configuration for custom endpoints.

- Status: pending.
- Owner: issue implementer; coordinator validates coverage.
- Implementation: pending.
- Evidence: pending.
- Blocker: none established; execution prerequisites will be verified.

### 65.4

Store user-entered keys securely on the device, preferably macOS Keychain; never include keys in logs, recordings, portable storage, synchronization, or exports. Never return stored keys in browser responses, expose them after registration, or persist them in browser storage. Support validation, replacement, and removal; registering or validating a key must not send meeting content.

- Status: pending.
- Owner: issue implementer; coordinator validates coverage.
- Implementation: pending.
- Evidence: pending.
- Blocker: none established; execution prerequisites will be verified.

### 65.5

Before first remote processing, show the selected provider/model and content scope. Send only selected transcript/document content needed for the feature. Audio, unrelated meetings, calendar data, embeddings, and historical libraries are excluded unless separately and explicitly selected.

- Status: pending.
- Owner: issue implementer; coordinator validates coverage.
- Implementation: pending.
- Evidence: pending.
- Blocker: none established; execution prerequisites will be verified.

### 65.6

Implement cancellation, bounded retries, rate-limit/network feedback, and resource/cost reservations. Do not silently switch providers, upload content, or fall back to a paid model after local failure.

- Status: pending.
- Owner: issue implementer; coordinator validates coverage.
- Implementation: pending.
- Evidence: pending.
- Blocker: none established; execution prerequisites will be verified.

### 65.7

Preserve recording priority, durable job identity, grounding/source citations, locale/language handling, and transcript revision checks. Remote generation must not bypass the review requirements of #8, #15, #16, or #17.

- Status: pending.
- Owner: issue implementer; coordinator validates coverage.
- Implementation: pending.
- Evidence: pending.
- Blocker: none established; execution prerequisites will be verified.

### 65.8

Verify each adapter with contract fixtures and a documented opt-in live check using synthetic content. A request completing successfully is not evidence of factual quality.

- Status: pending.
- Owner: issue implementer; coordinator validates coverage.
- Implementation: pending.
- Evidence: pending.
- Blocker: none established; execution prerequisites will be verified.

## #66: Prioritize free and low-cost AI options with transparent usage estimates and spending limits

Planned verification: Pricing/budget ledger integration; controlled usage/retry/concurrency fixtures.

### 66.1

Offer curated local/free-allowance/low-cost presets with a visible provider/model, supported features, relevant limitations, price source, currency, and last verification date. Prefer adequate inexpensive options; never label all provider access as free or promise a permanent free tier.

- Status: pending.
- Owner: issue implementer; coordinator validates coverage.
- Implementation: pending.
- Evidence: pending.
- Blocker: none established; execution prerequisites will be verified.

### 66.2

Explain free quota versus promotional credit versus paid API usage, regional/account eligibility, data-handling differences, and rate limits. Do not infer API access from a consumer chat subscription.

- Status: pending.
- Owner: issue implementer; coordinator validates coverage.
- Implementation: pending.
- Evidence: pending.
- Blocker: none established; execution prerequisites will be verified.

### 66.3

Estimate cost before substantial work using scoped input, context limits, maximum output, and provider-specific billable categories including cached input or reasoning where relevant. Label uncertainty and unknown prices; distinguish estimates from provider-reported usage and eventual bills.

- Status: pending.
- Owner: issue implementer; coordinator validates coverage.
- Implementation: pending.
- Evidence: pending.
- Blocker: none established; execution prerequisites will be verified.

### 66.4

Provide user-configurable per-job and period spending thresholds, reservations across concurrent jobs/retries, cancellation, and an auditable local usage view. Stop new requests when a conservative bound exceeds the configured limit; unknown cost requires explicit choice. Explain the app's controls cannot guarantee an external account-wide billing cap.

- Status: pending.
- Owner: issue implementer; coordinator validates coverage.
- Implementation: pending.
- Evidence: pending.
- Blocker: none established; execution prerequisites will be verified.

### 66.5

Summarize only necessary sources, bound output/context, and evaluate caching/batching only where supported and beneficial. Do not compromise citation accuracy or send a whole library just to obtain a discount.

- Status: pending.
- Owner: issue implementer; coordinator validates coverage.
- Implementation: pending.
- Evidence: pending.
- Blocker: none established; execution prerequisites will be verified.

### 66.6

Never auto-upgrade to paid access, change providers, or retry without limit. Preserve free local operation and allow the user to choose waiting for a quota reset or changing settings.

- Status: pending.
- Owner: issue implementer; coordinator validates coverage.
- Implementation: pending.
- Evidence: pending.
- Blocker: none established; execution prerequisites will be verified.

### 66.7

Link current official sources and make stale pricing/unsupported usage visible. Validate quota exhaustion, missing usage, cache pricing, retry charging, and concurrent budget reservation with controlled fixtures.

- Status: pending.
- Owner: issue implementer; coordinator validates coverage.
- Implementation: pending.
- Evidence: pending.
- Blocker: none established; execution prerequisites will be verified.

## #67: Measure and reduce local AI memory use with smaller models and enforceable resource budgets

Planned verification: Resource/lifecycle integration; reproducible two-Mac profiling and EN/PT source-quality review.

### 67.1

Profile idle, capture with/without live ASR, final ASR/diarization, notes, and chat separately and under permitted overlap. Record model/quantization/context, concurrency, runtime/host, process RSS, physical/unified-memory indicators, pressure/swap, CPU, latency, and capture completeness.

- Status: pending.
- Owner: issue implementer; coordinator validates coverage.
- Implementation: pending.
- Evidence: pending.
- Blocker: none established; execution prerequisites will be verified.

### 67.2

Establish useful free smaller-model presets and quality tradeoffs using identical English/PT fixtures. Include bounded contexts and concurrency, with evidence-based recommendations for lower-memory Macs.

- Status: pending.
- Owner: issue implementer; coordinator validates coverage.
- Implementation: pending.
- Evidence: pending.
- Blocker: none established; execution prerequisites will be verified.

### 67.3

Enforce a configurable resource policy that reserves headroom for capture and other meeting applications. Coordinate with existing preemption/governor mechanisms; postpone optional jobs, reduce local context/model only with visible user policy, and handle inability to unload safely.

- Status: pending.
- Owner: issue implementer; coordinator validates coverage.
- Implementation: pending.
- Evidence: pending.
- Blocker: none established; execution prerequisites will be verified.

### 67.4

Load inference models on demand and release Heed-owned idle model residency where safe. Verify actual release/pressure behavior, not just an unload API response. Do not affect unrelated Ollama workloads or running finalization.

- Status: pending.
- Owner: issue implementer; coordinator validates coverage.
- Implementation: pending.
- Evidence: pending.
- Blocker: none established; execution prerequisites will be verified.

### 67.5

Report estimated versus measured memory ranges to the model/key-screen disclosure feature. Download size, RSS, and total memory are distinct metrics.

- Status: pending.
- Owner: issue implementer; coordinator validates coverage.
- Implementation: pending.
- Evidence: pending.
- Blocker: none established; execution prerequisites will be verified.

### 67.6

Compare baseline and optimized settings on the M1 Air and M4 Pro with synthetic/licensed fixtures. Report quality, savings, responsiveness, and finalization tradeoffs without claiming a universal 6 GB requirement or a fixed saving.

- Status: pending.
- Owner: issue implementer; coordinator validates coverage.
- Implementation: pending.
- Evidence: pending.
- Blocker: none established; execution prerequisites will be verified.
