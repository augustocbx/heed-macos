import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import type { Session } from "@heed/shared";
import { TitleInput } from "./TitleInput";
import { useSessionsStore } from "@/stores/sessions";
import { useLocaleStore } from "@/stores/locale";
import { sessionsApi } from "@/api/sessions";
vi.mock("@/api/sessions", () => ({ sessionsApi: { patch: vi.fn() } }));
const session = { id: "a", title: "Meeting", tags: ["Planning"], tagsRevision: "r1" } as Session;
beforeEach(() => { vi.resetAllMocks(); useLocaleStore.setState({ locale: "en" }); useSessionsStore.setState({ sessions: [session], viewing: session }); });
test("hashtag save failures retain the typed title and show an error", async () => {
  vi.mocked(sessionsApi.patch).mockRejectedValue(new Error("Tags changed. Reload and try again."));
  render(<TitleInput sessionId="a" value="Meeting" tags={session.tags} />);
  const input = screen.getByPlaceholderText("Untitled meeting (use #tags)");
  fireEvent.change(input, { target: { value: "Weekly #reunião" } });
  fireEvent.blur(input);
  expect(await screen.findByRole("alert")).toHaveTextContent("Tags changed");
  expect(input).toHaveValue("Weekly #reunião");
  expect(useSessionsStore.getState().viewing?.tags).toEqual(["Planning"]);
});
test("the hashtag shortcut reuses normalized names and preserves tags added inline", async () => {
  vi.mocked(sessionsApi.patch).mockImplementation(async (_id, patch) => ({ ...session, ...patch }));
  render(<TitleInput sessionId="a" value="Meeting" tags={session.tags} />);
  useSessionsStore.setState({ sessions: [{ ...session, tags: ["Planning", "Inline"], tagsRevision: "r2" }] });
  const input = screen.getByPlaceholderText("Untitled meeting (use #tags)");
  fireEvent.change(input, { target: { value: "Weekly #planning #reunião" } });
  fireEvent.blur(input);
  await waitFor(() => expect(useSessionsStore.getState().sessions[0].tags).toEqual(["Planning", "Inline", "reunião"]));
});
