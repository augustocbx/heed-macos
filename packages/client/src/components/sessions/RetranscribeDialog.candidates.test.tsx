import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type {
  CandidateInput,
  Session,
  TranscriptCandidate,
  TranscribeResult,
} from "@heed/shared";
import { RetranscribeDialog } from "./RetranscribeDialog";
import { useSessionsStore } from "@/stores/sessions";
import { useRecordingStore } from "@/stores/recording";
import { setLocale, tr } from "@/lib/i18n";
const candidate = (): TranscriptCandidate => ({
  id: "draft",
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
const source = (candidates: TranscriptCandidate[] = []): Session => ({
  id: "s",
  title: "Meeting",
  createdAt: "2026-10-06",
  duration: 10,
  transcript: "Old",
  segments: [{ speaker: "Ana", start: 0, end: 10, text: "Old", auto: false }],
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
    candidates,
    candidateRequestReceipts: [],
  },
});
const result: TranscribeResult = {
  success: true,
  finalized: true,
  duration: 10,
  text: "New",
  files: { wav: "temporary", srt: "", txt: "" },
  metadata: { language: "pt", model: "actual-small" },
  segments: [{ speaker: "Ana", start: 0, end: 10, text: "New" }],
  speakers: ["Ana"],
  wordCount: 1,
};
beforeEach(() => {
  setLocale("en");
  const s = source();
  useSessionsStore.setState({ sessions: [s], viewing: s });
  useRecordingStore.setState({ recording: false, processing: false });
});
afterEach(() => vi.unstubAllGlobals());
test("reopens durable drafts without saved audio and does not start recognition to review", () => {
  const s = { ...source([candidate()]), files: {} };
  useSessionsStore.setState({ sessions: [s], viewing: s });
  vi.stubGlobal("fetch", vi.fn());
  render(<RetranscribeDialog session={s} onClose={vi.fn()} onBusy={vi.fn()} />);
  expect(screen.getByText("New")).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Replace accepted transcript" }),
  ).toBeEnabled();
  expect(
    screen.getByRole("button", { name: "Start transcription" }),
  ).toBeDisabled();
  expect(fetch).not.toHaveBeenCalled();
});
test("candidate capacity blocks recognition before any request", () => {
  const s = source([candidate(), { ...candidate(), id: "second" }]);
  useSessionsStore.setState({ sessions: [s], viewing: s });
  vi.stubGlobal("fetch", vi.fn());
  render(<RetranscribeDialog session={s} onClose={vi.fn()} onBusy={vi.fn()} />);
  expect(
    screen.getByRole("button", { name: "Start transcription" }),
  ).toBeDisabled();
  expect(
    screen.getByText("Discard a pending draft before creating another."),
  ).toBeVisible();
});
test("failed stage retains complete draft and retries the same input without another recognition run", async () => {
  let asr = 0;
  const inputs: CandidateInput[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      if (String(url).includes("/api/transcribe")) {
        asr++;
        return new Response(
          `event: result\ndata: ${JSON.stringify(result)}\n\n`,
        );
      }
      const input = JSON.parse(init.body) as CandidateInput;
      inputs.push(input);
      return inputs.length === 1
        ? Response.json({ error: "Disk full" }, { status: 500 })
        : Response.json({
            ...source(),
            transcriptEditing: {
              ...source().transcriptEditing,
              candidates: [{ ...candidate(), requestId: input.requestId }],
            },
          });
    }),
  );
  const onClose = vi.fn();
  render(
    <RetranscribeDialog
      session={source()}
      onClose={onClose}
      onBusy={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Start transcription" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Disk full");
  expect(screen.getByText("New")).toBeVisible();
  expect(useSessionsStore.getState().viewing?.transcript).toBe("Old");
  fireEvent.click(screen.getByRole("button", { name: "Retry saving draft" }));
  await screen.findByRole("button", { name: "Replace accepted transcript" });
  expect(asr).toBe(1);
  expect(inputs[1]).toEqual(inputs[0]);
  expect(onClose).not.toHaveBeenCalled();
});
test("unsaved-result close confirmation keeps local draft on cancel", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) =>
      String(url).includes("/api/transcribe")
        ? new Response(`event: result\ndata: ${JSON.stringify(result)}\n\n`)
        : Response.json({ error: "Disk full" }, { status: 500 }),
    ),
  );
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  const onClose = vi.fn();
  render(
    <RetranscribeDialog
      session={source()}
      onClose={onClose}
      onBusy={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Start transcription" }));
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(confirm).toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
  confirm.mockRestore();
});
test.each(["en", "pt-BR", "fr", "de"] as const)(
  "%s locale uses raw auto selection and translates recognition busy text",
  async (locale) => {
    setLocale(locale);
    let form: FormData | undefined;
    let resolve!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init) => {
        form = init.body;
        return new Promise<Response>((r) => {
          resolve = r;
        });
      }),
    );
    const onBusy = vi.fn();
    const view = render(
      <RetranscribeDialog
        session={source()}
        onClose={vi.fn()}
        onBusy={onBusy}
      />,
    );
    fireEvent.change(screen.getByLabelText(tr("Meeting language")), {
      target: { value: "en" },
    });
    fireEvent.change(screen.getByLabelText(tr("Meeting language")), {
      target: { value: "auto" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: tr("Start transcription") }),
    );
    expect(form!.get("language")).toBe("auto");
    expect(
      screen.getByRole("button", { name: tr("Transcribing…") }),
    ).toBeDisabled();
    if (locale !== "en") expect(tr("Transcribing…")).not.toBe("Transcribing…");
    await act(async () =>
      resolve(new Response('event: error\ndata: {"message":"Stopped"}\n\n')),
    );
    expect(onBusy).toHaveBeenLastCalledWith(false);
    view.unmount();
  },
);
test("keyboard trap includes comparison, escape closes and focus returns to opener", () => {
  const opener = document.createElement("button");
  document.body.append(opener);
  opener.focus();
  const s = source([candidate()]);
  useSessionsStore.setState({ sessions: [s], viewing: s });
  const onClose = vi.fn();
  const view = render(
    <RetranscribeDialog session={s} onClose={onClose} onBusy={vi.fn()} />,
  );
  const close = screen.getByRole("button", { name: "Close" });
  close.focus();
  fireEvent.keyDown(close, { key: "Tab" });
  expect(document.activeElement).not.toBe(close);
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  expect(onClose).toHaveBeenCalledOnce();
  view.unmount();
  expect(document.activeElement).toBe(opener);
  opener.remove();
});
