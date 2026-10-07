# Local retrieval for cited meeting chat

Individual and label-scoped chat now search current finalized transcript excerpts before answering. Lexical retrieval works entirely on this Mac without embeddings, downloads or a cloud account. Choose meeting labels with **any** or **all** matching, or explicitly choose all meetings. Excluded meetings never enter ranking, cached results or generation.

Accepted meeting JSON is authoritative. The local text-free catalog and disposable SQLite index track source hashes and device-local versions. Corrections, recovery, speaker changes, accepted retranscription, imports and deletion invalidate obsolete results. Startup discovers sources in yielding slices; incremental indexing uses the existing scheduler and defers to recording, final processing, notes/tasks and pending chat. Interrupted or corrupted index generations are recovered or rebuilt without rewriting accepted transcript/audio. Portable synchronization transfers accepted source and recovery history, never the live index, cache or local version counters.

Answers preserve exact excerpt IDs, source revision, speaker and timestamp. Open citations to inspect the source or seek its original segment. Historical answers remain readable, but changed-source citations are disabled. Coverage reports selected, indexed, searched, matched, retrieved, supplied and cited source/evidence counts separately. Unknown search counts remain unknown. A complete lexical lookup means all eligible indexed postings were checked, not that every semantic answer was found. A lexical zero result invokes no model and does not claim that nothing exists in the meetings.

Default hard limits include 20,000 catalog sources/16 MiB catalog metadata, 64 MiB per accepted source record, 64 MiB SQLite databases, 192 MiB reserved rebuild working disk, 250,000 indexed evidence rows and 2,000,000 postings. Retrieval admits at most 100,000 posting rows within a 250 ms search budget, 16 winning sources/anchors and 32 excerpts. A missing/partial index can fall back to four current source records, 256 examined excerpts and 64 MiB total serialized input. The ID-only cache allows 32 entries/1 MiB with a 60-second expiry. SQLite's configured 4 MiB cache per connection is not a process-memory limit; decoded source JSON and runtime memory are separate.

Generation uses at most four calls, 5,500 UTF-8 bytes of system instructions plus complete JSON per call, and an 8,192-token context. History provides follow-up wording only and is not evidence. Omitted context, lookup interruption, index capacity, fallback and generation bounds remain visible as partial coverage. Oversized questions fail before generation. Schema and exact citation validation do not prove that a model's claims are true: inspect quoted evidence, particularly contradictions, tentative commitments and dates.

Storage settings review rebuildable search data separately from audio removals. A lower limit can clear an idle, verified search generation before considering eligible audio. Preview and Cancel retain the cache. When cache cleanup is included, Confirm retires that complete reviewed bundle before applying any listed audio removals. Cache clearing preserves transcripts and audio. Active readers, writers, reservations, missing members or uncertain ownership prevent cache retirement. Subsequent chat uses bounded current-source fallback until there is space to rebuild; the preview never lists internal database paths as recordings.

Optional multilingual embeddings are a separate, explicitly invoked QA experiment. They are not an application default, installer dependency, background model or provider. The measured pinned MiniLM experiment did not improve the authored Portuguese cohort and used approximately 1.3 GiB process RSS. Keep lexical retrieval useful and inspect the measured limitations in [the acceptance report](qa/issue-69-local-retrieval.md). No transcript or embedding upload is enabled by this feature.

## Reproducible public evaluation

From an isolated checkout with frozen dependencies:

```sh
bun scripts/benchmark-retrieval.ts --output /private/tmp/retrieval-lexical.json --seed 69 --meetings 1,100,1000 --iterations 5
node scripts/qa/retrieval-ui.mjs --output /private/tmp/retrieval-ui
```

Build the client before the browser runner. It uses authored synthetic sources, valid silent WAVs, real production HTTP/SQLite and a local generator stub solely for mechanics. CI runs the browser workflow and a single-iteration lexical mechanics check without downloading models; the published five-iteration two-Mac measurements remain separate. Optional QA Python dependencies are pinned in `scripts/qa/requirements-retrieval-embeddings.txt`; use a separate environment and the explicitly verified licensed model cache. The embedding runner records artifact identities/resources and must be invoked with network access denied. Generated artifacts belong outside the checkout.

For semantic output assessment, explicitly select an already installed model while the local provider is idle:

```sh
bun scripts/qa/retrieval-generation.ts --model existing-local-model --output /private/tmp/retrieval-generation.json
```

This command never downloads a model or changes installed application settings. It records actual generated claims/failures separately from recall and structural citation checks. Local model accuracy is not guaranteed by successful retrieval. Use synthetic or licensed fixtures; keep private meetings, recordings and raw diagnostics outside tracked source.
