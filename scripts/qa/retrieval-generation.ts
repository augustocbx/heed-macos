#!/usr/bin/env bun
/** Explicit local-model QA on authored public data, separate from retrieval recall. */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { SessionTags } from '../../packages/server/lib/session-tags';
import { RetrievalCatalog } from '../../packages/server/lib/retrieval-catalog';
import { RetrievalIndex } from '../../packages/server/lib/retrieval-index';
import { MeetingRetriever } from '../../packages/server/lib/meeting-retrieval';
import { createRetrievalPolicy } from '../../packages/server/lib/retrieval-policy';
import { ManagedQuota } from '../../packages/server/lib/managed-quota';
import {
  answerMeetingQuestion,
  CHAT_SYSTEM,
  chatResponseSchema,
} from '../../packages/server/lib/meeting-chat';
import { generateLocalStructured } from '../../packages/server/lib/ollama-notes';
import { createRetrievalCorpus } from './retrieval-corpus';
const { values } = parseArgs({ options: { output: { type: 'string' }, model: { type: 'string' } } });
const checkout = resolve(import.meta.dir, '../..'),
  output = resolve(values.output || '');
if (!values.output || !relative(checkout, output).startsWith('../') || !values.model)
  throw Error('Use --model installed-local-name --output outside-checkout.json');
const baseUrl = 'http://127.0.0.1:11434';
const occupied = await (await fetch(baseUrl + '/api/ps', { signal: AbortSignal.timeout(3000) })).json();
if (occupied.models?.length)
  throw Error('Local provider is occupied; do not compete with another admitted model');
const models = await (await fetch(baseUrl + '/api/tags', { signal: AbortSignal.timeout(3000) })).json();
const model = models.models?.find((item: any) => item.name === values.model);
if (!model || !/^[a-f0-9]{64}$/.test(model.digest))
  throw Error('Explicit installed model identity unavailable');
const corpus = createRetrievalCorpus(1000, 69),
  root = mkdtempSync(join(tmpdir(), 'heed-retrieval-generation-'));
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
const report = {
  schemaVersion: 1,
  commit: (await Bun.$`git rev-parse HEAD`.quiet()).text().trim(),
  scriptSha256: createHash('sha256')
    .update(readFileSync(import.meta.path))
    .digest('hex'),
  model: { name: model.name, digest: model.digest, bytes: model.size, details: model.details },
  corpusSha256: createHash('sha256').update(JSON.stringify(corpus)).digest('hex'),
  policy,
  qualityKind:
    'actual installed local-model output; manually assess claim semantics separately from retrieval and citation validity',
  provider: 'loopback Ollama; existing installation; keep_alive=0; no model download',
  questions: [] as unknown[],
  ownedCleanupVerified: false,
};
try {
  for (const meeting of corpus.meetings) store.commitSource(meeting.id, null, () => meeting);
  await catalog.reconcile();
  await index.tick();
  for (const question of corpus.questions) {
    const snapshot = catalog.resolve(question.scope).snapshot,
      result = await retriever.retrieve(snapshot, question.question);
    const evidence = await retriever.materialize(result),
      calls: Array<{ suppliedIds: string[]; inputBytes: number; elapsedMilliseconds?: number }> = [],
      started = now();
    try {
      const answer = await answerMeetingQuestion({
        evidence,
        coverage: result.coverage,
        question: question.question,
        history: [],
        model: model.name,
        policy,
        generate: async (input) => {
          const bytes = Buffer.byteLength(CHAT_SYSTEM + JSON.stringify(input.data));
          if (
            bytes > policy.generationInputBytes ||
            calls.length >= policy.generationCalls ||
            input.evidence.some(
              (item) => !snapshot.sources.some((source) => source.sessionId === item.sessionId),
            )
          )
            throw Error('QA production generation budget or scope violation');
          const callStarted = now();
          calls.push({ suppliedIds: input.evidence.map((item) => item.id), inputBytes: bytes });
          const text = await generateLocalStructured({
            baseUrl,
            model: input.model,
            system: CHAT_SYSTEM,
            data: input.data,
            outputSchema: chatResponseSchema(input.evidence),
            maxInputBytes: policy.generationInputBytes,
            contextTokens: policy.generationContextTokens,
            requireCompletion: true,
            timeoutMs: 180_000,
            numThread: 2,
            signal: input.signal,
          });
          Object.assign(calls.at(-1)!, { elapsedMilliseconds: now() - callStarted });
          return text;
        },
      });
      report.questions.push({
        id: question.id,
        language: question.language,
        kind: question.kind,
        question: question.question,
        relevantEvidenceIds: question.relevantEvidenceIds,
        retrievedIds: evidence.map((item) => item.id),
        calls,
        answer,
        elapsedMilliseconds: now() - started,
      });
      console.log(
        `Measured generated answer ${question.id}: ${answer.claims.length} claims, ${calls.length} calls`,
      );
    } catch (error) {
      report.questions.push({
        id: question.id,
        question: question.question,
        language: question.language,
        kind: question.kind,
        calls,
        error: String(error),
        elapsedMilliseconds: now() - started,
      });
      console.log(`Recorded generation failure ${question.id}: ${String(error)}`);
    }
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  }
} finally {
  retriever.close();
  index.close();
  catalog.close();
  rmSync(root, { recursive: true });
  report.ownedCleanupVerified = true;
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
}
