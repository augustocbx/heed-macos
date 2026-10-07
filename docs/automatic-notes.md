# Automatic meeting notes

Automatic generation is opt-in under **Settings → Automatic meeting notes**. Select an installed local model and a valid template before enabling it. The default template is General Meeting; custom templates are supported. Output can follow the final meeting language or use English, Brazilian Portuguese, French, or German. Settings persist in this Mac's configuration. Disabling the feature remains possible when Ollama is unavailable.

## Finalization and persistence

The complete final transcript, final language, and speaker mapping are saved before a job becomes eligible. The live English preview is never eligible. Capture, recovered recordings, and successful manual retranscription supply an explicit finality marker. For a recording, the initial session save keeps finality pending while speaker edits are reconciled; the final write commits the latest saved names. Failed saves are not acknowledged as successful finalization.

The server computes a SHA-256 source revision from transcript text, final language, speaker names, and named segment content, timing, and channel. Title, tags, pinning, and embeddings do not change that revision. Each revision has one logical job stored inside its session JSON. Retry reuses its identity. Duplicate recording saves use the same audio-path identity and return the existing session without replacing its newer data.

Session and configuration writes use a flushed temporary sibling file and atomic rename. A session write commits the transcript revision and job together; there is no separate queue/session transaction. On restart, interrupted running jobs return to waiting and resume from the beginning. Legacy sessions do not get automatic jobs simply because the app restarted or the setting was enabled.

## Concurrency and failures

The Bun server owns one automatic worker. It starts only when capture, capture startup/shutdown, transcription, and manual notes generation are idle. Accepted transcription requests hold the resource reservation for the complete processing stream, including uploads and recovery. Capture startup reserves resources before waiting for notes cancellation. Manual generation and automatic generation share the same Ollama adapter and do not run concurrently.

