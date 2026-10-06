import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, afterEach, expect, test, vi } from "vitest";
import { tagKey, type Session, type TagSnapshot } from "@heed/shared";
import { TagEditor } from "./TagEditor";
import { useSessionsStore } from "@/stores/sessions";
import { useLocaleStore } from "@/stores/locale";

let meetings: Session[];
let revision: number;
let fail: string | null;
function snapshot(): TagSnapshot {
  const tags = new Map<string, { name: string; meetingCount: number }>();
  for (const s of meetings) for (const tag of s.tags) {
    const value = tags.get(tagKey(tag));
    if (value) value.meetingCount++; else tags.set(tagKey(tag), { name: tag, meetingCount: 1 });
  }
  return { sessions: meetings.map(s => ({ ...s })), tags: [...tags.values()], revision: String(revision) };
}
function Host() {
  const session = useSessionsStore(s => s.sessions.find(m => m.id === "a"))!;
  return <TagEditor session={session} />;
}
beforeEach(() => {
  revision = 1; fail = null;
  meetings = ["a", "b"].map(id => ({ id, title: `Meeting ${id}`, createdAt: "2026-10-05", tags: ["Planning"], transcript: "unchanged", aiNotes: "", summary: "", duration: 1, language: "en", speakers: [], segments: [], pinned: false }));
  useLocaleStore.setState({ locale: "en" });
  useSessionsStore.setState({ sessions: meetings, viewing: null, tagCatalog: snapshot().tags, tagRevision: "1", tagsBusy: false, tagsError: "", lastTagChange: null });
  vi.stubGlobal("fetch", vi.fn(async (_path, init) => {
    if (fail) return Response.json({ error: fail }, { status: 409 });
    if (init?.method === "POST") {
      const m = JSON.parse(init.body);
      for (const session of meetings) {
        if (m.action === "add" && session.id === m.sessionId) session.tags = [...new Set([...session.tags, m.tag.trim().replace(/\s+/g, " ")])];
        if (m.action === "remove" && session.id === m.sessionId || m.action === "delete") session.tags = session.tags.filter(t => tagKey(t) !== tagKey(m.tag));
        if (m.action === "rename") session.tags = session.tags.map(t => tagKey(t) === tagKey(m.tag) ? m.name : t);
      }
      revision++;
    }
    return Response.json(snapshot());
  }));
});
afterEach(() => vi.unstubAllGlobals());

