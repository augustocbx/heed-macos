# AI provider foundation and synthetic contract checks

Heed's provider foundation supports local Ollama, OpenAI, Anthropic, DeepSeek, xAI, and explicitly trusted OpenAI-compatible connections. Local Ollama remains the default. Notes, task extraction, meeting chat, and selected-scope library chat retain their domain validation and review requirements. Provider/model provenance identifies the selected generation source; it is not a quality endorsement.

This foundation is staged. Remote production execution currently fails closed with `budget-unavailable`: the spending and resource policies from issues #66 and #67 are not integrated yet. The checker uses the same `AiPlanner`, `AiAuthorizations`, protected `AiConnections.resolve`, and `AiRuntime` boundary as production and preserves that denial. It cannot currently make a successful remote live check. Before delivery, both the server and checker must be wired to the same actual spending and resource policy providers and validated together. There is no admission override flag. The complete selection/disclosure interface belongs to #64, and measured local quality/resource profiles belong to #67.

## Protected registration and content authorization

The user registers a key through Heed's guarded, write-only connection flow. The server sends it to the native device-local Keychain helper on stdin. Private connection metadata contains an opaque credential reference, not the key. Stored keys are never returned to the browser. Do not put keys in command arguments, environment variables, plaintext files, browser storage, exports, synchronized libraries, screenshots, or logs. The checker does not register, replace, validate, remove, or expose stored keys, and does not change selections. Key retrieval, when permitted, occurs inside the protected runtime after scope consent and whole-operation admission.

Registration stores the credential without sending meeting content. Explicit validation uses a content-free model endpoint; it authorizes no meeting processing. Compatible connections require deliberate endpoint trust and declared capabilities. Unsupported/unverified model capabilities remain unavailable; selecting a different model or provider is always an explicit choice. Replacement, removal, or changed settings invalidate existing execution checkpoints and consent.

Remote notes/tasks require consent for the exact selected source. Remote chat uses the selected retrieval excerpts. Audio, calendar data, embeddings, unrelated meetings, and unselected library sources are excluded. Finalization or key registration does not authorize an automatic upload. `/api/summarize` and `/api/summary-line` retain their local-only paths. Portable results allow safe provider/model provenance and exclude keys, credential references, authorization grants, device-local job bindings, and spending state.

## Offline contract fixtures

Run from the repository root, using Bun:

```sh
bun test scripts/qa/check-ai-providers.test.ts packages/server/lib/inference
```

These tests use authored synthetic content, temporary private configuration, in-memory synthetic credentials, and injected HTTP responses. They exercise every adapter's native contracts, usage/error handling, cancellation, bounded requests, truncation rejection, and local loopback/installed-model protections. Checker integration tests run the actual planner/authorization/runtime/local adapter chain without loading a real model. Successful offline provider responses are tested separately through the actual remote adapters; remote runtime tests do not install permissive admission hooks.

## User opt-in live check

Only the two authored English/Portuguese fixtures embedded in `scripts/qa/check-ai-providers.ts` are accepted. There is no input-file, prompt, endpoint, key, or arbitrary source option. The fixed feature is notes, with one JSON call, context 8,192 and maximum output 256 tokens. The synthetic scenario says Mira will check a sample report on Friday and explicitly leaves the budget undecided. Generated output must contain one to four exact source quotes. This is a small source-contract check, not a representative notes/chat quality benchmark.

Use the existing protected device-local connection and configure the notes selection to match the explicit provider/model/connection flags. The checker does not perform that configuration. Stop Heed's server before using a standalone checker against the same private application directory; do not introduce concurrent private configuration writers. A default invocation only returns a synthetic scope preview and a nonzero status; it retrieves no key and sends no content:

```sh
bun scripts/qa/check-ai-providers.ts \
  --provider openai --model gpt-6-luna \
  --connection <registered-connection-UUID> --language en
```

Read the returned calls, selected provider/model, excluded data, payload hash, and cost policy. To accept that exact synthetic plan, supply its hash and the explicit remote opt-in:

```sh
bun scripts/qa/check-ai-providers.ts \
  --provider openai --model gpt-6-luna \
  --connection <registered-connection-UUID> --language en \
  --allow-synthetic-remote --accept-payload-hash <reviewed-payload-hash>
```

Today this second command still exits nonzero with `budget-unavailable`, with zero credential reads and zero uploads. Repeat the preview after any settings/connection changes; a previous hash cannot authorize a changed plan. `--language pt` selects only the authored Portuguese fixture. Other remote providers use their explicitly registered model and UUID, including compatible connections whose endpoints cannot be changed by this command. Model names/capability verification are defined in `packages/server/lib/inference/model-metadata.ts`; this documentation does not infer capabilities for other models.

`--allow-unknown-cost` records an explicit unknown-cost choice for the exact accepted plan. It does not supply a spending reservation or resource lease, disable strict limits, prove a bound, or override the current production denial. Once #66/#67 are integrated, the checker must run with their actual policy and use its admitted limits and accounting. Heed cannot guarantee an external account-wide billing cap or exact eventual invoice; absent provider usage and uncertain dispatched outcomes must remain visible under that policy. No retry, automatic provider switch, model substitution, or paid fallback occurs in the checker.

For an already installed local model, use `--provider ollama --model <installed-model> --connection local --language en`. Review the first invocation and repeat with `--accept-payload-hash <reviewed-payload-hash>`. The remote flag is unnecessary locally. An accepted local invocation can load the explicitly selected model on demand; it never downloads one. Local admission must receive #67's actual resource policy before final delivery. The agent does not run live provider checks or model loads as part of these contract fixtures.

## Interpreting the report

Reports contain the authored preview and stable status codes, never stored keys, credential references, provider error bodies, or generated output text. Interrupt with Ctrl-C to cancel; no retry is scheduled.

| Field | Meaning |
| --- | --- |
| `transport: not-started` | Review, selection, capability, checkpoint, credential, or policy gates prevented dispatch. |
| `transport: completed` | The adapter returned a completed, schema-valid response. |
| `transport: cancelled`, `truncated`, `rate-limited`, or `failed` | A distinct unsuccessful outcome; it does not count as completed generation. |
| `sourceGrounding: passed` | Returned source IDs and exact quotes match the authored fixture. |
| `sourceGrounding: failed` | Transport completed, but the source contract failed; exit status remains nonzero. |
| `factualQuality: not-reviewed` | No human quality review occurred. Transport/source-contract success never changes this field. |

Exit zero means the single request and source contract completed. It is not evidence of factual notes quality, measured memory savings, capture priority under load, provider retention/training guarantees, or successful billing enforcement. No live account results are claimed by the offline suite. Human EN/PT quality review and the M1 Air/M4 Pro measurement matrix remain separate acceptance evidence for #67.
