import { expect, test } from 'bun:test';
import {
  createRetrievalCorpus,
  legacySuppliedEvidence,
  scoreRetrieval,
} from '../../../scripts/qa/retrieval-corpus';
import { transcriptEvidence } from './meeting-chat';
import { benchmarkCohort } from '../../../scripts/benchmark-retrieval';

test('public corpus is deterministic and expected IDs refer to exact current EN/PT evidence', () => {
  const a = createRetrievalCorpus(100, 69),
    b = createRetrievalCorpus(100, 69);
  expect(a).toEqual(b);
  expect(a.meetings).toHaveLength(100);
  const ids = new Set(a.meetings.flatMap(transcriptEvidence).map((evidence) => evidence.id));
  for (const question of a.questions)
    for (const id of question.relevantEvidenceIds) expect(ids.has(id)).toBe(true);
  expect(a.questions.filter((question) => question.language === 'pt').length).toBeGreaterThan(3);
  expect(
    a.questions
      .filter((question) => question.kind === 'excluded-only')
      .every((question) => question.relevantEvidenceIds.length === 0),
  ).toBe(true);
});
test('authored answer lies between frozen eighty-sample positions without fabricating a retrieval success', () => {
  const corpus = createRetrievalCorpus(1);
  const question = corpus.questions.find((question) => question.id === 'between-samples-en')!;
  expect(question.relevantEvidenceIds).toHaveLength(1);
  expect(
    legacySuppliedEvidence(corpus.meetings).some((evidence) =>
      question.relevantEvidenceIds.includes(evidence.id),
    ),
  ).toBe(false);
});
test('recall precision deduplicate returned IDs and do not pretend a negative query has positive recall', () => {
  expect(scoreRetrieval(['a', 'a', 'b', 'unrelated'], ['a', 'b'], 2)).toEqual({
    recall: 1,
    precision: 1,
    relevant: 2,
    correct: 2,
    returned: 2,
    falseSupport: false,
  });
  expect(scoreRetrieval(['a'], [], 8)).toEqual({
    recall: null,
    precision: 0,
    relevant: 0,
    correct: 0,
    returned: 1,
    falseSupport: true,
  });
  expect(scoreRetrieval([], [], 8)).toEqual({
    recall: null,
    precision: null,
    relevant: 0,
    correct: 0,
    returned: 0,
    falseSupport: false,
  });
});
test('contradictory and dated expectations retain both sides rather than declaring only the latest true', () => {
  const corpus = createRetrievalCorpus(1000);
  expect(
    corpus.questions.find((question) => question.kind === 'contradiction')!.relevantEvidenceIds,
  ).toHaveLength(3);
  expect(corpus.questions.find((question) => question.kind === 'dated')!.relevantEvidenceIds).toHaveLength(2);
  expect(() => createRetrievalCorpus(1001)).toThrow();
});
test('actual SQLite benchmark recovers between-sample evidence and excludes negative sources without a generator', async () => {
  const result = await benchmarkCohort(1, 69, 2);
  const en = result.questions.find((question) => question.id === 'between-samples-en')!;
  const pt = result.questions.find((question) => question.id === 'between-samples-pt')!;
  expect(en.lexical[8].recall).toBe(1);
  expect(pt.lexical[8].recall).toBe(1);
  expect(en.legacySupplied.recall).toBe(0);
  expect(pt.legacySupplied.recall).toBe(0);
  expect(
    result.questions
      .filter((question) => question.kind === 'negative' || question.kind === 'excluded-only')
      .every((question) => question.lexicalIds.length === 0),
  ).toBe(true);
  expect(result.reservedQuotaBytes).toBe(0);
  expect(result.databaseBytes).toBeGreaterThan(4096);
  expect(result.workingDiskBytes).toBeLessThanOrEqual(result.policy.workingDiskBytes);
});
