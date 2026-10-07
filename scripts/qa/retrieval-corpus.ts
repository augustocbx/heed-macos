/** Authored public EN/PT ground truth; no recognition or generation model output. */
import type { Session } from '../../packages/shared/types/session';
import type { RetrievalScope } from '../../packages/server/lib/retrieval-catalog';
import type { TranscriptEvidence } from '../../packages/shared/types/chat';
import { sourceRevision } from '../../packages/shared/lib/transcript-source';
import { transcriptEvidence } from '../../packages/server/lib/meeting-chat';

export interface RetrievalQuestion {
  id: string;
  language: 'en' | 'pt';
  question: string;
  scope: RetrievalScope;
  relevantEvidenceIds: string[];
  kind: 'literal' | 'paraphrase' | 'contradiction' | 'dated' | 'negative' | 'excluded-only';
}
export interface RetrievalCorpus {
  seed: number;
  meetings: Session[];
  questions: RetrievalQuestion[];
}

export function createRetrievalCorpus(count: number, seed = 69): RetrievalCorpus {
  if (![1, 100, 1000].includes(count) || !Number.isSafeInteger(seed) || seed < 0)
    throw Error('Use the public 1/100/1000 meeting cohorts and a nonnegative seed');
  const meetings: Session[] = Array.from({ length: count }, (_, index) => {
    const id = `qa-${seed}-${String(index).padStart(4, '0')}`;
    const text = Array.from({ length: index === 0 ? 161 : 4 }, (_, ordinal) =>
      index === 0
        ? `Routine ${seed}-${ordinal}. ` +
          'The synthetic team reviewed ordinary housekeeping without a recorded project decision. '.repeat(13)
        : `Routine ${seed}-${index}-${ordinal}. Ordinary synthetic housekeeping notes.`,
    );
    const segments = text.map((text, ordinal) => ({
      speaker: index % 2 ? 'João Pereira' : 'Beatriz Vieira',
      start: ordinal * 3,
      end: ordinal * 3 + 3,
      channel: 'sys' as const,
      text,
    }));
    return {
      id,
      title: `Synthetic meeting ${index}`,
      createdAt: '2026-10-06T12:00:00.000Z',
      summary: '',
      duration: segments.length * 3,
      language: index % 2 ? 'pt' : 'en',
      transcript: '',
      segments,
      speakers: [segments[0]!.speaker],
      tags:
        index === count - 1 && count > 1 ? ['Excluded'] : index % 2 ? ['Delivery', 'Reviewed'] : ['Delivery'],
      aiNotes: '',
      pinned: false,
      transcriptFinalized: true,
      transcriptVersion: 1,
    };
  });
  const first = meetings[0]!;
  const middle = meetings[Math.min(count - 1, Math.floor(count / 2))]!;
  const last = meetings[count - 1]!;
  first.segments[1]!.text =
    'Project Zephyr release is confirmed for 2026-10-20. Beatriz Vieira owns the Kubernetes rollout.';
  first.segments[3]!.text =
    'O projeto Aurora aprovou a entrega para 2026-10-22. João Pereira é responsável pela implantação PostgreSQL.';
  first.segments[5]!.text =
    'The Zephyr proposal originally suggested Friday, but the team rejected Friday and confirmed Tuesday.';
  first.segments[7]!.text =
    'Em 2026-10-01, o orçamento Aurora de mil reais era apenas uma proposta, sem aprovação.';
  first.segments[9]!.text =
    'Em 2026-10-06, o orçamento Aurora aprovado foi de dois mil reais; a proposta anterior foi rejeitada.';
  first.segments[11]!.text =
    'The cobalt migration was postponed because the database needed another validation step.';
  if (count > 1) {
    middle.segments[1]!.text =
      'Zephyr deployment remains tentative until security approval. Beatriz Vieira reported an unresolved release blocker.';
    middle.tags = ['Delivery', 'Reviewed'];
    last.segments[1]!.text =
      'SecretCanary budget is 777 euros. This synthetic evidence belongs exclusively to an excluded meeting.';
    last.segments[3]!.text =
      'A senha fictícia SecretCanary consta somente na reunião excluída; não há resposta nas reuniões Delivery.';
  }
  for (const segment of first.segments) {
    // Keep every first-meeting source in its own legacy2200-character input chunk.
    // Short answers must not hitchhike in a sampled adjacent filler chunk.
    if (segment.text.length < 1100)
      segment.text += ' Additional routine synthetic housekeeping.'.repeat(
        Math.ceil((1100 - segment.text.length) / 42),
      );
  }
  for (const meeting of meetings) {
    meeting.transcript = meeting.segments.map((segment) => segment.text).join('\n');
    meeting.transcriptRevision = sourceRevision(meeting);
  }
  const evidence = (meeting: Session, ...indices: number[]) =>
    transcriptEvidence(meeting)
      .filter((item) => indices.includes(item.segmentIndex!))
      .map((item) => item.id);
  const all: RetrievalScope = { kind: 'library', scope: { mode: 'all', labels: [], match: 'any' } };
  const delivery: RetrievalScope = {
    kind: 'library',
    scope: { mode: 'labels', labels: ['Delivery'], match: 'any' },
  };
  const reviewed: RetrievalScope = {
    kind: 'library',
    scope: { mode: 'labels', labels: ['Delivery', 'Reviewed'], match: 'all' },
  };
  const questions: RetrievalQuestion[] = [
    {
      id: 'between-samples-en',
      language: 'en',
      question: 'Zephyr release Kubernetes Beatriz Vieira',
      scope: all,
      relevantEvidenceIds: evidence(first, 1),
      kind: 'literal',
    },
    {
      id: 'between-samples-pt',
      language: 'pt',
      question: 'Aurora entrega João Pereira PostgreSQL',
      scope: all,
      relevantEvidenceIds: evidence(first, 3),
      kind: 'literal',
    },
    {
      id: 'paraphrase-en',
      language: 'en',
      question: 'Why did we delay the cobalt move?',
      scope: all,
      relevantEvidenceIds: evidence(first, 11),
      kind: 'paraphrase',
    },
    {
      id: 'paraphrase-pt',
      language: 'pt',
      question: 'Qual é o valor autorizado para o projeto Aurora?',
      scope: delivery,
      relevantEvidenceIds: evidence(first, 7, 9),
      kind: 'paraphrase',
    },
    {
      id: 'contradiction-en',
      language: 'en',
      question: 'Zephyr release approval blocker confirmed tentative',
      scope: delivery,
      relevantEvidenceIds: [...evidence(first, 1, 5), ...(count > 1 ? evidence(middle, 1) : [])],
      kind: 'contradiction',
    },
    {
      id: 'dated-pt',
      language: 'pt',
      question: 'Aurora orçamento proposta aprovado 2026-10-01 2026-10-06',
      scope: delivery,
      relevantEvidenceIds: evidence(first, 7, 9),
      kind: 'dated',
    },
    {
      id: 'any-labels-en',
      language: 'en',
      question: 'Zephyr release Beatriz Vieira',
      scope: { kind: 'library', scope: { mode: 'labels', labels: ['Delivery', 'Reviewed'], match: 'any' } },
      relevantEvidenceIds: [...evidence(first, 1), ...(count > 1 ? evidence(middle, 1) : [])],
      kind: 'literal',
    },
    {
      id: 'all-labels-en',
      language: 'en',
      question: 'Zephyr security approval unresolved blocker',
      scope: reviewed,
      relevantEvidenceIds: count > 1 ? evidence(middle, 1) : [],
      kind: count > 1 ? 'literal' : 'negative',
    },
    {
      id: 'single-meeting-pt',
      language: 'pt',
      question: 'Aurora entrega PostgreSQL',
      scope: { kind: 'meeting', sessionId: first.id },
      relevantEvidenceIds: evidence(first, 3),
      kind: 'literal',
    },
    {
      id: 'no-answer-en',
      language: 'en',
      question: 'UnmentionedQuasar lunar radiation invoice',
      scope: delivery,
      relevantEvidenceIds: [],
      kind: 'negative',
    },
    {
      id: 'no-answer-pt',
      language: 'pt',
      question: 'InexistenteNebulosa safira asteroide',
      scope: delivery,
      relevantEvidenceIds: [],
      kind: 'negative',
    },
    {
      id: 'excluded-only-en',
      language: 'en',
      question: 'SecretCanary budget euros',
      scope: delivery,
      relevantEvidenceIds: [],
      kind: 'excluded-only',
    },
    {
      id: 'excluded-only-pt',
      language: 'pt',
      question: 'SecretCanary senha fictícia',
      scope: delivery,
      relevantEvidenceIds: [],
      kind: 'excluded-only',
    },
  ];
  return { seed, meetings, questions };
}

