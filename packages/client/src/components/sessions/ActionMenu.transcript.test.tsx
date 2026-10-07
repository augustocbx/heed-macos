import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ActionMenu } from "./ActionMenu";
import { correctionMeeting } from "./transcript.test-support";
afterEach(() => vi.restoreAllMocks());
test.each([
  ["Export as .txt", "text/plain"],
  ["Export as .md", "text/markdown"],
])(
  "%s contains accepted corrected Unicode and literal markup",
  async (action, mime) => {
    const session = {
      ...correctionMeeting(),
      transcript: "<b>João</b> a\u0301 🦄\nConfirmed",
    };
    let blob!: Blob;
    vi.spyOn(URL, "createObjectURL").mockImplementation((value) => {
      blob = value as Blob;
      return "blob:correction";
    });
    const revoke = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => {});
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    render(
      <ActionMenu
        x={20}
        y={20}
        session={session}
        onClose={vi.fn()}
        onTogglePin={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    fireEvent.mouseEnter(screen.getByText("Transcript"));
    fireEvent.click(screen.getByText(action));
    const text = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsText(blob);
    });
    expect(text).toBe(session.transcript);
    expect(blob.type).toBe(mime);
    expect(revoke).toHaveBeenCalledWith("blob:correction");
  },
);
