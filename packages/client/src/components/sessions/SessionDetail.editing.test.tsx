import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { SessionDetail } from "./SessionDetail";
import { correctionMeeting } from "./transcript.test-support";
import { useSessionsStore } from "@/stores/sessions";
import { useModelsStore } from "@/stores/models";
import { useTemplatesStore } from "@/stores/templates";
import { useRecordingStore } from "@/stores/recording";
const original = correctionMeeting();
beforeEach(() => {
  vi.restoreAllMocks();
  useSessionsStore.setState({
    sessions: [original],
    viewing: original,
    load: vi.fn().mockResolvedValue(undefined),
  });
  useModelsStore.setState({ load: vi.fn() });
  useTemplatesStore.setState({ load: vi.fn() });
  useRecordingStore.setState({ recording: false, processing: false });
});
afterEach(() => vi.unstubAllGlobals());
test("confirmed segment correction uses opening guards and current search/copy source", async () => {
  const corrected = {
    ...original,
    transcriptVersion: 2,
    transcriptRevision: "b".repeat(64),
    transcript: "João API\nAPI",
    segments: original.segments.map((segment, index) =>
      index ? segment : { ...segment, text: "João API" },
    ),
    notesMetadata: {
      origin: "manual" as const,
      sourceRevision: original.transcriptRevision!,
      stale: true,
    },
  };
  const fetch = vi.fn().mockResolvedValue(Response.json(corrected));
  vi.stubGlobal("fetch", fetch);
  const copy = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: copy },
  });
  const view = render(<SessionDetail session={original} onBack={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit segment 1" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Transcript text" }), {
    target: { value: "João API" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save correction" }));
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  expect(JSON.parse(fetch.mock.calls[0]![1].body)).toMatchObject({
    action: "edit",
    target: { kind: "segment", index: 0 },
    text: "João API",
    expectedTranscriptVersion: 1,
    expectedTranscriptRevision: original.transcriptRevision,
  });
  const saved = useSessionsStore.getState().viewing!;
  expect(saved).toMatchObject({
    transcript: corrected.transcript,
    notesMetadata: { stale: true },
  });
  expect(saved.segments[0]).toMatchObject({ start: 0, end: 2, channel: "mic" });
  view.rerender(<SessionDetail session={saved} onBack={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Copy plain text" }));
  expect(copy).toHaveBeenCalledWith(corrected.transcript);
});
test("refresh and a conflict preserve draft and original guards until explicit reload", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValue(
      Response.json({ error: "Transcript changed" }, { status: 409 }),
    );
  vi.stubGlobal("fetch", fetch);
  const view = render(<SessionDetail session={original} onBack={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit segment 1" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Transcript text" }), {
    target: { value: "Draft a\u0301\nJoão" },
  });
  view.rerender(
    <SessionDetail
      session={{ ...original, transcriptVersion: 2 }}
      onBack={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Save correction" }));
  await screen.findByRole("alert");
  expect(
    JSON.parse(fetch.mock.calls[0]![1].body).expectedTranscriptVersion,
  ).toBe(1);
  expect(screen.getByRole("textbox", { name: "Transcript text" })).toHaveValue(
    "Draft a\u0301\nJoão",
  );
  expect(
    screen.getByRole("button", { name: "Reload current text" }),
  ).toBeVisible();
});
test("untimed and intentionally empty transcripts edit as documents; provisional sessions have no correction controls", async () => {
  const untimed = {
      ...original,
      segments: [],
      speakers: [],
      transcript: "Whole document",
    },
    empty = { ...untimed, transcript: "", transcriptVersion: 2 };
  useSessionsStore.setState({ sessions: [untimed], viewing: untimed });
  const fetch = vi.fn().mockResolvedValue(Response.json(empty));
  vi.stubGlobal("fetch", fetch);
  const view = render(<SessionDetail session={untimed} onBack={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit transcript" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Transcript text" }), {
    target: { value: "" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save correction" }));
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  expect(JSON.parse(fetch.mock.calls[0]![1].body)).toMatchObject({
    target: { kind: "document" },
    text: "",
  });
  view.rerender(<SessionDetail session={empty} onBack={vi.fn()} />);
  expect(screen.getByText("Empty transcript text")).toBeVisible();
  view.rerender(
    <SessionDetail
      session={{ ...empty, transcriptFinalized: false }}
      onBack={vi.fn()}
    />,
  );
  expect(
    screen.queryByRole("button", { name: "Edit transcript" }),
  ).not.toBeInTheDocument();
});
test("ambiguous save failure retries the same request; explicit reload replaces draft only after discard approval", async () => {
  const updated = {
    ...original,
    transcriptVersion: 2,
    transcriptRevision: "b".repeat(64),
    segments: original.segments.map((segment, index) =>
      index ? segment : { ...segment, text: "Current text" },
    ),
    transcript: "Current text\nAPI",
  };
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json(
        {
          error:
            "Could not save the transcript. Preserve your draft and try again.",
        },
        { status: 409 },
      ),
    )
    .mockResolvedValueOnce(
      Response.json(
        {
          error:
            "Could not save the transcript. Preserve your draft and try again.",
        },
        { status: 409 },
      ),
    )
    .mockResolvedValueOnce(Response.json(updated));
  vi.stubGlobal("fetch", fetch);
  render(<SessionDetail session={original} onBack={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit segment 1" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Transcript text" }), {
    target: { value: "Unsaved draft" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save correction" }));
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "Save correction" }));
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  expect(JSON.parse(fetch.mock.calls[1]![1].body)).toEqual(
    JSON.parse(fetch.mock.calls[0]![1].body),
  );
  const confirm = vi
    .spyOn(window, "confirm")
    .mockReturnValueOnce(false)
    .mockReturnValue(true);
  const load = vi.fn().mockImplementation(async () => {
    useSessionsStore.setState({ sessions: [updated], viewing: updated });
  });
  useSessionsStore.setState({ load });
  fireEvent.click(screen.getByRole("button", { name: "Reload current text" }));
  expect(load).not.toHaveBeenCalled();
  expect(screen.getByRole("textbox", { name: "Transcript text" })).toHaveValue(
    "Unsaved draft",
  );
  fireEvent.click(screen.getByRole("button", { name: "Reload current text" }));
  await waitFor(() =>
    expect(
      screen.getByRole("textbox", { name: "Transcript text" }),
    ).toHaveValue("Current text"),
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Transcript text" }), {
    target: { value: "New draft" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save correction" }));
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
  expect(
    JSON.parse(fetch.mock.calls[2]![1].body).expectedTranscriptVersion,
  ).toBe(2);
  confirm.mockRestore();
});
test("all-empty timed text explains absent usable source and cannot generate labels-only notes", () => {
  const empty = {
    ...original,
    transcript: "\n",
    segments: original.segments.map((segment) => ({ ...segment, text: "" })),
  };
  render(<SessionDetail session={empty} onBack={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "AI Notes" }));
  expect(
    screen.getByRole("button", { name: /Generate AI notes/ }),
  ).toBeDisabled();
  expect(
    screen.getByText(
      "This transcript has no usable text. Add a correction before generating notes.",
    ),
  ).toBeVisible();
});