Starting capture or transcription aborts background generation, discards partial notes, and waits for a bounded local model-unload attempt. The adapter uses `keep_alive: 0`; Ollama documents this option as requesting immediate unload in its [generation API](https://docs.ollama.com/api/generate). An unavailable server cannot acknowledge unload. Actual memory release and recording performance still require validation with the installed Ollama version and Mac hardware; a successful cancellation test does not establish hardware performance.

Queue state survives closing the browser and restarting the Bun server after the final meeting save. The backend owns recording and final saving, so closing every browser tab does not prevent notes from being queued after durable finalization. Generation has a five-minute timeout. Missing models, stopped Ollama, missing templates, and incomplete output become retryable job failures and never change a saved meeting into a failed recording. Progress reports output characters, not an estimated percentage. Cancel stops pending or running work; retry refreshes the configured model/template and keeps the same job identity.

## Existing notes and provenance

Nonempty existing notes, including legacy notes without provenance, are protected. An explicit replacement request must match their current content. A completed job commits only if its source revision, attempt, running state, and expected existing notes still match. Editing notes, cancelling work, deleting a meeting, or changing its transcript/speakers makes late output ineligible.

Generated notes retain the source revision, template ID/name/hash, model, output language, and completion time. Editing or retranscribing a meeting marks notes stale when their source differs. Ordinary notes edits are marked manual. Both automatic and manual generation use saved speaker-labeled segments. The adapter supplies template and transcript as separate JSON fields; template instructions control presentation while the system rules control grounding. It requests a short exact source quote and speaker for each decision/action, preserving quotes in the source language. Suggestions, rejected proposals, and open questions must remain distinct from confirmed decisions and assigned actions. Speaking about an action does not establish ownership; only explicit assignments or commitments do. Missing owners/deadlines remain unspecified, and relative dates must not be converted into invented calendar dates. Empty decision/action sections must say that none were documented. These are model instructions, not a semantic validator or a guarantee of factual accuracy; review generated notes and their excerpts against the saved transcript before using them.

## Local generation

The notes adapter allows only a loopback Ollama endpoint and rejects redirects. It checks installed model names and `/api/show` metadata before sending the transcript, rejecting cloud names and remote model/host metadata. Listing installed models does not start or download a model. Notes use no attendee, sharing, publishing, or external-service integration. Ollama supports [cloud models](https://docs.ollama.com/cloud), so checking that the server address is local alone is insufficient.

## Validation

Automated tests use temporary session/configuration directories, synthetic English and Portuguese transcripts, and a controlled local Ollama transport. They cover opt-in prerequisites, custom templates, final-save ordering and late speaker edits, duplicate finalization, retry identity, crash recovery, cancellation/preemption, source and notes compare-and-save, stale provenance, model locality/missing models, stopped Ollama, malformed or incomplete streams, all supported interface locales, and refreshed list/detail/result state. HTTP tests run an isolated Bun server and verify notes interruption/model unload before a final-transcription resource hold and resumption afterward.

Physical MacBook Air M1 and MacBook Pro M4 Pro validation, live model quality, memory pressure during real capture, and end-to-end installed-app restart recovery remain pending. Automated test results and CI do not claim those hardware outcomes.

### Repeatable live-model quality review

With capture/transcription idle, run an explicitly selected, already installed local model:

```sh
bun scripts/check-notes-quality.ts --model gemma4:e4b
# Also inspect translated notes while source excerpts retain their original language:
bun scripts/check-notes-quality.ts --model gemma4:e4b --language fr
bun scripts/check-notes-quality.ts --model gemma4:e4b --language de
```

The evaluator uses the production adapter and durable notes service with a synthetic custom template. It runs four English/Portuguese fixtures sequentially, covering confirmed/rejected/tentative decisions, explicit commitments, unassigned actions, unspecified deadlines, quoted instructions, and meetings with no commitments. It reopens the saved queue before generation and checks job identity, provenance, and duplicate-finalization preservation. It never reads personal sessions or recordings, changes settings, downloads models, installs an app, or starts services. Run it only during an idle period; the standalone evaluator does not participate in the installed app's resource scheduler.

Each run writes a private `report.json` to a new system temporary directory and prints its path. The report includes inputs, outputs, review checklists, job/provenance records, host/version metadata, elapsed time, and sampled Ollama process RSS (the second `ps` column, in KiB). Exit 0 means generation and persistence checks completed, **not** that note quality passed. Review every decision/action and source excerpt manually and record any omissions, invented assignments/dates, promoted suggestions, or incorrect quotes. A failing generation exits nonzero and still retains the review report. RSS samples do not establish peak memory, responsiveness during capture, or successful model unload. Retain evidence outside the repository and record the Ollama version/model digest alongside it.

For each Mac, also run the following installed-app acceptance scenarios with synthetic spoken content. Record actual results; do not infer them from the evaluator:

| Scenario | Required observation |
| --- | --- |
| English and Portuguese capture | Saved final transcript/speakers, playable audio, correct notes language; review grounding and missing owners/deadlines. |
| Start capture while notes run or wait | Capture starts responsively, notes yield, no partial notes persist, and the same job resumes after final transcription. Measure memory pressure and responsiveness before/during/after. |
| Missing model and stopped Ollama | Recording/audio remain saved; notes show a retryable explanation and recover with the same job identity. Do not delete the installed model solely for this test; use an isolated configuration. |
| App/server crash and restart | Queued/running jobs recover without duplicate results or replacement of manual edits. A browser refresh reflects saved progress/results. |
| Four interface locales | Settings, list/detail, retry/cancel and stale/provenance text work in English, Brazilian Portuguese, French and German without changing meeting content. |

See [macOS compatibility](macos-compatibility.md) for the declared macOS 14 minimum and separate physical OS validation requirements.

The [October 5 follow-up validation](automatic-notes-validation-2026-10-05.md) records the bounded M1 live-model experiment, observed source-excerpt limitations, and remaining acceptance.

## Waiting for shared local AI

Pending explicit chat questions receive the next free generation slot before automatic notes and task suggestions. Active generation is allowed to finish. A waiting notes job identifies the current blocker (recording, transcription, notes generation, task suggestions or chat); it does not imply that a saved final transcript is missing. Waiting reasons are read-time status, not changes to meeting content or the source revision.
