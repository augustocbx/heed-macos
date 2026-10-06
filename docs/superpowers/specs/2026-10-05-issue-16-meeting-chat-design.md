# Local meeting chat — issue 16

Users can question one saved final meeting using an installed local model. History is durable and local. Each factual answer carries server-validated revision-qualified transcript citations; imported instructions are data and no tools are available. English and Portuguese questions/content are independent of the four interface locales.

Canonical evidence contains a meeting ID, transcript revision, segment ordinal/derived ID, exact source quote, speaker, and nullable audio times. Text-only meetings use paragraph evidence. Evidence from older revisions remains visibly stale and never seeks an unrelated replacement segment.

A separate chat ledger under HEED_APP_DIR stores threads, turns, request identities, model choice, generation state and coverage. Generation snapshots source/thread versions; cancellation, clearing, deletion, revision changes and restart prevent late persistence. Retries reuse the original question; only completed and validated output becomes a successful answer.

Short transcripts are provided whole. Long transcripts are scanned chunk by chunk and evidence is reduced to a bounded final context, with visible reviewed/total counts and reduction limits. Bounded scans never claim meeting-wide absence. Broad questions inspect all available chunks. Model output is structured JSON; references must resolve to supplied source IDs and quotes, unknown citations fail closed. Citation validation establishes provenance, not guaranteed semantic entailment; real-model quality evaluation remains required.

Existing Ollama transport guards are shared without changing notes semantics. Recording and final ASR preempt chat and unload the model before continuing. A separate chat tab offers model selection, send, cancel, retry and clear. Citations navigate to transcript text and audio when available. Deleting a meeting removes its owned chat; expired audio does not remove transcripts/history.

Validation uses synthetic bilingual fixtures, isolated storage, fake local transport, server tests, interface tests, full build and existing CI checks. Physical-Mac model quality/performance and every macOS 14+ release cannot be claimed from automated fixtures.
