# Bounded Local Retrieval Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development for the user-selected agent execution, with one owner per task and independent review of each stable commit. Tasks below share interfaces and execute sequentially. Root coordinates assignments; do not edit the unfinished #7 branch.

**Goal:** Replace sampled meeting/library chat scans with bounded, incremental, scope-safe lexical retrieval and exact accepted-source citations; measure a real optional local embedding experiment without making it a production dependency.

**Architecture:** Observe #7's committed source boundary into a text-free catalog, tokenize accepted evidence through chunk-local SQLite FTS5, store direct scoped postings in disposable versioned SQLite generations, and materialize current source evidence before bounded generation. Scope/version checks protect index/cache/citation use. Existing quota and AI scheduler own admission.

**Tech Stack:** Bun/TypeScript, `bun:sqlite`, current JSON session storage/ManagedQuota, React/Vitest and existing structured local generation. An isolated temporary Python QA environment is permitted only for the explicitly invoked real-model evaluation.

**Spec:** [Issue #69 architectural specification](../specs/2026-10-06-issue-69-local-retrieval.md).

## Prerequisite and ownership

- [ ] Before product implementation, fetch and rebase this dedicated issue branch on completed reviewed #7. Record the exact merged commit in `docs/qa/issue-69-local-retrieval.md`. Reconcile the source-writer audit and names below with that commit; changes to the agreed interface need root review, not silent alternate hooks.
- [ ] Confirm #7's `SessionTags.commitSource`, `commitTranscriptState`, `AutomaticNotesService.commitTranscript/replaceAccepted`, portable v2 import and metadata-only save protections are present. Reuse them; do not duplicate guards/version increments or change portable artifacts to carry indexes.

Own new retrieval modules and the narrow existing-file integrations below. Preserve current chat schema/evidence rules, recording/finalization admission, source history and provider publication. English project text, four UI locales, private QA data outside Git, no author trailers. No new model/daemon/production dependency. No hidden download or installed-venv mutation.

## Locked interfaces and defaults

Create shared type-only `packages/shared/types/retrieval.ts`; export its types through `packages/shared/index.ts`. Server implementation lives in `packages/server/lib/`. Keep Node crypto/SQLite runtime code out of the browser shared barrel.

```ts
type RetrievalStrategy = 'lexical' | 'fallback';
type RetrievalPartialReason = 'index-missing' | 'index-stale' | 'index-capacity'
  | 'fallback-limit' | 'query-budget' | 'context-budget' | 'generation-limit';
interface RetrievalSourceStamp {
  sessionId: string; sourceRevision: string; transcriptVersion: number;
}
interface RetrievalSnapshot {
  key: string; sources: RetrievalSourceStamp[];
}
interface RetrievalCoverage {
  version: 1; strategy: RetrievalStrategy;
  selectedMeetings: number; selectedEvidence: number;
  indexedMeetings: number; indexedEvidence: number;
  searchedMeetings: number; searchedEvidence: number | null;
  matchingRowsVisited: number; matchedEvidence: number;
  retrievedEvidence: number; retrievedMeetings: number;
  suppliedEvidence: number; suppliedMeetings: number;
  citedEvidence: number; citedMeetings: number;
  indexComplete: boolean; lookupComplete: boolean; generationComplete: boolean;
  partialReasons: RetrievalPartialReason[];
}
interface RetrievalHit extends RetrievalSourceStamp {
  evidenceId: string; evidenceOrdinal: number; score: number;
}
interface RetrievalResult {
  snapshot: RetrievalSnapshot; generationId: string | null;
  hits: RetrievalHit[]; coverage: RetrievalCoverage;
}
```

Add `ChatCoverage.retrieval?: RetrievalCoverage`; old persisted turns require no migration. Index-only stage/cache results initialize supplied/cited counts to zero. Generator assembly and validated claims own those later counters. A partial lookup's `matchedEvidence` counts unique fully examined matches, not an estimate of all matches; `matchingRowsVisited` counts posting rows actually processed. `searchedMeetings` counts sources whose lookup began, not all selected sources. For an interrupted lookup set searchedEvidence=null. A complete lookup may count all eligible indexed evidence as searched even though nonmatching quotes were not read.

Server contracts:

```ts
type CommittedSessionChange =
  | {kind:'upsert'; session:Session}
  | {kind:'delete'; sessionId:string}
  | {kind:'invalidate'};
// A tag transaction emits upserts only after its committed journal is durable.
// Recovery/discovery uncertainty emits invalidate; never expose tentative state.
SessionTags.subscribeCommitted(
  listener:(change:CommittedSessionChange)=>void,
  onError:(error:unknown)=>void
):()=>void;

interface RetrievalDescriptor extends RetrievalSourceStamp {
  title:string; tags:string[]; finalized:boolean;
  nonempty:boolean; evidenceCount:number;
}
class RetrievalCatalog {
  state():'discovering'|'ready'|'capacity'|'unavailable';
  resolve(scope:{kind:'meeting';sessionId:string}|
    {kind:'library';scope:LibraryChatScope}):
    {snapshot:RetrievalSnapshot;descriptors:RetrievalDescriptor[]};
  validate(snapshot:RetrievalSnapshot):void; // source/scope/version conflict
  reconcile(signal?:AbortSignal):Promise<void>;
  observe(change:CommittedSessionChange):void;
}
function iterateTranscriptEvidence(session:Session):IterableIterator<TranscriptEvidence>;
function normalizeRetrievalQuery(question:string):string[];
class RetrievalIndex {
  search(snapshot:RetrievalSnapshot,terms:string[],signal?:AbortSignal):Promise<RetrievalResult>;
  enqueue(change:CommittedSessionChange):void;
  tick(signal?:AbortSignal):Promise<void>;
  rebuild(signal?:AbortSignal):Promise<void>;
  close():void;
}
class MeetingRetriever {
  retrieve(snapshot:RetrievalSnapshot,question:string,signal?:AbortSignal):Promise<RetrievalResult>;
  materialize(result:RetrievalResult,signal?:AbortSignal):Promise<TranscriptEvidence[]>;
  close():void;
}
```

`CommittedSessionChange` is server-only and belongs in `session-tags.ts`; the `SessionTags` line above specifies a class method, not standalone TypeScript syntax. Catch listener failures after durable persistence, invoke the subscriber's onError, and retain source success. Retrieval's onError synchronously marks the catalog unavailable and clears retrieval cache without parsing/SQL; failure diagnostics contain no transcript. Catalog construction consumes `{store:SessionTags,isBusy:()=>boolean,now:()=>number,policy:RetrievalPolicy}`; index consumes `{directory:string,catalog:RetrievalCatalog,store:SessionTags,quota:ManagedQuota,isBusy:()=>boolean,policy:RetrievalPolicy,now:()=>number}`; retriever consumes `{catalog,index,store,policy,now}`. Inject clocks/policy for real bound tests. `resolve` returns sorted normalized current descriptors, throws `retrieval-not-ready` for discovering/unavailable and `retrieval-capacity` for capacity, and never guesses a selection. Empty usable scope preserves existing chat errors. Meeting lookup does not inherit library history.

Snapshot key hashes normalized scope plus selected session IDs, source hashes, local versions, titles and normalized tags in stable binary order. Before cache/SQL access call catalog.validate; before each source load and after awaits validate source hash/version. The library service retains its public LibraryChatSnapshot and request guards, additionally capturing the device-local RetrievalSnapshot per attempt. Meeting service captures one stamp per attempt. Hash-only public snapshots must not bypass the private local version guard during a running generation.

Define `RetrievalPolicy` in `retrieval-policy.ts` with these exact production hard maxima: catalogSources=20_000; sourceRecordBytes=67_108_864; databaseBytes=67_108_864; workingDiskBytes=201_326_592; evidenceRows=250_000; postingRows=2_000_000; evidenceSlice=128; queryRows=100_000; queryMilliseconds=250; queryTerms=64; queryCharacters=2_000; queryBytes=8_000; candidateHits=64; globalHits=48; sourceWinners=16; anchors=16; excerpts=32; fallbackSources=4; fallbackEvidence=256; fallbackSourceBytes=67_108_864; cacheEntries=32; cacheBytes=1_048_576; cacheTTLMilliseconds=60_000; sqliteCacheKiB=4096; generationCalls=4; generationInputBytes=5_500; generationContextTokens=8_192. Tests may reduce maxima. Production overrides cannot increase them. Require globalHits+sourceWinners<=candidateHits and anchors<=candidateHits. Reconciliation interval is 30_000 ms; read one source per idle reconciliation tick. SQLite page size=4096, max_page_count=16384, journal_mode=DELETE, temp_store=MEMORY, mmap_size=0. Index path is `join(LIBRARY_DIR,'indexes','retrieval')`.

## Review focus

1. Excluded sources leaking into candidate lookup, scores, caches or neighbor expansion → Task 4 SQL traces/excluded-source invariance and Task 5 production generator spy.
2. Accepted correction/import/deletion or ABA leaving stale current evidence → Task 2 event/rollback audit, Task 3 revision replacement and Task 5 held-generation HTTP tests.
3. Database/journal/staged generation exceeding quota or interrupted rebuild activating partial state → Task 3 actual SQLite/full/quota/pointer-recovery tests.
4. Lookup readiness mistaken for full model/semantic coverage → Task 5 counter/zero-hit/context truncation tests and Task 6 four-locale UI tests.
5. Benchmark fixtures/fake vectors being reported as actual optional-model/resource evidence → Task 7 pinned real-model measurements and Task 8 evidence review.

## Task 1: Pure evidence, tokens and coverage contracts

**Files:** Create `packages/shared/types/retrieval.ts`, `packages/server/lib/retrieval-policy.ts`, `retrieval-tokenizer.ts`, `retrieval-tokenizer.test.ts`, `retrieval-evidence.test.ts`. Modify shared `types/chat.ts`, `index.ts`, server `meeting-chat.ts`.

**Deliverable:** Named types/defaults; lazy evidence iterator with byte-compatible IDs/quotes/locations; per-chunk scratch FTS5 tokenization and input validation. `transcriptEvidence` stays an array wrapper for existing callers. No new ranking/chat behavior yet.

- [ ] Write golden old/new evidence equality for segmented/untimed source, oversized paragraph, empty text, surrogate-pair split, speaker/timing correction and EN/PT accents; candidate/history text never appears.
- [ ] Write real SQLite capability/token tests for accented names, underscores/punctuation, composed/decomposed marks, literal SQL-looking input, 64-term/8,000-byte boundaries and raw NUL/invalid scalars. Capability failure selects a typed unavailable state; no extension download.
- [ ] Run `bun test packages/server/lib/retrieval-evidence.test.ts packages/server/lib/retrieval-tokenizer.test.ts`; require meaningful missing-behavior failures before implementation.
- [ ] Implement iterator and a one-chunk scratch tokenizer using parameterized INSERT; query vocab, then clear scratch. Query normalization returns distinct binary-sorted terms; scores use no global stats. Validate internal policy dimensions.
- [ ] Rerun focused tests and existing `meeting-chat.test.ts`; require zero failures. Commit `feat: define bounded local retrieval contracts`.

## Task 2: Source observer and text-free scope catalog

**Files:** Modify server `session-tags.ts`; create `retrieval-catalog.ts`, `retrieval-catalog.test.ts`, `retrieval-source-events.test.ts`. Extend #7 `transcript-persistence.test.ts` and portable integration tests only for observer assertions. Existing writer names must match the completed #7 audit.

**Deliverable:** `subscribeCommitted`, catalog descriptors and readiness/scope validation. Update committed source/remove/tag/save paths centrally, including transaction recovery and portable replacements; never emit source payloads to remote listeners.

- [ ] Write event ordering tests: successful persisted source/version before notification, failed write no upsert, tag rollback no tentative state, committed tag recovery, delete missing/current, candidate/notes metadata no retokenization, imported current text only. Throwing listener preserves successful source acknowledgment and emits invalid catalog state through a guarded subscriber failure path.
- [ ] Write catalog tests for discovery batches/no retained transcripts, ready/count states, any/all/empty tags, changed title/tag/source version, 20,000+1 capacity, 64-MiB raw-record before-parse bounds, concurrent initial discovery and source commit, deletion during discovery, observer failure/reconcile and restart. A stale discovery read cannot overwrite a newer committed stamp. A record with valid large local candidates remains indexable below the raw bound; accepted projection limits do not incorrectly reject it.
- [ ] Run `bun test packages/server/lib/retrieval-source-events.test.ts packages/server/lib/retrieval-catalog.test.ts packages/server/lib/transcript-persistence.test.ts`; observe red behavior tests.
- [ ] Implement synchronous descriptor replacement/deletion and bounded background source discovery. Avoid `notesService.list()`/SessionTags.snapshot() on every retrieval; the catalog stores metadata only. Count evidence lazily without quote retention. Resolve snapshots using current catalog metadata; unavailable state prevents cache/query use.
- [ ] Rerun focused tests plus `session-tags.test.ts` and final #7 portable integration cases; require zero failures. Commit `feat: track accepted sources for scope-safe retrieval`.

## Task 3: Disposable SQLite index, reservations and recovery

**Files:** Create `retrieval-index.ts`, `retrieval-index.test.ts`, `retrieval-index-recovery.test.ts`. Modify `app-storage.ts` only if root registration needs adjustment; existing indexes root already owns the new path. No portable-schema field changes.

**Deliverable:** `RetrievalIndex` generation lifecycle and transactional source replacement, using manifest/chunks/direct-postings tables. Source manifest stores exact hash/version, total/indexed counts, partial prefix/configuration. Database metadata stores schema/config/generation ID. Current generation pointer is private atomic JSON.

- [ ] Write real on-disk SQLite tests: indexed exact evidence, update/delete/import, metadata-only cache change, obsolete queued stamp discarded, partial prefix limits, duplicate IDs, rollback/FULL/write fault, DELETE-journal cleanup and reopen. Reserve before growing pages/transaction; assert physical DB+sidecar bytes remain within allocation.
- [ ] Write interruption tests at staged DB creation, source replacement, before pointer publish and after pointer publish/before old cleanup. New generation publication requires manifest/config verification and fsync; old reader retains its generation until close. Invalid/corrupt DB disables derived data and preserves every authoritative source byte.
- [ ] Run `bun test packages/server/lib/retrieval-index.test.ts packages/server/lib/retrieval-index-recovery.test.ts`; verify red tests before implementation.
- [ ] Implement private generation dirs, schema/checks/FKs, compound posting index and capped page/row counts. One source's rows commit together; partial prefixes are intentional manifests. Source transactions reserve at most active DB+worst-case journal (128 MiB); rebuild reserves old+staged DB+staging journal (192 MiB) through ManagedQuota, accounting existing files once. Reservations cover owned paths, release after sidecar cleanup, and recover by an explicit `retrieval-*` owned-reservation audit. Avoid persistent idle overreservation.
- [ ] Stage new generations, atomically activate a verified pointer, and retire old data with reference-counted readers. Keep only one staged generation; preserve prior compatible active generation on quota/failure. Mismatched-schema old data cannot serve queries. Use `rebuild` behind maintenance admission; bounded slices yield/check current source/busy. Clean obsolete/deleted rows before new growth.
- [ ] Rerun focused tests plus `managed-quota.test.ts`; require zero failures and no unowned temp data. Commit `feat: maintain a bounded disposable transcript index`.

## Task 4: Scoped lexical search, materialization and bounded cache/fallback

**Files:** Create `meeting-retrieval.ts`, `meeting-retrieval.test.ts`, `retrieval-scope.test.ts`, `retrieval-cache.test.ts`; extend index tests for query access paths.

**Deliverable:** `MeetingRetriever` and scoped index.search. Deterministic score/diversity/neighbors, bounded IDs-only LRU, and useful bounded accepted-source fallback.

- [ ] Write known-answer fixtures missed by 80-sample scanning; assert exact scores/order for EN/PT, repeated names/accents, distinct terms, ties and source diversity. A source with over 64 high-scoring repetitions cannot crowd another matching source out of its protected winner slot. Excluded-only evidence never reaches SQLite row results, materialization, cache or generation candidates; excluded additions do not affect eligible scores/counters/order/cache hits while quotas are unchanged.
- [ ] Write query-plan/trace assertions for composite `(sessionId,sourceRevision,term)` lookups; forbid global MATCH/BM25. Use per-term source-qualified keyset queries `evidenceOrdinal > cursor ORDER BY evidenceOrdinal LIMIT 128`; merge at most 64 sorted streams by ordinal to calculate every matched term for one candidate. Do not scan all nonmatching chunks or hide unbounded GROUP BY/sorting inside LIMIT. Bound raw matched posting rows read, including prefetched pages; discard an incomplete candidate if the read/deadline budget binds mid-aggregation. Check exact deadline/busy/abort pagination, at most 8,192 buffered posting rows and the bounded 48-global/16-source-winner heaps. Select protected winners before filling anchors from remaining global hits.
- [ ] Write fallback/cache tests: missing/stale/partial index, punct-only queries, no term match, selected-source guards, 4-source/256-excerpt/64-MiB limits, source read before stale return, edit/revert version invalidation, TTL/LRU/byte eviction, generation/config changes, selected-source indexing progressing within the same generation and no full quotes in cache. Cache keys include selected-source manifest epochs so partial coverage cannot survive a completed replacement. Excluded-source progress does not invalidate eligible cache entries. Exact cached IDs must materialize from current source with matching quote/location.
- [ ] Run `bun test packages/server/lib/meeting-retrieval.test.ts packages/server/lib/retrieval-scope.test.ts packages/server/lib/retrieval-cache.test.ts`; confirm red behavior tests.
- [ ] Implement per-source scoped SQL and deterministic scoring/selection. If a source lacks usable current index rows, bounded fallback may inspect it; combine disjoint indexed/fallback evidence without double counting, record strategy=fallback if any fallback is used, and always mark index gaps. Apply all candidate/neighborhood limits after eligibility. No-term/zero-hit behavior follows the spec.
- [ ] Rerun all retrieval tests; require zero failures. Commit `feat: retrieve scoped meeting evidence without global ranking`.

## Task 5: Existing chat integration and exact coverage/citations

**Files:** Modify `meeting-chat.ts`, `library-chat.ts`, `server.ts`; extend `meeting-chat.test.ts`, `library-chat.test.ts` and HTTP tests; create `retrieval-chat.http.test.ts`.

**Deliverable:** Inject `retriever:MeetingRetriever` and `catalog:RetrievalCatalog` into both chat services. `answerMeetingQuestion` consumes retrieved evidence/coverage rather than scanning entire Session arrays. Production passes per-attempt RetrievalSnapshot; tests may inject a controlled retriever, but actual HTTP integration uses real SQLite/source storage.

- [ ] Write actual HTTP tests for accepted corrections/rename/delete/portable replacement during held retrieval/generation, version-only ABA and stale public library snapshot. Existing thread/attempt/controller/history guards must reject obsolete commit. Only supplied IDs validate; malicious quotes/forged citations remain rejected.
- [ ] Write counter tests across complete indexed lookup, partial row/deadline/fallback lookup, zero lexical hits, truncated context and canceled generation. Indexed/search/match/retrieval/supply/citation counts remain distinct and unique. Empty lexical result returns zero claims without calling a generator; legacy complete=false for every retrieval turn.
- [ ] Write complete JSON UTF-8 input bounds including escaped quotes, long IDs/question/history and multibyte text. At most four generator requests, each <=5,500 bytes/8,192 context tokens. Preserve exact quotes; oversized request budgeting omits evidence/history with context reason or actionable error rather than trimming a quote. Retain existing 40-claim/12-per-response validation.
- [ ] Run `bun test packages/server/lib/retrieval-chat.http.test.ts packages/server/lib/meeting-chat.test.ts packages/server/lib/library-chat.test.ts`; verify failures reflect retrieval behavior.
- [ ] Wire readiness through `AiWaitingReason`'s new `retrieval` value and queue status; catalogue capacity/unavailable errors become actionable chat failures, not infinite silent waiting. Discovery readiness and index maintenance share the existing scheduler without pending-chat deadlock: queued chat waits only for catalog discovery, then missing index uses fallback. Preempt/close retrieval work with owned capture/shutdown paths. Observe committed source centrally and tick background indexing after mandatory/pending AI work, never from a second competing timer governor.
- [ ] Rerun `meeting-chat.http.test.ts`, `library-chat.http.test.ts`, `ai-queue.http.test.ts`, `processing-maintenance.test.ts`, `portable-preemption.test.ts` and `recording-coordinator.test.ts`; require zero failures. Commit `feat: ground chat in bounded current-source retrieval`.

## Task 6: Coverage presentation and four locales

**Files:** Modify client `components/chat/MeetingChat.tsx`, `LibraryChat.tsx`, `chat-errors.ts`, translation files `translations-chat.ts`, `translations-library-chat.ts`; create `lib/translations-retrieval.ts` and tests; extend both chat component tests. Update existing AI waiting-reason renderers found by `rg 'AiWaitingReason|waitingReason'` with the retrieval label; record exact touched files before edits.

**Deliverable:** Existing chat UI displays selected/searched/retrieved/cited meetings, supplied excerpts, readiness/capacity errors and specific partial reasons using versioned coverage. Old stored turns preserve previous labels. No chat navigation/layout redesign.

- [ ] Write component tests for zero matches with full lexical lookup (no whole-scope absence claim), null unknown searchedEvidence, partial fallback/context limits, source-stale citations, old coverage compatibility and interrupted waiting. All content remains escaped text; existing seek navigation and keyboard/focus work.
- [ ] Run `NODE_OPTIONS=--no-experimental-webstorage bun run --cwd packages/client test --run src/components/chat/MeetingChat.test.tsx src/components/chat/LibraryChat.test.tsx src/lib/translations-retrieval.test.ts`; require meaningful failures.
- [ ] Implement restrained status lines and four-locale labels; no fractional or inferred search counts. Keep unsupported legacy absence text out of new retrieval rendering. Update typed waiting reason mappings exhaustively.
- [ ] Rerun focused client tests and `bun run --cwd packages/client typecheck`; require zero failures. Commit `feat: show truthful retrieved-evidence coverage`.

## Task 7: Ground-truth quality and actual optional-model resource evaluation

**Files:** Create `scripts/benchmark-retrieval.ts`, `scripts/qa/retrieval-embeddings.py`, `packages/server/lib/retrieval-benchmark.test.ts`, `docs/qa/fixtures/retrieval/manifest.json`, authored EN/PT fixture/query files and public ground-truth expectations. QA model dependencies belong to a pinned optional QA requirements file; not installer/runtime requirements. Create `docs/qa/issue-69-local-retrieval.md`.

**Deliverable:** Reproducible real lexical versus old-sampling measurements and an actual bounded optional local embedding/hybrid experiment. Embedding path is a QA-only command, not an app default or test model download. Fixtures include positives, paraphrases, contradictions, dated tentative updates, no answers, any/all scope and excluded-only answers; expected sets distinguish relevant contradictory evidence rather than reducing truth to a single latest mention.

- [ ] Write fixture/harness tests for stable seed/evidence IDs, between-sample placement, mixed/PT/EN partitions, expected recall/precision calculations, source/version scoping and bound counters. Test fake vectors only for mechanics and label those results non-quality. Run `bun test packages/server/lib/retrieval-benchmark.test.ts` red then green around harness implementation.
- [ ] Implement benchmark CLI with `--output <private-path> --seed 69 --meetings 1,100,1000 --iterations 5`. Emit commit/config/fixture digests, per-query IDs/recall@8/@16/evidence+source precision, negative-query false support, cold/warm timing, index throughput, process peak RSS and DB/journal bytes. Benchmark current sampling with the same deterministic fake generator to measure supplied-ground-truth recall; report generated quality separately using an explicitly selected installed chat model. Never claim fake generator output measures model correctness.
- [ ] Explicitly invoke optional embedding QA with pinned revision/model path. Prefer cached licensed multilingual weights; otherwise display metadata and use a separate temporary QA cache/environment for the authorized download of the spec's pinned MiniLM model. Do not mutate installed Python/Heed environments or use remote inference. Record exact artifact SHA256/license/runtime versions and network-off local loading. Window at model token capacity, mean-pool/normalize actual outputs, and scope-filter eligible current source vectors before similarity. Compare embedding-only and reciprocal-rank hybrid against lexical on the same fixtures; hold history out of retrieval truth.
- [ ] Run actual measurements on available M1 Air and M4 Pro under idle admitted conditions. Enforce 1-GiB model-artifact/2-GiB RSS limits, CPU-only one worker/batch8, temp vectors and no background residency; record resource-limit failures and missing hardware rather than substitute fixture timing. Measure cold load, warm query, incremental source embedding and actual observed peak memory. Keep successful optional experiments off by default regardless of measured improvement.
- [ ] Publish only synthetic/licensed evidence/configuration and summarized hardware results. Preserve private raw QA/model files outside Git, clean owned temporary workers/environments after runs. Document exact PT/EN recall changes and tradeoffs; no fixed-percent performance promise. Commit `test: measure local retrieval quality and optional embeddings`.

## Task 8: Integrated acceptance, independent review and handoff

**Files:** Create `docs/local-meeting-retrieval.md`; complete QA report; add one integrated `retrieval-workflow.http.test.ts` only for workflows not covered above. Existing fixtures must not be weakened to accommodate changed behavior.

- [ ] Verify production HTTP finalization → index → scoped chat → #7 correction/revert/candidate acceptance → import/delete → restart, with current IDs/quotes/navigation and unchanged accepted audio bytes. Inject a held generator, quota failure and interrupted generation publication; require no stale current citation and useful bounded fallback. Use synthetic fixtures and owned ephemeral services only.
- [ ] Run focused retrieval/server chat/source/portable suites, complete server lib suite, client tests/typecheck, `bun run build` and `git diff --check`. Record independently verified inherited compiler diagnostics without calling them new retrieval defects. Baseline installation/setup follows repository instructions when implementation begins; no setup was executed for these docs.
- [ ] Inspect existing chat UI with synthetic data in four locales, keyboard/narrow layout and partial/readiness conditions. Check supported macOS/Bun packaged capability separately. Runtime/manual evidence and optional-model resource outcomes stay distinct from unit/CI evidence; invent no additional unrelated issue gate.
- [ ] Review every acceptance row against actual recorded evidence. Resolve scope/staleness/quota/citation blockers; document lexical paraphrase recall limitations and measured optional-model tradeoffs. Obtain whole-branch independent review at a stable exact commit.
- [ ] Carry out root-coordinated authorized integration only after applicable checks pass: audit intended changes, commit/push all repository work, verify fetched remote HEAD equality, stop owned services, safely remove the clean issue worktree from outside it and verify absence per AGENTS.md. Root owns PR/merge/issue-state actions; this documentation task does not push or create a PR.

## Plan self-review

Spec coverage: canonical source and portability (prerequisite, Tasks 1–3/8), scope-safe ranking/cache (2/4/5), bounded storage/recovery/admission (3–5), exact citations/coverage/locales (5–6), meaningful optional-model evidence (7–8). Interface names/limits above are shared by producers and consumers; index IDs retain the old source-revision serialization. A full index lookup never sets semantic complete. No product code or benchmark result is claimed by this plan. Root review of these documents is the next execution step; task-specific independent review remains required during implementation.