/** Frozen pre-retrieval chunk sampling from the prior answerMeetingQuestion path. */
export function legacySuppliedEvidence(
  sessions: Session[],
  chunkCharacters = 2200,
  maxChunks = 80,
): TranscriptEvidence[] {
  const chunks: TranscriptEvidence[][] = [];
  let chunk: TranscriptEvidence[] = [],
    size = 0;
  for (const item of sessions.flatMap(transcriptEvidence)) {
    const cost = item.quote.length + item.id.length + item.speaker.length + 150;
    if (chunk.length && size + cost > Math.max(1600, chunkCharacters)) {
      chunks.push(chunk);
      chunk = [];
      size = 0;
    }
    chunk.push(item);
    size += cost;
  }
  if (chunk.length) chunks.push(chunk);
  const limit = Math.max(1, Math.floor(maxChunks));
  return (
    chunks.length <= limit
      ? chunks
      : Array.from(
          { length: limit },
          (_, index) => chunks[Math.floor((index * (chunks.length - 1)) / Math.max(1, limit - 1))]!,
        )
  ).flat();
}

export function scoreRetrieval(ids: string[], relevantIds: string[], k: number) {
  const retrieved = [...new Set(ids)].slice(0, k),
    relevant = new Set(relevantIds);
  const correct = retrieved.filter((id) => relevant.has(id)).length;
  return {
    recall: relevant.size ? correct / relevant.size : null,
    precision: retrieved.length ? correct / retrieved.length : null,
    relevant: relevant.size,
    correct,
    returned: retrieved.length,
    falseSupport: !relevant.size && retrieved.length > 0,
  };
}
