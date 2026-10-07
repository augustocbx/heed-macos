import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Session, TranscriptCandidate } from "@heed/shared";
import { TranscriptCandidatePanel } from "./TranscriptCandidatePanel";
import { useSessionsStore } from "@/stores/sessions";
import { setLocale } from "@/lib/i18n";
export const candidate = (): TranscriptCandidate => ({
  id: "draft /#",
  createdAt: "2026-10-06",
  requestId: "stage",
  requestSignature: "sig",
  baseGuard: {
    expectedTranscriptRevision: "a".repeat(64),
    expectedTranscriptVersion: 1,
  },
  duration: 10,
  transcript: "New",
  segments: [{ speaker: "Ana", start: 0, end: 10, text: "New" }],
  speakers: ["Ana"],
  language: "pt",
  transcriptionModel: "actual-small",
});
export const source = (): Session => ({
  id: "s /#",
  title: "Meeting",
  createdAt: "2026-10-06",
  duration: 10,
  transcript: "Old",
  segments: [{ speaker: "Ana", start: 0, end: 10, text: "Old" }],
  speakers: ["Ana"],
  language: "en",
  aiNotes: "Old notes",
  summary: "",
  tags: [],
  pinned: false,
  transcriptRevision: "a".repeat(64),
  transcriptVersion: 1,
  files: { wav: "retained" },
  transcriptEditing: {
    schemaVersion: 1,
    activeGenerationId: "g",
    generations: [],
    edits: [],
    candidates: [candidate()],
    candidateRequestReceipts: [],
  },
});
beforeEach(() => {
  setLocale("en");
  const s = source();
  useSessionsStore.setState({ sessions: [s], viewing: s });
});
afterEach(() => vi.unstubAllGlobals());
test("compares literal accepted/draft text, actual model/language and positional counts before explicit replacement", async () => {
  let body: any;
  const s = source();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, init) => {
      body = JSON.parse(init.body);
      return Response.json({
        ...s,
        transcript: "New",
        language: "pt",
        transcriptVersion: 2,
        transcriptRevision: "b".repeat(64),
        transcriptEditing: { ...s.transcriptEditing, candidates: [] },
      });
    }),
  );
  render(
    <TranscriptCandidatePanel
      session={s}
      candidate={candidate()}
      onBusy={vi.fn()}
    />,
  );
  expect(screen.getByText("Old")).toBeVisible();
  expect(screen.getByText("New")).toBeVisible();
  expect(screen.getByText(/actual-small/)).toBeVisible();
  expect(
    screen.getByText("Segments with different text by position: 1"),
  ).toBeVisible();
  expect(fetch).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("button", { name: "Replace accepted transcript" }),
  );
  await waitFor(() =>
    expect(useSessionsStore.getState().viewing?.transcriptVersion).toBe(2),
  );
  expect(body).toMatchObject({
    action: "accept-candidate",
    candidateId: "draft /#",
    expectedTranscriptVersion: 1,
  });
  expect(useSessionsStore.getState().viewing?.files).toEqual(s.files);
});
test.each([{ transcriptVersion: 2 }, { transcriptRevision: "b".repeat(64) }])(
  "stale draft can be discarded but cannot replace accepted source",
  (change) => {
    const s = { ...source(), ...change };
    render(
      <TranscriptCandidatePanel
        session={s}
        candidate={candidate()}
        onBusy={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Replace accepted transcript" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Discard draft" })).toBeEnabled();
    expect(screen.getByText(/This draft is stale/)).toBeVisible();
  },
);
test.each(["Replace accepted transcript", "Discard draft"])(
  "failed %s preserves candidate and retries exact operation identity",
  async (action) => {
    const bodies: any[] = [];
    let url = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u, init) => {
        url = String(u);
        bodies.push(JSON.parse(init.body));
        return Response.json({ error: "Capacity reached" }, { status: 409 });
      }),
    );
    render(
      <TranscriptCandidatePanel
        session={source()}
        candidate={candidate()}
        onBusy={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: action }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Capacity reached",
    );
    expect(
      useSessionsStore.getState().viewing?.transcriptEditing?.candidates,
    ).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: action }));
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[1]).toEqual(bodies[0]);
    if (action === "Discard draft")
      expect(url).toContain("draft%20%2F%23/discard");
  },
);

test("discard accepts its response exactly once and preserves the accepted source version", async () => {
  const s = source();
  const clean = {
    ...s,
    transcriptEditing: { ...s.transcriptEditing!, candidates: [] },
  };
  const accepted = vi.spyOn(useSessionsStore.getState(), "accept");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json(clean)),
  );
  render(
    <TranscriptCandidatePanel
      session={s}
      candidate={candidate()}
      onBusy={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
  await waitFor(() =>
    expect(
      useSessionsStore.getState().viewing?.transcriptEditing?.candidates,
    ).toHaveLength(0),
  );
  expect(useSessionsStore.getState().viewing?.transcriptVersion).toBe(1);
  expect(accepted).toHaveBeenCalledOnce();
  accepted.mockRestore();
});
