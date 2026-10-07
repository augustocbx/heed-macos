import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { TranscriptReplaceDialog } from "./TranscriptReplaceDialog";
import { correctionMeeting } from "./transcript.test-support";
import { transcriptEditingApi } from "@/api/transcript-editing";
vi.mock("@/api/transcript-editing", () => ({
  transcriptEditingApi: { preview: vi.fn(), command: vi.fn() },
}));
const session = correctionMeeting(),
  preview = {
    key: "preview",
    guard: {
      expectedTranscriptRevision: session.transcriptRevision!,
      expectedTranscriptVersion: 1,
    },
    matchCount: 2,
    changes: [
      {
        target: { kind: "segment" as const, index: 0 },
        before: "Joao API",
        after: "Joao Interface",
      },
    ],
  };
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(transcriptEditingApi.preview).mockResolvedValue(preview);
  vi.mocked(transcriptEditingApi.command).mockResolvedValue(session);
});
test("literal preview, options, explicit approval and current guard precede one replacement", async () => {
  const saved = vi.fn();
  render(
    <TranscriptReplaceDialog
      session={session}
      onClose={vi.fn()}
      onSaved={saved}
    />,
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Find text" }), {
    target: { value: "API" },
  });
  fireEvent.change(screen.getByRole("textbox", { name: "Replace with" }), {
    target: { value: "Interface" },
  });
  fireEvent.click(screen.getByRole("checkbox", { name: "Whole words" }));
  fireEvent.click(screen.getByRole("button", { name: "Preview replacement" }));
  await screen.findByText("Joao Interface");
  expect(transcriptEditingApi.command).not.toHaveBeenCalled();
  expect(
    screen.getByRole("button", { name: "Apply replacement" }),
  ).toBeDisabled();
  fireEvent.click(
    screen.getByRole("checkbox", { name: "I reviewed this replacement" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Apply replacement" }));
  await waitFor(() => expect(saved).toHaveBeenCalledWith(session));
  expect(transcriptEditingApi.command).toHaveBeenCalledWith(
    session.id,
    expect.objectContaining({
      action: "replace",
      expectedPreviewKey: "preview",
      expectedTranscriptVersion: 1,
      input: {
        query: "API",
        replacement: "Interface",
        wholeWord: true,
        caseSensitive: true,
      },
    }),
  );
});
test("option changes and newer source invalidate held previews without losing literal input", async () => {
  let finish!: (value: typeof preview) => void;
  vi.mocked(transcriptEditingApi.preview).mockReturnValue(
    new Promise((resolve) => (finish = resolve)),
  );
  const view = render(
    <TranscriptReplaceDialog
      session={session}
      onClose={vi.fn()}
      onSaved={vi.fn()}
    />,
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Find text" }), {
    target: { value: ".*\na\u0301" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Preview replacement" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Match case" }));
  await act(async () => finish(preview));
  expect(screen.queryByText("Joao Interface")).not.toBeInTheDocument();
  view.rerender(
    <TranscriptReplaceDialog
      session={{ ...session, transcriptVersion: 2 }}
      onClose={vi.fn()}
      onSaved={vi.fn()}
    />,
  );
  expect(screen.getByRole("textbox", { name: "Find text" })).toHaveValue(
    ".*\na\u0301",
  );
  expect(transcriptEditingApi.command).not.toHaveBeenCalled();
});
test("no-match preview and cancel never mutate accepted text", async () => {
  vi.mocked(transcriptEditingApi.preview).mockResolvedValue({
    ...preview,
    matchCount: 0,
    changes: [],
  });
  const close = vi.fn();
  render(
    <TranscriptReplaceDialog
      session={session}
      onClose={close}
      onSaved={vi.fn()}
    />,
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Find text" }), {
    target: { value: "Missing" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Preview replacement" }));
  await screen.findByText("No text changes.");
  expect(
    screen.queryByRole("button", { name: "Apply replacement" }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(close).toHaveBeenCalled();
  expect(transcriptEditingApi.command).not.toHaveBeenCalled();
});
test("failed acceptance retains preview and idempotent retry identity; successful callback never reaccepts state", async () => {
  vi.mocked(transcriptEditingApi.command)
    .mockRejectedValueOnce(new Error("Quota"))
    .mockResolvedValue(session);
  const saved = vi.fn();
  render(
    <TranscriptReplaceDialog
      session={session}
      onClose={vi.fn()}
      onSaved={saved}
    />,
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Find text" }), {
    target: { value: "API" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Preview replacement" }));
  await screen.findByText("Joao Interface");
  fireEvent.click(
    screen.getByRole("checkbox", { name: "I reviewed this replacement" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Apply replacement" }));
  await screen.findByRole("alert");
  expect(saved).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Apply replacement" }));
  await waitFor(() => expect(saved).toHaveBeenCalledTimes(1));
  expect(vi.mocked(transcriptEditingApi.command).mock.calls[1]![1]).toEqual(
    vi.mocked(transcriptEditingApi.command).mock.calls[0]![1],
  );
});