test("creates tags inline without editing the meeting title", async () => {
  const user = userEvent.setup(); render(<Host />);
  await user.click(screen.getByRole("button", { name: "Add tag" }));
  await user.type(screen.getByRole("combobox"), "Reunião semanal");
  await user.keyboard("{Enter}");
  expect(await screen.findByRole("button", { name: "Filter by Reunião semanal" })).toBeInTheDocument();
  expect(meetings[0].title).toBe("Meeting a");
  expect(meetings[1].tags).toEqual(["Planning"]);
});
test("renames across meetings inline, with scope and cancellation", async () => {
  const user = userEvent.setup(); render(<Host />);
  await user.click(screen.getByRole("button", { name: "Tag actions for Planning" }));
  await user.click(screen.getByRole("button", { name: "Rename tag" }));
  expect(screen.getByText('Rename "Planning" in 2 meetings.')).toBeInTheDocument();
  await user.clear(screen.getByRole("textbox", { name: "New tag name" }));
  await user.type(screen.getByRole("textbox", { name: "New tag name" }), "Changed");
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(meetings[0].tags).toEqual(["Planning"]);
  await user.click(screen.getByRole("button", { name: "Tag actions for Planning" }));
  await user.click(screen.getByRole("button", { name: "Rename tag" }));
  await user.clear(screen.getByRole("textbox", { name: "New tag name" }));
  await user.type(screen.getByRole("textbox", { name: "New tag name" }), "Weekly planning");
  await user.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByRole("button", { name: "Filter by Weekly planning" });
  expect(meetings.map(m => m.tags)).toEqual([["Weekly planning"], ["Weekly planning"]]);
});
test("distinguishes removal from one meeting and confirmed global deletion", async () => {
  const user = userEvent.setup(); render(<Host />);
  await user.click(screen.getByRole("button", { name: "Tag actions for Planning" }));
  await user.click(screen.getByRole("button", { name: "Delete tag everywhere" }));
  expect(screen.getByText('Delete "Planning" from 2 meetings? Meeting content will be kept.')).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(meetings[1].tags).toEqual(["Planning"]);
  await user.click(screen.getByRole("button", { name: "Tag actions for Planning" }));
  await user.click(screen.getByRole("button", { name: "Remove from this meeting" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Filter by Planning" })).not.toBeInTheDocument());
  expect(meetings[1].tags).toEqual(["Planning"]);
  // Reassign, then delete globally.
  await user.click(screen.getByRole("button", { name: "Add tag" }));
  await user.click(screen.getByRole("option", { name: "Planning" }));
  await screen.findByRole("button", { name: "Filter by Planning" });
  await user.click(screen.getByRole("button", { name: "Tag actions for Planning" }));
  await user.click(screen.getByRole("button", { name: "Delete tag everywhere" }));
  await user.click(screen.getByRole("button", { name: "Delete tag" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Filter by Planning" })).not.toBeInTheDocument());
  expect(meetings.map(m => m.tags)).toEqual([[], []]);
  expect(meetings.map(m => m.transcript)).toEqual(["unchanged", "unchanged"]);
});
test("failed saves retain input, display a localized error and leave saved tags intact", async () => {
  render(<Host />); fail = "Tags changed. Reload and try again.";
  fireEvent.click(screen.getByRole("button", { name: "Add tag" }));
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "Unsaved" } });
  fireEvent.submit(screen.getByRole("combobox").closest("form")!);
  expect(await screen.findByRole("alert")).toHaveTextContent("Tags changed. Reload and try again.");
  expect(screen.getByRole("combobox")).toHaveValue("Unsaved");
  expect(meetings[0].tags).toEqual(["Planning"]);
});
test("searches 100 suggestions and selects an existing tag with the keyboard", async () => {
  meetings[1].tags = Array.from({ length: 100 }, (_, i) => `Client ${i}`);
  useSessionsStore.setState({ tagCatalog: snapshot().tags });
  const user = userEvent.setup(); render(<Host />);
  await user.click(screen.getByRole("button", { name: "Add tag" }));
  await user.type(screen.getByRole("combobox"), "Client 99");
  expect(screen.getAllByRole("option")).toHaveLength(1);
  await user.keyboard("{ArrowDown}{Enter}");
  expect(await screen.findByRole("button", { name: "Filter by Client 99" })).toBeInTheDocument();
});
test("selects an existing suggestion with the keyboard before typing a query", async () => {
  meetings[1].tags = ["Client"];
  useSessionsStore.setState({ tagCatalog: snapshot().tags });
  const user = userEvent.setup(); render(<Host />);
  await user.click(screen.getByRole("button", { name: "Add tag" }));
  await user.keyboard("{ArrowDown}{Enter}");
  expect(await screen.findByRole("button", { name: "Filter by Client" })).toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
test.each([ ["en", "Add tag"], ["pt-BR", "Adicionar tag"], ["fr", "Ajouter une étiquette"], ["de", "Tag hinzufügen"] ] as const)("%s localizes controls without translating tag names", async (locale, label) => {
  render(<Host />);
  await act(async () => useLocaleStore.setState({ locale }));
  expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
  expect(screen.getByText("#Planning")).toBeInTheDocument();
});
test.each([
 ["en", "Add tag", "Failed to save tags"],
 ["pt-BR", "Adicionar tag", "Falha ao salvar tags"],
 ["fr", "Ajouter une étiquette", "Impossible d’enregistrer les étiquettes"],
 ["de", "Tag hinzufügen", "Tags konnten nicht gespeichert werden"],
] as const)("%s localizes a failed network save and retains the unsaved tag", async (locale, label, message) => {
 useLocaleStore.setState({ locale });
 vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
 const user = userEvent.setup(); render(<Host />);
 await user.click(screen.getByRole("button", { name: label }));
 fireEvent.change(screen.getByRole("combobox"), { target: { value: "Reunião {count} $&" } });
 await user.keyboard("{Enter}");
 expect(await screen.findByRole("alert")).toHaveTextContent(message);
 expect(screen.getByRole("combobox")).toHaveValue("Reunião {count} $&");
 expect(meetings[0].tags).toEqual(["Planning"]);
 expect(useSessionsStore.getState().tagsBusy).toBe(false);
});
test.each(['$&', '$$', 'Planning {count}'])("confirms the exact tag name %s before global deletion", async tag => {
 meetings.forEach(meeting => { meeting.tags = [tag]; });
 useSessionsStore.setState({ sessions: meetings, tagCatalog: snapshot().tags });
 const user = userEvent.setup(); render(<Host />);
 await user.click(screen.getByRole("button", { name: `Tag actions for ${tag}` }));
 await user.click(screen.getByRole("button", { name: "Delete tag everywhere" }));
 expect(screen.getByText(`Delete "${tag}" from 2 meetings? Meeting content will be kept.`)).toBeInTheDocument();
 await user.click(screen.getByRole("button", { name: "Cancel" }));
 expect(meetings.map(meeting => meeting.tags)).toEqual([[tag], [tag]]);
});
