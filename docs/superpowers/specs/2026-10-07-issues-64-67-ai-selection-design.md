# Local and provider AI selection — issues #64–#67

Date: 2026-10-07. Status: architecture approved by the user; implementation plan pending review. Product implementation has not started.

## Intended outcome

Users can choose an installed local model or an explicitly configured provider model for notes, task extraction, and meeting chat. The settings interface stays clean and consistent with Heed. Local operation remains available without keys, internet, or API charges. All acceptance criteria of issues #64, #65, #66, and #67 are required, including measured resource behavior on the M1 Air and M4 Pro.

Project source, identifiers, documentation, technical evidence, commits, and pull requests are in English. The English, Brazilian Portuguese, French, and German interfaces remain complete. No meeting bots, audio uploads, private fixture data, or automatic paid/provider fallback are introduced.

## Approach and delivery boundaries

Use a shared inference boundary inside the existing jobs, not separate provider-specific queues. A transport-only replacement would bypass content authorization and paid-attempt accounting; separate cloud queues would duplicate revision checks and capture preemption. The shared boundary keeps the current durable lifecycle, grounding, and review contracts while adding explicit selection, authorization, resource admission, and spending admission.

Implement the dependent deliverables serially in dedicated issue worktrees and branches: #65 provider foundation; #66 spending policy; #67 local resource policy and measurements; #64 complete disclosure and selection interface. Later branches start from the validated previous issue branch. Review the integrated result before delivery. Provider inference is not presented as a complete user-facing feature until its disclosure and spending controls are integrated.

The coordinator owns shared Git operations, acceptance tracking, services, integration, and delivery. One implementer owns a coherent issue patch and regression tests at a time. Read-only investigations and independent reviews may run separately. Preserve the modified root AGENTS.md and unrelated worktrees/services.

## Existing contracts to preserve

- `packages/server/server.ts` wires notes, tasks, meeting chat, and library chat through injectable generation callbacks. Integrate there and in their durable service contracts.
- `automatic-notes.ts` snapshots job identity, transcript revision/version, template, language, and notes hash. Remote provider/model and authorization must be frozen with that snapshot.
- Task extraction currently auto-enqueues finalized meetings and selects the current global local model. Remote selection must not authorize those queued meetings automatically.
- Notes/tasks can be preempted back into waiting and retried by a timer. A dispatched remote attempt must not be resubmitted or have its budget refunded merely because capture interrupts it.
- Meeting and library chat use scoped retrieval, structured output validation, source citations, and revision checks. Preserve retrieval scope and never send a whole library for pricing or convenience.
- `/api/summarize` accepts browser-supplied text and streams local output; `/api/summary-line` is invoked automatically. Keep their existing local-only paths until any remote request uses a guarded, source-bound command and explicit authorization.
- `ollama-notes.ts` requires loopback transport, installed local models, verified metadata, and completed output. Retain those safeguards.
- `connectors/keychain-vault.ts` and the native Keychain helper already provide an stdin-only secret boundary with device-local, nonsynchronizing protected storage. Reuse the vault; do not add plaintext fallback.
- `packages/transcription/governor.py`, preview model lifecycle, capture priority, and existing worker preemption remain the coordination mechanisms. Resource admission extends them rather than creating an independent competing governor.

## Shared inference and provider configuration (#65)

Introduce shared provider, model, feature, capability, request, result, usage, and provenance types. Provider IDs distinguish local Ollama, OpenAI, Anthropic, DeepSeek, xAI, and explicitly trusted custom OpenAI-compatible connections. Capabilities are model-specific: notes/text, schema or validated JSON, streaming, context limit, output limit, usage categories, cancellation, and supported pricing categories. Unsupported or unverified capabilities remain visible and unavailable for the affected feature.

Adapters handle vendor-specific endpoints, authentication, request shapes, completion/stop semantics, errors, and usage. OpenAI-compatible support does not imply compatibility with every vendor. Use bounded requests/responses, deadlines, cancellation, and explicit retry policy. Reject truncated, incomplete, malformed, or schema-invalid output before existing domain validation and persistence. Do not treat successful HTTP completion as factual quality.

