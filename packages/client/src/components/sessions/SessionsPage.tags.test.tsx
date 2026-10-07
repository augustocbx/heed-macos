import { act,fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import type { Session } from "@heed/shared";
import { SessionsPage } from "./SessionsPage";
import { useSessionsStore } from "@/stores/sessions";
import { useLocaleStore } from "@/stores/locale";
import { tagsApi } from "@/api/tags";
vi.mock("@/api/tags", () => ({ tagsApi: { list: vi.fn(), mutate: vi.fn() } }));
vi.mock("./SessionDetail", () => ({ SessionDetail: ({ onBack }: { onBack: () => void }) => <button onClick={onBack}>Back to meetings</button> }));
const meetings = [
  { id: "a", title: "Alpha weekly", tags: ["Planning"] },
  { id: "b", title: "Beta weekly", tags: ["Other"] },
].map(s => ({ ...s, createdAt: "2026-10-05", speakers: [], duration: 1, language: "en", transcript: "", segments: [], aiNotes: "", summary: "", pinned: false } as Session));
beforeEach(() => {
  vi.resetAllMocks(); useLocaleStore.setState({ locale: "en" });
  useSessionsStore.setState({ sessions: meetings, viewing: null, tagCatalog: [{ name: "Planning", meetingCount: 1 }, { name: "Other", meetingCount: 1 }], tagRevision: "1", tagsBusy: false, tagsError: "", lastTagChange: null });
  vi.mocked(tagsApi.list).mockResolvedValue({ sessions: meetings, tags: useSessionsStore.getState().tagCatalog, revision: "1" });
});
test("renaming a filtered tag preserves the matching meetings and text search", async () => {
  render(<SessionsPage />);
  fireEvent.change(screen.getByPlaceholderText("Search meetings..."), { target: { value: "weekly" } });
  fireEvent.click(screen.getByRole("button", { name: "Filter by Planning" }));
  expect(screen.queryByText("Beta weekly")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Tag actions for Planning" }));
  fireEvent.click(screen.getByRole("button", { name: "Rename tag" }));
  fireEvent.change(screen.getByRole("textbox", { name: "New tag name" }), { target: { value: "Renamed" } });
  vi.mocked(tagsApi.mutate).mockResolvedValue({ sessions: [{ ...meetings[0], tags: ["Renamed"] }, meetings[1]], tags: [{ name: "Renamed", meetingCount: 1 }, { name: "Other", meetingCount: 1 }], revision: "2" });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByRole("button", { name: "Filter by Renamed" });
  expect(screen.getByText("Alpha weekly")).toBeInTheDocument();
  expect(screen.queryByText("Beta weekly")).not.toBeInTheDocument();
});
test("deleting a filtered tag clears its filter without clearing text search", async () => {
  render(<SessionsPage />);
  fireEvent.change(screen.getByPlaceholderText("Search meetings..."), { target: { value: "weekly" } });
  fireEvent.click(screen.getByRole("button", { name: "Filter by Planning" }));
  fireEvent.click(screen.getByRole("button", { name: "Tag actions for Planning" }));
  fireEvent.click(screen.getByRole("button", { name: "Delete tag everywhere" }));
  vi.mocked(tagsApi.mutate).mockResolvedValue({ sessions: [{ ...meetings[0], tags: [] }, meetings[1]], tags: [{ name: "Other", meetingCount: 1 }], revision: "2" });
  fireEvent.click(screen.getByRole("button", { name: "Delete tag" }));
  await screen.findByText("Beta weekly");
  expect(screen.getByPlaceholderText("Search meetings...")).toHaveValue("weekly");
  expect(screen.queryByRole("button", { name: "Filter by Planning" })).not.toBeInTheDocument();
});
test("returning from detail clears a filter removed by another tab", async () => {
  render(<SessionsPage />);
  fireEvent.click(screen.getByRole("button", { name: "Filter by Planning" }));
  fireEvent.click(screen.getByText("Alpha weekly"));
  vi.mocked(tagsApi.list).mockResolvedValue({ sessions: [{ ...meetings[0], tags: [] }, meetings[1]], tags: [{ name: "Other", meetingCount: 1 }], revision: "2" });
  fireEvent(window, new Event("focus"));
  await waitFor(() => expect(useSessionsStore.getState().tagRevision).toBe("2"));
  fireEvent.click(screen.getByRole("button", { name: "Back to meetings" }));
  expect(screen.getByText("Beta weekly")).toBeInTheDocument();
});
test.each(["rename", "delete"] as const)("a historical %s does not change a recreated tag's filter", async action => {
  const recreated = [{ ...meetings[0], tags: ["Planning"] }, { ...meetings[1], tags: ["Renamed"] }];
  const lastTagChange = action === "rename" ? { action, tag: "Planning", name: "Renamed" } : { action, tag: "Planning" };
  useSessionsStore.setState({ sessions: recreated, lastTagChange });
  vi.mocked(tagsApi.list).mockResolvedValue({ sessions: recreated, tags: [{ name: "Planning", meetingCount: 1 }, { name: "Renamed", meetingCount: 1 }], revision: "3" });
  render(<SessionsPage />);
  await waitFor(() => expect(useSessionsStore.getState().tagRevision).toBe("3"));
  fireEvent.click(screen.getByRole("button", { name: "Filter by Planning" }));
  expect(screen.queryByText("Beta weekly")).not.toBeInTheDocument();
  vi.mocked(tagsApi.list).mockResolvedValue({ sessions: recreated, tags: [{ name: "Planning", meetingCount: 1 }, { name: "Renamed", meetingCount: 1 }], revision: "4" });
  fireEvent(window, new Event("focus"));
  await waitFor(() => expect(useSessionsStore.getState().tagRevision).toBe("4"));
  expect(screen.queryByText("Beta weekly")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "#Planning" }).className).toContain("tagFilterActive");
});
test('literal search immediately follows accepted corrections while earlier notes stay stale',async()=>{
 render(<SessionsPage/>);await waitFor(()=>expect(tagsApi.list).toHaveBeenCalled());
 fireEvent.change(screen.getByPlaceholderText('Search meetings...'),{target:{value:'<b>João</b>.*'}});expect(screen.queryByText('Alpha weekly')).not.toBeInTheDocument();
 const corrected={...meetings[0]!,transcript:'<b>João</b>.*',transcriptRevision:'b'.repeat(64),transcriptVersion:2,aiNotes:'Earlier notes',notesMetadata:{origin:'manual' as const,sourceRevision:'a'.repeat(64),stale:true}};
 act(()=>useSessionsStore.getState().accept(corrected));expect(screen.getByText('Alpha weekly')).toBeInTheDocument();expect(useSessionsStore.getState().sessions[0]!.notesMetadata?.stale).toBe(true);
});
