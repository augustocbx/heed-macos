import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type {
  CandidateInput,
  Session,
  TranscriptCandidate,
  TranscribeResult,
} from "@heed/shared";
import { SessionDetail } from "./SessionDetail";
import { useSessionsStore } from "@/stores/sessions";
import { useTemplatesStore } from "@/stores/templates";
import { useModelsStore } from "@/stores/models";
import { useRecordingStore } from "@/stores/recording";
import { setLocale } from "@/lib/i18n";
const session = (): Session => ({
  transcriptRevision: "a".repeat(64),
  transcriptVersion: 1,
  id: "s1",
  title: "Meeting",
  createdAt: "2026-10-05T12:00:00Z",
  duration: 20,
  language: "en",
  transcript: "Old text",
  speakers: ["Ana"],
  segments: [
    {
      speaker: "Ana",
      start: 0,
      end: 10,
      text: "Old text",
      channel: "sys",
      auto: false,
    },
  ],
  embeddings: { Ana: [1] },
  files: { wav: "/recordings/meeting.wav" },
  aiNotes: "Original notes",
  summary: "Summary",
  tags: [],
  pinned: false,
  liveModel: "base",
});
const diagnostics: NonNullable<Session["transcriptionDiagnostics"]> = {
  version: 1,
  aecApplied: false,
  channels: {
    mic: {
      rawRms: 0.03,
      rawPeak: 2000,
      cleanedRms: 0.03,
      asrSegments: 1,
      diarizationSegments: 0,
      usableEmbeddings: 0,
      retainedSegments: 1,
      discardedSegments: 0,
      discardReasons: {},
      fallbackSegments: 1,
      diarizationFailed: true,
    },
  },
  warnings: ["microphone-attribution-fallback"],
};
const result: TranscribeResult = {
  transcriptionDiagnostics: diagnostics,
  success: true,
  finalized: true,
  duration: 20,
  text: "Bom dia",
  files: { wav: "/tmp/new.wav", srt: "", txt: "" },
  metadata: { language: "pt", model: "small" },
  speakers: ["Speaker 4"],
  segments: [
    {
      speaker: "Speaker 4",
      start: 0,
      end: 10,
      text: "Bom dia",
      channel: "sys",
    },
  ],
  embeddings: { "Speaker 4": [2] },
  wordCount: 2,
};
const staged = (source: Session, input: CandidateInput): Session => ({
  ...source,
  transcriptEditing: {
    schemaVersion: 1,
    activeGenerationId: "g",
    generations: [],
    edits: [],
    candidateRequestReceipts: [],
    candidates: [
      {
        id: "candidate",
        createdAt: "2026-10-06",
        requestId: input.requestId,
        requestSignature: "sig",
        baseGuard: input.base,
        transcript: input.result.text,
        segments: input.result.segments,
        speakers: input.result.speakers,
        embeddings: input.result.embeddings,
        language: input.result.metadata.language,
        transcriptionModel: input.result.metadata.model,
        duration: input.result.duration!,
        transcriptionDiagnostics: input.result.transcriptionDiagnostics,
      },
    ],
  },
});
const open = (source = session()) => {
  render(<SessionDetail session={source} onBack={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Transcribe" }));
};
beforeEach(() => {
  setLocale("en");
  const s = session();
  useSessionsStore.setState({ sessions: [s], viewing: s });
  useTemplatesStore.setState({ load: vi.fn() });
  useModelsStore.setState({ load: vi.fn() });
  useRecordingStore.setState({ recording: false, processing: false });
});
afterEach(() => vi.unstubAllGlobals());
test("manual transcription sends chosen model/language and stages final draft while preserving accepted text, notes, audio and manual names", async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      return url.includes("/api/transcribe")
        ? new Response(`event: result\ndata: ${JSON.stringify(result)}\n\n`)
        : Response.json(staged(session(), JSON.parse(init.body as string)));
    }),
  );
  open();
  fireEvent.change(screen.getByLabelText("Transcription model"), {
    target: { value: "small" },
  });
  fireEvent.change(screen.getByLabelText("Meeting language"), {
    target: { value: "pt" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Start transcription" }));
  await screen.findByRole("button", { name: "Replace accepted transcript" });
  const form = requests[0].init.body as FormData;
  expect(form.get("url")).toBe(session().files?.wav);
  expect(form.get("final_model")).toBe("small");
  expect(form.get("language")).toBe("pt");
  expect(form.get("recording_finalize")).toBe("true");
  expect(requests[1].url).toBe("/api/sessions/s1/transcript/candidates");
  expect(requests.every((r) => r.init.method !== "PATCH")).toBe(true);
  const saved = useSessionsStore.getState().viewing!;
  expect(saved.transcript).toBe("Old text");
  expect(saved.aiNotes).toBe("Original notes");
  expect(saved.files).toEqual(session().files);
  expect(saved.transcriptVersion).toBe(1);
  expect(saved.transcriptEditing?.candidates[0]).toMatchObject({
    speakers: ["Ana"],
    embeddings: { Ana: [2] },
    transcriptionDiagnostics: diagnostics,
    duration: 20,
    language: "pt",
    transcriptionModel: "small",
  });
});
test("failed transcription keeps accepted session and displays failure", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          'event: error\ndata: {"message":"Model download failed"}\n\n',
        ),
    ),
  );
  open();
  fireEvent.click(screen.getByRole("button", { name: "Start transcription" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Model download failed",
  );
  expect(useSessionsStore.getState().viewing).toEqual(session());
  expect(useRecordingStore.getState().processing).toBe(false);
});
test("new recognition is unavailable during recording or without saved audio", () => {
  useRecordingStore.setState({ recording: true });
  const view = render(<SessionDetail session={session()} onBack={vi.fn()} />);
  expect(screen.getByRole("button", { name: "Transcribe" })).toBeDisabled();
  view.unmount();
  useRecordingStore.setState({ recording: false });
  render(
    <SessionDetail session={{ ...session(), files: {} }} onBack={vi.fn()} />,
  );
  expect(screen.getByRole("button", { name: "Transcribe" })).toBeDisabled();
});
test("candidate full duration is adopted only after explicit replacement", async () => {
  let pending: Session;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      if (url.includes("/api/transcribe"))
        return new Response(
          `event: result\ndata: ${JSON.stringify({ ...result, duration: 732.5 })}\n\n`,
        );
      if (url.endsWith("/candidates")) {
        pending = staged(session(), JSON.parse(init.body as string));
        return Response.json(pending);
      }
      return Response.json({
        ...pending,
        duration: 732.5,
        transcript: "Bom dia",
        language: "pt",
        transcriptVersion: 2,
        transcriptRevision: "b".repeat(64),
        transcriptEditing: { ...pending.transcriptEditing, candidates: [] },
      });
    }),
  );
  open();
  fireEvent.click(screen.getByRole("button", { name: "Start transcription" }));
  const replace = await screen.findByRole("button", {
    name: "Replace accepted transcript",
  });
  expect(useSessionsStore.getState().viewing?.duration).toBe(20);
  fireEvent.click(replace);
  await waitFor(() =>
    expect(useSessionsStore.getState().viewing?.duration).toBe(732.5),
  );
});
test("failed stage keeps completed draft visible and accepted session unchanged", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url.includes("/api/transcribe")
        ? new Response(`event: result\ndata: ${JSON.stringify(result)}\n\n`)
        : Response.json(
            { error: "Could not save transcript" },
            { status: 500 },
          ),
    ),
  );
  open();
  fireEvent.click(screen.getByRole("button", { name: "Start transcription" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Could not save transcript",
  );
  expect(screen.getByText("Bom dia")).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Retry saving draft" }),
  ).toBeEnabled();
  expect(useSessionsStore.getState().viewing).toEqual(session());
});
test("saved attribution warnings remain understandable without diagnostic internals", () => {
  render(
    <SessionDetail
      session={{
        ...session(),
        transcriptionDiagnostics: structuredClone(diagnostics),
      }}
      onBack={vi.fn()}
    />,
  );
  expect(
    screen.getByText(
      "Some microphone speech has uncertain speaker labels. Review the transcript and speaker names.",
    ),
  ).toBeInTheDocument();
  expect(screen.queryByText("diarizationFailed")).not.toBeInTheDocument();
});
test("a late result stages against opening source and cannot replace newer manual edits", async () => {
  const newer = {
    ...session(),
    transcript: "Newer manual text",
    transcriptRevision: "b".repeat(64),
    transcriptVersion: 2,
    speakers: ["Renamed speaker"],
  };
  let submitted: CandidateInput | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      if (url.includes("/api/transcribe")) {
        useSessionsStore.setState({ sessions: [newer], viewing: newer });
        return new Response(
          `event: result\ndata: ${JSON.stringify(result)}\n\n`,
        );
      }
      submitted = JSON.parse(init.body as string);
      return Response.json(staged(newer, submitted!));
    }),
  );
  open();
  fireEvent.click(screen.getByRole("button", { name: "Start transcription" }));
  expect(
    await screen.findByRole("button", { name: "Replace accepted transcript" }),
  ).toBeDisabled();
  expect(submitted!.base).toEqual({
    expectedTranscriptRevision: session().transcriptRevision,
    expectedTranscriptVersion: 1,
  });
  expect(submitted!.result.speakers).toEqual(["Ana"]);
  expect(useSessionsStore.getState().viewing?.transcript).toBe(
    "Newer manual text",
  );
});
test("generated fallback labels do not replace newly available speaker attribution in a draft", async () => {
  const uncertain = {
    ...session(),
    speakers: ["System (unattributed)"],
    segments: [
      {
        ...session().segments[0],
        speaker: "System (unattributed)",
        attribution: "fallback" as const,
        auto: false,
      },
    ],
  };
  useSessionsStore.setState({ sessions: [uncertain], viewing: uncertain });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) =>
      url.includes("/api/transcribe")
        ? new Response(`event: result\ndata: ${JSON.stringify(result)}\n\n`)
        : Response.json(staged(uncertain, JSON.parse(init.body as string))),
    ),
  );
  open(uncertain);
  fireEvent.click(screen.getByRole("button", { name: "Start transcription" }));
  await screen.findByRole("button", { name: "Replace accepted transcript" });
  expect(
    useSessionsStore.getState().viewing?.transcriptEditing?.candidates[0]
      .speakers,
  ).toEqual(["Speaker 4"]);
  expect(useSessionsStore.getState().viewing?.speakers).toEqual([
    "System (unattributed)",
  ]);
});