Known remote providers use fixed HTTPS endpoints. Custom endpoints require deliberate trust of the displayed endpoint and model capability declaration; reject credentials in URLs, unsafe schemes, redirects, and destinations outside the accepted configuration. Local Ollama stays on its protected local transport. Remote failures never change provider or model.

Persist only nonsecret connection metadata and opaque Keychain references in private device-local state outside portable storage. Browser responses show registration/validation state without returning stored keys. Keys cross the native boundary on stdin and never appear in process arguments, logs, recordings, synchronization, exports, or browser storage. Registration, validation, replacement, removal, locked-Keychain failure, restart recovery, and pending secret cleanup have controlled tests. Validation uses a vendor-supported content-free endpoint and never sends meeting content.

### Content authorization and execution

Before remote execution, build a server-owned preview of the exact selected text payload. It identifies feature, connection, provider/model, source IDs and revisions, template/question, output limit, language, context/cost estimate, and excluded data. A short-lived authorization binds the payload hash, settings version, source revision/version, provider/model, and cost decision. Source or settings changes invalidate it.

Users review selected transcript/document excerpts and explicitly confirm remote processing. Audio, unrelated meetings, calendar data, embeddings, and historical libraries are excluded. Library chat may include only sources/excerpts from the explicitly selected scope. Credentials remain device-local and are not part of the consent payload. Registration and provider selection alone never authorize sending content.

Bind authorization to the connection's credential generation and endpoint trust version as well. Replacement/removal invalidates queued admission and cancels active work safely. Browser-facing key endpoints enforce loopback/Origin checks, bounded JSON, and `Cache-Control: no-store`; sanitized responses never expose raw provider bodies or key-bearing headers.

Automatic remote notes/tasks wait for source-specific authorization rather than uploading after finalization. Manual notes use the same guarded durable path. Retry, cancellation, preemption, restart, transcript edits, and duplicate submissions preserve identity and reject stale authorizations. Domain grounding/source checks and task review remain mandatory after generation. Safe provider/model provenance is preserved with generated results; device-local credentials, authorization, and spending state are excluded from portable records.

Provide contract fixtures for every adapter and an opt-in live checker using authored synthetic EN/PT text only. The checker selects a provider/model explicitly, shows the synthetic scope and cost policy, requires an explicitly supplied key through protected storage, and reports request completion separately from source-grounding quality. User credential entry is not performed by the agent.

## Spending policy and usage (#66)

Keep local models as the default free preset. Curated remote presets list provider/model, supported features, limitations, currency, official price and data-handling URLs, and verification date. Select inexpensive adequate models only when their capability contracts are supported. Never preselect paid inference. Free quota, promotional credits, and paid usage have distinct labels; eligibility, regional restrictions, expiry, data handling, and rate limits remain explicit. Consumer chat subscriptions are not API credit.

Version dated pricing per exact model and context tier. Model metadata represents ordinary input, cached input, cache writes, output, and reasoning categories where applicable. Account for provider-specific categories conservatively; avoid double-counting reasoning already included in output. Unknown or stale pricing and missing provider usage are visible states, not zero costs.

Preview substantial requests from the scoped payload, system/schema overhead, conservative token upper bound, provider context limits, maximum billable output, and permitted attempts. Reserve the conservative known-price bound before dispatch. Per-job and configurable-period thresholds include all active reservations and uncertain dispatched attempts. Persistent device-local accounting uses atomic admission so concurrent requests cannot each spend the same remaining balance.

Chat can produce up to four generation calls for a bounded retrieval plan; reserve the entire planned operation before its first dispatch. Keep the current 5,500-byte input and 8,192-token context guard unless an explicit validated model policy changes them. Count every retry toward the cumulative job threshold. Period changes do not drop unfinished reservations: retain their dispatch-period allocation and make unresolved liability visible. Price time/context/region premiums use the highest applicable conservative rate.

Record reservation, dispatch, attempt outcome, provider-reported usage, conservative estimated charge, and uncertainty without storing content or secrets in the usage ledger. Dispatched timeouts, cancellations, missing usage, and interrupted process recovery retain conservative liability; only known unsubmitted work can release an unused reservation. A remote retry needs a bounded retry decision and sufficient additional reservation. Rate-limit/quota feedback offers waiting or changing settings and never switches providers or paid tiers automatically.

