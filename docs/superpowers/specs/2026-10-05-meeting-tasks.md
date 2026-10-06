# Meeting tasks (#15)

After finalized transcription, Heed extracts suggestions locally using the selected installed Ollama model. Generation never accepts a task. Each suggestion includes exact validated transcript evidence, an explicit/inferred label, editable title/description, optional assignee and a nullable date. Fully specified named-month dates in the four supported languages are deterministically verified. Relative or ungrounded dates remain unset and carry a review note. Unsupported or malformed model output fails visibly and may be retried.

A separate atomic local task store owns suggestions and accepted tasks. Selecting a subset and accepting it is a synchronous transaction keyed by stable suggestion IDs; repeated requests or two browser tabs cannot duplicate tasks. Generation snapshots the transcript revision and discards outdated results. Accepted tasks survive regeneration, meeting deletion and audio expiration. Historical evidence remains readable; current source availability is derived from the meeting and audio file rather than promised from a stale snapshot.

Meeting and global task views support editing, dismissing suggestions, accepting none, date clearing, reversible completion with actual completion timestamps, task deletion and open/completed plus dated/undated filters. Sources link to the originating meeting and audio timestamp when available. All UI strings support English, Brazilian Portuguese, French and German. User-authored transcript/task text stays unchanged. No dependencies or external publishing.

Validation uses only synthetic isolated app data. Automated tests do not prove physical M1/M4 or all macOS 14+ behavior; those acceptance gates remain explicit.
