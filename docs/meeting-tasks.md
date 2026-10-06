# Local meeting tasks

Finalized meetings generate reviewable suggestions using the already selected installed local Ollama model. Heed does not download a model for this feature or publish task data externally. Select any subset, edit the fields, then choose **Add selected tasks**. A suggestion is never accepted automatically. **Select none** creates nothing; **Dismiss suggestion** records a rejection.

Task suggestions cite exact transcript quotes, speakers and segment timing when available. Explicit commitments and inferred suggestions carry separate labels. These labels are model judgments and require user review; exact quote validation establishes provenance, not the correctness of the model's interpretation. Malformed, unsupported or uncited output fails visibly without creating tasks.

A target date is optional. An ISO date or a fully specified day, spelled-out month and year in English, Brazilian Portuguese, French or German can be proposed only when its exact source phrase is cited and a deterministic parser verifies the proposed date. Relative phrases such as “next Friday,” numeric ambiguous dates and unspecified years stay unset with a review note. Users can add/change/clear dates themselves. No-date tasks never become overdue. Actual completion time is recorded separately and cleared when reopening a task.

Accepted tasks live in `tasks.json` inside the application data directory, separate from meeting notes/transcripts. Atomic local transactions and persistent acceptance tombstones prevent duplicate tasks from repeated acceptance requests, including two tabs, deleted tasks and a transcript revision restored later. Task edits require their original revision; conflicting tab edits return a reload message. Task regeneration cannot rewrite accepted tasks.

The global **Tasks** view and each meeting's **Tasks** tab offer open/completed and dated/undated filters, editing, reversible completion and deletion. Source buttons open the meeting transcript and seek audio when the original transcript revision and retained audio are available. Source quotes remain historical evidence when a transcript changes. Deleting a meeting or expiring its audio preserves accepted tasks and their quote snapshots; the source is marked deleted/unavailable. Deleting a task retains its reviewed suggestion tombstone rather than recreating it on a stale retry.

Recording and transcription preempt task generation. Interrupted generation waits for idle resources; failures can be retried from the meeting task panel. Suggestions are saved only for the current finalized transcript revision. Durable-store failures surface a retryable error without partially accepting a batch.

## Validation evidence

Synthetic automated coverage includes zero/several tasks, five suggestions with two accepted, repeated mentions, two speakers, English/Portuguese source content, relative and explicit spoken dates in all four supported languages, nullable dates, completion/reopening, task editing/deletion, transcript regeneration, A→B→A revision restoration, acceptance retries/two tabs, process restart, storage failure/recovery, meeting deletion and unavailable audio. Local Ollama transport is replaced only in integration fixtures; real routes and disk state are exercised.

UI tests cover all four interface locales, selected acceptance/dismissal, failure draft retention, date clearing, revision conflicts and unavailable-audio transcript navigation. Browser screenshots use synthetic source data and isolated local HTTP fixtures.

Physical MacBook Air M1/MacBook Pro M4 Pro acceptance, real installed-model extraction quality and interactive audio playback remain separate validation gates. Native build/self-tests target macOS 14; these do not validate every supported macOS release or physical capture device.