Unknown cost requires a conspicuous explicit user choice per request. It cannot be reported as satisfying a provable spending bound; reject unknown-price work under strict thresholds unless the user deliberately overrides that policy. Explain that Heed's local controls cannot enforce an external account-wide billing cap and eventual invoices may differ.

Keep contexts and output bounded; use only necessary sources. Cache/batch optimizations remain disabled unless the adapter supports them, current pricing shows benefit, and source accuracy and consent remain intact. Contract tests include cache categories even when runtime caching is disabled. No whole-library upload to obtain a discount.

## Resource admission, lifecycle, and measured profiles (#67)

Provide configurable capture/application headroom, optional-job concurrency, local context/output bounds, and idle residency policy. Default optional LLM concurrency is one. Admission considers available unified memory, pressure/swap, supported model evidence, and existing capture/finalization state. Resource failure postpones optional work with a visible reason; it never triggers remote processing.

Keep model and context reductions opt-in and visible. The initial policy preserves the selected model and waits when it cannot admit it. Any user-enabled smaller-model/context policy records the actual setting and provenance and cannot weaken grounding or silently truncate sources. Offer free smaller local presets with explicit quality tradeoffs and EN/PT evidence, independently of remote configuration.

Load LLMs only on demand. Track Heed-owned residency and active leases before attempting idle release; never unload unrelated Ollama work or a model in use by finalization. Verify residency and sampled physical/pressure behavior after release. Failure to unload is visible and prevents assuming reclaimed headroom. Keep capture protected and coordinate abort/wait states with the existing governor and preemption lifecycle.

### Reproducible measurement matrix

Both required machines are currently reachable: local MacBook Air M1/16 GiB and SSH-accessible MacBook Pro M4 Pro/48 GiB. Runtime availability still needs validation in isolated measurement environments. Use identical authored/licensed English and Portuguese fixtures and record fixture digests and exact implementation commit.

Measure baseline and optimized configurations on each machine, with repeats sufficient to show an observed range:

1. Idle, with owned inference models unloaded and then resident where relevant.
2. Capture with live ASR enabled and disabled, verifying recorded duration/sample completeness.
3. Final ASR and diarization, keeping their peak separate from capture-time behavior.
4. Notes and chat using baseline and smaller-model/context presets on identical EN/PT sources.
5. Permitted overlap and optional-job preemption by capture/finalization, including idle release failure and exclusion of unrelated Ollama workloads.

Record hardware/OS, runtime versions, engine, exact model digest/quantization, context/output bounds, concurrency, cold/warm state, date, sample interval, measurement definitions, process RSS, physical/unified-memory indicators, memory pressure/swap, CPU, latency, capture completeness, and reviewed source quality. Distinguish process RSS from physical footprint and avoid adding overlapping unified-memory metrics. System pressure includes unrelated applications; incremental estimates need a clearly identified baseline. An unload response or empty model list alone does not establish physical release.

Raw reports contain synthetic data only and stay outside worktrees until a reviewed public summary/profile is selected. Publish reproducible aggregate profiles and honest comparison of quality, observed savings, responsiveness, and finalization tradeoffs. Missing measurements remain “not measured”; the historical approximately 6.5 GiB aggregate Ollama RSS is evidence for one dated configuration only.

## Clean selection and disclosure interface (#64)

Add one coherent “AI” area within Settings, reusing Heed's current cards, typography, controls, and spacing. The primary controls are provider and model selectors for notes, tasks, and chat, with Local Ollama selected initially. Keep automatic-notes template/language/toggle nearby. Avoid duplicate independent model selectors that can disagree.

Show the selected option's short summary first: local/device or remote/provider, supported features, credential status, price status, and memory evidence status. Reveal key registration only for a selected remote connection. Mask key input, clear it after submission, and never offer a reveal of an already stored key. Include validation, replacement, and removal actions with accessible status/error feedback.

