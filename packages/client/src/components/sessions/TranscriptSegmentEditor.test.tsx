import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { TranscriptSegmentEditor } from "./TranscriptSegmentEditor";
import { useLocaleStore } from "@/stores/locale";
import userEvent from "@testing-library/user-event";
afterEach(() => {
  vi.restoreAllMocks();
  useLocaleStore.setState({ locale: "en" });
});
test("failed persistence and refresh preserve exact composed multiline draft; retry saves empty text", async () => {
  const save = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("Conflict"), { status: 409 }),
      )
      .mockResolvedValue(undefined),
    cancel = vi.fn();
  const view = render(
    <TranscriptSegmentEditor
      value="Recognized"
      label="Edit segment"
      onSave={save}
      onCancel={cancel}
    />,
  );
  const textarea = screen.getByRole("textbox");
  fireEvent.compositionStart(textarea);
  fireEvent.change(textarea, { target: { value: "a\u0301\n<b>João</b> 🦄" } });
  fireEvent.compositionEnd(textarea);
  view.rerender(
    <TranscriptSegmentEditor
      value="Later polling"
      label="Edit segment"
      onSave={save}
      onCancel={cancel}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Save correction" }));
  await screen.findByRole("alert");
  expect(textarea).toHaveValue("a\u0301\n<b>João</b> 🦄");
  expect(cancel).not.toHaveBeenCalled();
  fireEvent.change(textarea, { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: "Save correction" }));
  await waitFor(() => expect(save).toHaveBeenLastCalledWith(""));
});
test("dirty Cancel and Escape require explicit discard, while Copy retains the draft", async () => {
  const cancel = vi.fn(),
    confirm = vi.spyOn(window, "confirm").mockReturnValue(false),
    writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  render(
    <TranscriptSegmentEditor
      value="Original"
      label="Edit segment"
      onSave={vi.fn().mockRejectedValue(new Error("Quota"))}
      onCancel={cancel}
    />,
  );
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Draft" } });
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(cancel).not.toHaveBeenCalled();
  expect(confirm).toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Save correction" }));
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "Copy draft" }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith("Draft"));
  fireEvent(
    screen.getByRole("dialog"),
    new Event("cancel", { bubbles: false, cancelable: true }),
  );
  expect(cancel).not.toHaveBeenCalled();
  confirm.mockReturnValue(true);
  fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
  expect(cancel).toHaveBeenCalledTimes(1);
});
test("an atomic persistence 409 never falsely says the accepted source changed", async () => {
  render(
    <TranscriptSegmentEditor
      value="Draft"
      label="Edit"
      onSave={vi
        .fn()
        .mockRejectedValue(
          Object.assign(
            new Error(
              "Could not save the transcript. Preserve your draft and try again.",
            ),
            { status: 409 },
          ),
        )}
      onCancel={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Save correction" }));
  expect(await screen.findByRole("alert")).not.toHaveTextContent(
    "source changed",
  );
  expect(screen.getByRole("textbox")).toHaveValue("Draft");
});
test.each([
  ["pt-BR", "Salvar correção"],
  ["fr", "Enregistrer la correction"],
  ["de", "Korrektur speichern"],
] as const)(
  "keyboard Save works in %s without translating authored Unicode",
  async (locale, saveLabel) => {
    useLocaleStore.setState({ locale });
    const save = vi.fn().mockResolvedValue(undefined);
    render(
      <TranscriptSegmentEditor
        value={"Ação / Straße / français / a\u0301 🦄"}
        label="Edit"
        onSave={save}
        onCancel={vi.fn()}
      />,
    );
    screen.getByRole("button", { name: saveLabel }).focus();
    await userEvent.keyboard("{Enter}");
    expect(save).toHaveBeenCalledWith("Ação / Straße / français / a\u0301 🦄");
  },
);
