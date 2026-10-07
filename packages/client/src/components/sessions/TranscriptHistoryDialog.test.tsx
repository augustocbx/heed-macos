import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { TranscriptHistoryDialog } from "./TranscriptHistoryDialog";
import { correctionMeeting } from "./transcript.test-support";
import { transcriptEditingApi } from "@/api/transcript-editing";
import { useSessionsStore } from "@/stores/sessions";
vi.mock("@/api/transcript-editing", () => ({
  transcriptEditingApi: { command: vi.fn() },
}));
const original = correctionMeeting();
const meeting = () => ({
  ...original,
  transcriptEditing: {
    schemaVersion: 1 as const,
    activeGenerationId: "g",
    generations: [
      {
        id: "g",
        origin: "legacy-preserved" as const,
        createdAt: original.createdAt,
        transcript: "Original Joao",
        segments: original.segments,
        speakers: original.speakers,
        language: "pt",
        duration: 4,
      },
    ],
    edits: [
      {
        id: "edit",
        generationId: "g",
        kind: "edit" as const,
        createdAt: original.createdAt,
        beforeRevision: "old",
        afterRevision: "new",
        changes: [
          {
            target: { kind: "segment" as const, index: 0 },
            before: "Joao",
            after: "Joao API",
          },
        ],
      },
    ],
    candidates: [],
    candidateRequestReceipts: [],
  },
});
beforeEach(() => {
  vi.resetAllMocks();
  useSessionsStore.setState({ sessions: [], viewing: null });
});
test.each(["before-click", "failed-retry"] as const)("history inverse stays on its opening meeting after navigation: %s", async mode => {
  const a = { ...meeting(), id: "meeting-a", title: "Meeting A" };
  const b = { ...meeting(), id: "meeting-b", title: "Meeting B" };
  useSessionsStore.setState({ sessions: [a, b], viewing: a });
  vi.mocked(transcriptEditingApi.command).mockRejectedValue(Object.assign(new Error("Disk unavailable"), { status: 409 }));
  const callbacks = { onClose: vi.fn(), onSaved: vi.fn() };
  const view = render(<TranscriptHistoryDialog session={a} {...callbacks} />);
  if (mode === "failed-retry") {
    fireEvent.click(screen.getByRole("button", { name: "Revert this edit" }));
    await screen.findByRole("alert");
  }
  view.rerender(<TranscriptHistoryDialog session={b} {...callbacks} />);
  expect(screen.getByText("Meeting A")).toBeVisible();
  expect(screen.queryByText("Meeting B")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Revert this edit" }));
  await waitFor(() => expect(transcriptEditingApi.command).toHaveBeenCalledTimes(mode === "failed-retry" ? 2 : 1));
  const calls = vi.mocked(transcriptEditingApi.command).mock.calls;
  expect(calls.at(-1)![0]).toBe(a.id);
  expect(calls.at(-1)![1]).toMatchObject({ expectedTranscriptRevision: a.transcriptRevision, expectedTranscriptVersion: a.transcriptVersion, editId: "edit", action: "revert" });
  if (mode === "failed-retry") expect(calls[1]).toEqual(calls[0]);
});
test("legacy source is labeled honestly; compatible inverse is guarded and failed save keeps recovery text", async () => {
  vi.mocked(transcriptEditingApi.command).mockRejectedValue(
    Object.assign(new Error("Changed"), { status: 409 }),
  );
  render(
    <TranscriptHistoryDialog
      session={meeting()}
      onClose={vi.fn()}
      onSaved={vi.fn()}
    />,
  );
  expect(
    screen.getByText("Source preserved when editing was enabled"),
  ).toBeVisible();
  expect(screen.getByText("Original Joao")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Revert this edit" }));
  await screen.findByRole("alert");
  expect(screen.getByText("Original Joao")).toBeVisible();
  expect(transcriptEditingApi.command).toHaveBeenCalledWith(
    original.id,
    expect.objectContaining({
      action: "revert",
      editId: "edit",
      expectedTranscriptVersion: 1,
    }),
  );
});
test("later overlapping action blocks inverse even when text has returned to the same value", async () => {
  const s = meeting();
  s.transcriptEditing.edits.push({
    ...s.transcriptEditing.edits[0]!,
    id: "later",
    changes: [
      {
        target: { kind: "segment", index: 0 },
        before: "Temporary",
        after: "Joao API",
      },
    ],
  });
  render(
    <TranscriptHistoryDialog session={s} onClose={vi.fn()} onSaved={vi.fn()} />,
  );
  expect(
    screen.getByRole("button", { name: "Revert this edit" }),
  ).toBeDisabled();
  expect(
    screen.getByText(
      "Recovery text only: later edits or a new recognition generation prevent safe revert.",
    ),
  ).toBeVisible();
  expect(transcriptEditingApi.command).not.toHaveBeenCalled();
});
test("older recognized text remains readable after a new generation and cannot restore old identity", () => {
  const s = meeting();
  s.transcriptEditing.generations.push({
    ...s.transcriptEditing.generations[0]!,
    id: "next",
    transcript: "New recognition",
  });
  s.transcriptEditing.activeGenerationId = "next";
  render(
    <TranscriptHistoryDialog session={s} onClose={vi.fn()} onSaved={vi.fn()} />,
  );
  expect(screen.getByText("Original Joao")).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Revert this edit" }),
  ).toBeDisabled();
  fireEvent.change(
    screen.getByRole("combobox", { name: "Recognition generation" }),
    { target: { value: "next" } },
  );
  expect(screen.getByText("New recognition")).toBeVisible();
  expect(transcriptEditingApi.command).not.toHaveBeenCalled();
});