Keep comparison, pricing/data handling, budgets/usage, and resource settings in clearly labeled expandable sections. The key registration area includes a concise advantage/tradeoff summary before submission. Reuse the same model disclosure in local-model selection and feature-specific execution previews. Support keyboard navigation, focus visibility, error associations, labels, and 320–1920 px layouts at zoom.

Local disclosure separates model download size, incremental LLM runtime memory, estimated total Heed usage, and ASR/capture/finalization cost. Measured ranges identify model, quantization, context, engine, concurrency, host/runtime, definitions, date, and evidence link. Unmatched settings show “not measured” rather than borrowing an unrelated measurement or presenting static invented RAM ranges. Measured and estimated quantities are labeled distinctly.

Remote disclosure explains reduced local LLM CPU/GPU/RAM and avoided LLM weight download, access to larger models, network-dependent speed/quality, internet and rate-limit dependency, API charges, and exact selected text scope. Local ASR remains independent; provider keys do not move speech recognition to cloud services. Link dated official pricing/data-handling sources. No universal superiority or zero-local-memory claim.

Include free smaller local options and verified low-cost/free-allowance options with eligibility and price caveats. Link directly to the live-transcription setting and explain reduced capture-time processing, conditional residency savings, and final-transcription peaks. Translate all new user-facing controls, statuses, disclosures, unknown states, consent, and failures into all four supported UI locales.

## Verification and delivery gates

Tests must exercise observable behavior. Provider, consent, budget, concurrency/retry/recovery, source revision, storage exclusions, resource admission, ownership/unload, and locale contracts are required. Integrate HTTP fixtures through real production service boundaries; preserve existing notes/tasks/chat regression suites. Verify UI interactions and responsive/keyboard behavior with synthetic data and owned services.

Run `bun run --cwd packages/client test`, `bun run build`, and `bun test packages/server/lib`. Run affected Python lifecycle/governor tests and native Keychain build/self-tests if the helper changes. Execute the two-Mac measurement matrix and review synthetic generated content against sources. Independent review checks both correctness and omissions against every criterion in the accompanying acceptance checklist.

All criteria remain pending until their evidence exists. Missing or unsuccessful criteria are reported explicitly and never marked complete, replaced with weaker checks, or hidden by green CI. If runtime, permissions, model availability, or safe measurements block a criterion, record exact evidence and continue independent feasible work.

## Official metadata sources

Reverify the exact model/capability/price snapshot during implementation; current models and category rates must not be copied from older remembered defaults. Official sources inspected for architecture on 2026-10-07:

- OpenAI: [pricing](https://developers.openai.com/api/docs/pricing), [reasoning/output accounting](https://developers.openai.com/api/docs/guides/reasoning), [data controls](https://developers.openai.com/api/docs/guides/your-data), and [separate API/ChatGPT billing](https://help.openai.com/en/articles/9039756-managing-billing-settings-on-chatgpt-web-and-platform). Configure `store:false` where supported without claiming universal zero retention.
- Anthropic: [pricing](https://platform.claude.com/docs/en/about-claude/pricing), [commercial training policy](https://privacy.claude.com/en/articles/7996868-is-my-data-used-for-model-training), and [API data retention](https://platform.claude.com/docs/en/manage-claude/api-and-data-retention). Cache writes/read categories and feature-specific retention arrangements need explicit metadata.
- DeepSeek: [pricing](https://api-docs.deepseek.com/quick_start/pricing/) and [privacy policy](https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html). Time-dependent prices require conservative peak admission. An API-specific blanket no-training guarantee or fixed retention period is not established by the architecture investigation; disclose uncertainty.
- xAI: [pricing](https://docs.x.ai/developers/pricing), [billing](https://docs.x.ai/developers/faq/billing), and [API security/privacy](https://docs.x.ai/developers/faq/security). Model/context/region premiums and optional retention arrangements are separate dimensions.

Before merge handoff, inspect all changes and outgoing commits, commit/push every intended repository file, fetch and compare local/remote HEAD, stop and verify only owned issue services, preserve retained data outside worktrees, safely remove the issue worktrees, and verify removal. Do not merge or close issues without applicable acceptance evidence.
