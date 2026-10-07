#!/usr/bin/env bun
/** Explicit public-corpus QA. Disposable source/index files never enter the checkout. */
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir, hostname, release, totalmem } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { SessionTags, transcriptGuard } from '../packages/server/lib/session-tags';
import { RetrievalCatalog } from '../packages/server/lib/retrieval-catalog';
import { RetrievalIndex } from '../packages/server/lib/retrieval-index';
import { MeetingRetriever } from '../packages/server/lib/meeting-retrieval';
import { createRetrievalPolicy } from '../packages/server/lib/retrieval-policy';
import { ManagedQuota } from '../packages/server/lib/managed-quota';
import { createRetrievalCorpus, legacySuppliedEvidence, scoreRetrieval } from './qa/retrieval-corpus';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sourceIds = (ids: string[]) => [...new Set(ids.map((id) => id.split(':')[0]!))];
function disk(path: string): number {
  if (!existsSync(path)) return 0;
  const info = statSync(path);
  return info.isDirectory()
    ? readdirSync(path).reduce((sum, name) => sum + disk(join(path, name)), 0)
    : info.size;
}
const score = (ids: string[], truth: string[], k: number) => ({
  ...scoreRetrieval(ids, truth, k),
  source: scoreRetrieval(sourceIds(ids.slice(0, k)), sourceIds(truth), k),
});
const milliseconds = (start: number) => performance.now() - start;
export async function benchmarkCohort(count: number, seed: number, iterations: number) {
  const corpus = createRetrievalCorpus(count, seed),
    root = mkdtempSync(join(tmpdir(), 'heed-retrieval-benchmark-'));
  const sessions = join(root, 'sessions'),
    directory = join(root, 'indexes');
  mkdirSync(sessions);
  mkdirSync(directory);
  const store = new SessionTags(sessions),
    policy = createRetrievalPolicy(),
    now = () => performance.now();
  const catalog = new RetrievalCatalog({ store, policy, now, isBusy: () => false });
  const quota = new ManagedQuota({
    ledgerPath: join(root, 'quota.json'),
    roots: { text: [sessions], indexes: [directory] },
    getLimit: () => 1_000_000_000,
    setLimit: () => {},
    protectedPaths: () => [],
  });
  const index = new RetrievalIndex({ directory, catalog, store, policy, quota, now, isBusy: () => false });
  const retriever = new MeetingRetriever({ catalog, index, store, policy, now });
  try {
    // The actual store adopts canonical source versions, rather than injecting index rows.
    for (const meeting of corpus.meetings) store.commitSource(meeting.id, null, () => meeting);
    let start = now();
    await catalog.reconcile();
    const discoveryMilliseconds = milliseconds(start);
    start = now();
    await index.tick();
    const indexMilliseconds = milliseconds(start);
    const all = catalog.resolve({ kind: 'library', scope: { mode: 'all', labels: [], match: 'any' } });
    const description = index.describe(all.snapshot),
      indexedEvidence = description.sources.reduce((sum, source) => sum + source.indexedEvidence, 0);
    if (
      !description.generationId ||
      description.sources.some((source) => !source.current || source.indexedPrefix !== source.totalEvidence)
    )
      throw Error('Public QA corpus must be completely indexed');
    const questions = [];
    for (const question of corpus.questions) {
      const selected = catalog.resolve(question.scope),
        selectedIds = new Set(selected.snapshot.sources.map((source) => source.sessionId));
      const old = legacySuppliedEvidence(
        corpus.meetings.filter((meeting) => selectedIds.has(meeting.id)),
      ).map((item) => item.id);
      const timings = [];
      let result, evidence;
      for (let iteration = 0; iteration < iterations; iteration++) {
        start = now();
        result = await retriever.retrieve(selected.snapshot, question.question);
        evidence = await retriever.materialize(result);
        timings.push(milliseconds(start));
        if (evidence.some((item) => !selectedIds.has(item.sessionId)))
          throw Error('Excluded source leaked into materialization');
      }
      const ids = evidence!.map((item) => item.id);
      questions.push({
        id: question.id,
        language: question.language,
        kind: question.kind,
        question: question.question,
        relevantEvidenceIds: question.relevantEvidenceIds,
        eligibleSessionIds: [...selectedIds],
        lexicalIds: ids,
        lexical: {
          8: score(ids, question.relevantEvidenceIds, 8),
          16: score(ids, question.relevantEvidenceIds, 16),
        },
        legacySuppliedIds: old,
        legacySupplied: score(old, question.relevantEvidenceIds, old.length || 1),
        coverage: result!.coverage,
        coldQueryMilliseconds: timings[0],
        warmQueryMilliseconds: timings.slice(1),
        qualityKind:
          'actual lexical retrieval; legacy supplied recall; no generated answer correctness claim',
      });
    }
    const accepted = store.read(corpus.meetings[0]!.id)!;
    start = now();
    store.commitSource(accepted.id, transcriptGuard(accepted), (current) => ({
      ...current!,
      segments: current!.segments.map((segment, ordinal) =>
        ordinal === 1 ? { ...segment, text: segment.text + ' IncrementalSyntheticMarker.' } : segment,
      ),
    }));
    await index.tick();
    const incrementalMilliseconds = milliseconds(start);
    const pointer = JSON.parse(readFileSync(join(directory, 'active.json'), 'utf8'));
    const result = {
      meetings: count,
      seed,
      fixtureSha256: digest(corpus),
      policy,
      discoveryMilliseconds,
      indexMilliseconds,
      indexedEvidence,
      evidencePerSecond: indexedEvidence / (indexMilliseconds / 1000),
      incrementalMilliseconds,
      databaseBytes: statSync(join(directory, pointer.generationId, 'index.sqlite')).size,
      workingDiskBytes: disk(directory),
      reservedQuotaBytes: quota.snapshot().reservedBytes,
      observedPeakRssBytes: process.resourceUsage().maxRSS * 1024,
      questions,
    };
    return result;
  } finally {
    retriever.close();
    index.close();
    catalog.close();
    rmSync(root, { recursive: true });
  }
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      output: { type: 'string' },
      seed: { type: 'string', default: '69' },
      meetings: { type: 'string', default: '1,100,1000' },
      iterations: { type: 'string', default: '5' },
    },
  });
  const root = resolve(import.meta.dir, '..'),
    output = resolve(values.output || '');
  const outside = relative(root, output);
  if (!values.output || (!outside.startsWith('..' + '/') && outside !== '..'))
    throw Error('Use --output outside the checkout');
  const seed = Number(values.seed),
    iterations = Number(values.iterations),
    counts = values.meetings!.split(',').map(Number);
  if (
    !Number.isSafeInteger(iterations) ||
    iterations < 1 ||
    iterations > 20 ||
    !counts.length ||
    counts.length > 3 ||
    new Set(counts).size !== counts.length ||
    counts.some((count) => ![1, 100, 1000].includes(count))
  )
    throw Error('Use unique 1/100/1000 cohorts and 1–20 iterations');
  const commit = (await Bun.$`git rev-parse HEAD`.quiet()).text().trim();
  const report = {
    schemaVersion: 1,
    commit,
    scriptSha256: createHash('sha256')
      .update(readFileSync(import.meta.path))
      .digest('hex'),
    hardware: { hostname: hostname(), architecture: process.arch, macOS: release(), memoryBytes: totalmem() },
    runtime: { bun: Bun.version },
    iterations,
    cohorts: [] as Awaited<ReturnType<typeof benchmarkCohort>>[],
    ownedCleanupVerified: false,
  };
  for (const count of counts) {
    report.cohorts.push(await benchmarkCohort(count, seed, iterations));
    console.log(`Measured ${count} public meetings`);
  }
  report.ownedCleanupVerified = true;
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
}
