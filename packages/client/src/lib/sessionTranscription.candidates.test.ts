import { afterEach, expect, test, vi } from "vitest";
import type { CandidateInput, Session, TranscribeResult } from "@heed/shared";
import { createRetranscriptionCandidate } from "./sessionTranscription";
const meeting = (): Session => ({
  id: "s",
  title: "Meeting",
  createdAt: "2026-10-06",
  duration: 10,
  language: "en",
  transcript: "Old",
  speakers: ["Ana"],
  segments: [
    {
      speaker: "Ana",
      start: 0,
      end: 10,
      text: "Old",
      channel: "sys",
      auto: false,
    },
  ],
  files: { wav: "/recordings/old.wav" },
  embeddings: { Ana: [1] },
  aiNotes: "Notes",
  summary: "",
  tags: [],
  pinned: false,
  transcriptRevision: "a".repeat(64),
  transcriptVersion: 1,
});
const final = (): TranscribeResult => ({
  success: true,
  finalized: true,
  duration: 12,
  text: "Novo",
  files: { wav: "/tmp/new.wav", txt: "", srt: "" },
  metadata: { language: "pt", model: "actual-small" },
  speakers: ["Speaker 2"],
  segments: [
    {
      speaker: "Speaker 2",
      start: 0,
      end: 12,
      text: "Novo",
      channel: "sys",
      id: 4,
      overlap: true,
    },
  ],
  embeddings: { "Speaker 2": [2] },
  wordCount: 1,
});
const stream = (result: unknown, trailing = "") =>
  new Response(`event: result\ndata: ${JSON.stringify(result)}\n\n${trailing}`);
afterEach(() => vi.unstubAllGlobals());
test("stages a complete final result with actual provenance and manual names without replacing audio or source", async () => {
  const source = meeting(),
    before = structuredClone(source);
  let input: CandidateInput | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => stream(final())),
  );
  const stage = vi.fn(async (_id: string, value: CandidateInput) => {
    input = value;
    return source;
  });
  expect(
    await createRetranscriptionCandidate(source, "base", "auto", {}, stage),
  ).toBe(source);
  expect(input).toMatchObject({
    base: {
      expectedTranscriptRevision: before.transcriptRevision,
      expectedTranscriptVersion: 1,
    },
    result: {
      metadata: { language: "pt", model: "actual-small" },
      speakers: ["Ana"],
      embeddings: { Ana: [2] },
      duration: 12,
      files: { wav: "", srt: "", txt: "" },
    },
  });
  expect(input!.result.segments[0]).toMatchObject({ id: 4, overlap: true });
  expect(input!.requestId).toBeTruthy();
  expect(source).toEqual(before);
});
test("captures guard and naming identities before the awaited recognition request", async () => {
  const source = meeting();
  let input: CandidateInput | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      source.transcriptRevision = "b".repeat(64);
      source.transcriptVersion = 2;
      source.speakers = ["Changed"];
      source.segments[0].speaker = "Changed";
      return stream(final());
    }),
  );
  await createRetranscriptionCandidate(
    source,
    "base",
    "pt",
    {},
    async (_id, value) => {
      input = value;
      return source;
    },
  );
  expect(input!.base.expectedTranscriptVersion).toBe(1);
  expect(input!.result.speakers).toEqual(["Ana"]);
});
test.each([
  { ...final(), finalized: false },
  { ...final(), duration: undefined },
  { ...final(), metadata: { language: "fr", model: "small" } },
  { ...final(), text: "Mismatch" },
  {
    ...final(),
    segments: [{ speaker: "Speaker 2", start: NaN, end: 1, text: "Novo" }],
  },
  { ...final(), files: undefined },
  { ...final(), speakers: ["Speaker 2", "Speaker 2"] },
  { ...final(), embeddings: { "Speaker 2": [NaN] } },
])(
  "rejects incomplete or inconsistent final results before staging",
  async (result) => {
    const stage = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => stream(result)),
    );
    await expect(
      createRetranscriptionCandidate(meeting(), "base", "auto", {}, stage),
    ).rejects.toThrow();
    expect(stage).not.toHaveBeenCalled();
  },
);
test("late stream failure prevents staging even after a result event", async () => {
  const stage = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      stream(
        final(),
        'event: error\ndata: {"message":"Finalization failed"}\n\n',
      ),
    ),
  );
  await expect(
    createRetranscriptionCandidate(meeting(), "base", "auto", {}, stage),
  ).rejects.toThrow("Finalization failed");
  expect(stage).not.toHaveBeenCalled();
});
test("fallback labels are not reconciled into recognized identities and reserved names remain ordinary strings", async () => {
  const source = meeting();
  source.speakers = ["System (unattributed)"];
  source.segments[0] = {
    ...source.segments[0],
    speaker: source.speakers[0],
    attribution: "fallback",
  };
  const result = {
    ...final(),
    speakers: ["toString"],
    segments: [{ ...final().segments[0], speaker: "toString" }],
    embeddings: { toString: [2] },
  };
  let input: CandidateInput | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => stream(result)),
  );
  await createRetranscriptionCandidate(
    source,
    "base",
    "auto",
    {},
    async (_id, value) => {
      input = value;
      return source;
    },
  );
  expect(input!.result.speakers).toEqual(["toString"]);
  expect(input!.result.segments[0].speaker).toBe("toString");
});
