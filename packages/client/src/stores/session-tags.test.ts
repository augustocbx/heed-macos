import { beforeEach, expect, test, vi } from "vitest";
import { useSessionsStore } from "./sessions";
import { tagsApi } from "@/api/tags";
import { sessionsApi } from "@/api/sessions";
import type { Session, TagSnapshot } from "@heed/shared";
vi.mock("@/api/tags", () => ({ tagsApi: { list: vi.fn(), mutate: vi.fn() } }));
vi.mock("@/api/sessions", () => ({ sessionsApi: { patch: vi.fn(), list: vi.fn(), create: vi.fn(), delete: vi.fn() } }));
const session = { id: "a", title: "Meeting", tags: ["Planning"], tagsRevision: "old" } as Session;
beforeEach(() => {
  vi.resetAllMocks();
  useSessionsStore.setState({ sessions: [session], viewing: session, loading: false, tagsBusy: false, tagsError: "", tagRevision: "1", tagCatalog: [{ name: "Planning", meetingCount: 1 }], lastTagChange: null });
});
test("a late load cannot revert a committed tag edit", async () => {
  let finish!: (snapshot: TagSnapshot) => void;
  vi.mocked(tagsApi.list).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const loading = useSessionsStore.getState().loadTags();
  const renamed = { ...session, tags: ["Renamed"], tagsRevision: "new" };
  vi.mocked(tagsApi.mutate).mockResolvedValue({ sessions: [renamed], tags: [{ name: "Renamed", meetingCount: 1 }], revision: "2" });
  await useSessionsStore.getState().mutateTag({ action: "rename", tag: "Planning", name: "Renamed" });
  finish({ sessions: [session], tags: [{ name: "Planning", meetingCount: 1 }], revision: "1" });
  await loading;
  expect(useSessionsStore.getState().viewing?.tags).toEqual(["Renamed"]);
});
test("late metadata responses cannot undo a newer tag snapshot", async () => {
  let finish!: (session: Session) => void;
  vi.mocked(sessionsApi.patch).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const updating = useSessionsStore.getState().update("a", { aiNotes: "new notes" });
  const renamed = { ...session, tags: ["Renamed"], tagsRevision: "new" };
  vi.mocked(tagsApi.mutate).mockResolvedValue({ sessions: [renamed], tags: [{ name: "Renamed", meetingCount: 1 }], revision: "2" });
  await useSessionsStore.getState().mutateTag({ action: "rename", tag: "Planning", name: "Renamed" });
  finish({ ...session, aiNotes: "new notes" });
  await updating;
  expect(useSessionsStore.getState().viewing).toMatchObject({ aiNotes: "new notes", tags: ["Renamed"] });
});
test("an unrelated pending metadata edit does not hide an accepted hashtag assignment", async () => {
  let finishTags!: (session: Session) => void;
  let finishNotes!: (session: Session) => void;
  vi.mocked(sessionsApi.patch).mockImplementation((_id, patch) => new Promise(resolve => {
    if (patch.tags) finishTags = resolve; else finishNotes = resolve;
  }));
  const tagging = useSessionsStore.getState().update("a", { tags: ["Planning", "New"] });
  const notes = useSessionsStore.getState().update("a", { aiNotes: "new notes" });
  finishTags({ ...session, tags: ["Planning", "New"], tagsRevision: "new" });
  await tagging;
  finishNotes({ ...session, aiNotes: "new notes" });
  await notes;
  expect(useSessionsStore.getState().viewing).toMatchObject({ tags: ["Planning", "New"], aiNotes: "new notes" });
});
test.each(["create", "delete"] as const)("a late tag snapshot preserves an intervening meeting %s", async action => {
  const second = { ...session, id: "b" };
  useSessionsStore.setState({ sessions: [session, second] });
  let finish!: (snapshot: TagSnapshot) => void;
  vi.mocked(tagsApi.mutate).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const pending = useSessionsStore.getState().mutateTag({ action: "rename", tag: "Planning", name: "Renamed" });
  if (action === "create") {
    vi.mocked(sessionsApi.create).mockResolvedValue({ ...session, id: "c", tags: ["Created"] });
    await useSessionsStore.getState().create({ title: "Created" });
  } else {
    vi.mocked(sessionsApi.delete).mockResolvedValue({ ok: true });
    await useSessionsStore.getState().remove("b");
  }
  finish({ sessions: [session, second].map(s => ({ ...s, tags: ["Renamed"] })), tags: [{ name: "Renamed", meetingCount: 2 }], revision: "2" });
  await pending;
  expect(useSessionsStore.getState().sessions.map(s => s.id).sort()).toEqual(action === "create" ? ["a", "b", "c"] : ["a"]);
  expect(useSessionsStore.getState().sessions.find(s => s.id === "a")?.tags).toEqual(["Renamed"]);
  expect(useSessionsStore.getState().tagCatalog).toContainEqual({ name: "Renamed", meetingCount: action === "create" ? 2 : 1 });
  if (action === "create") expect(useSessionsStore.getState().tagCatalog).toContainEqual({ name: "Created", meetingCount: 1 });
  expect(useSessionsStore.getState().tagRevision).toBe("");
});
test("assignment patches immediately reconcile reusable suggestions and meeting counts", async () => {
  vi.mocked(sessionsApi.patch).mockResolvedValue({ ...session, tags: ["Planning", "New"], tagsRevision: "new" });
  await useSessionsStore.getState().update("a", { tags: ["Planning", "New"] });
  expect(useSessionsStore.getState().tagCatalog).toContainEqual({ name: "New", meetingCount: 1 });
});
test("hashtag assignment and inline mutations cannot overlap, while notes can save", async () => {
  let finish!: (snapshot: TagSnapshot) => void;
  vi.mocked(tagsApi.mutate).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  vi.mocked(sessionsApi.patch).mockResolvedValue({ ...session, aiNotes: "new notes" });
  const pending = useSessionsStore.getState().mutateTag({ action: "rename", tag: "Planning", name: "Renamed" });
  await expect(useSessionsStore.getState().update("a", { tags: ["Planning", "New"] })).rejects.toThrow("Wait for the current tag change");
  await useSessionsStore.getState().update("a", { aiNotes: "new notes" });
  finish({ sessions: [{ ...session, tags: ["Renamed"] }], tags: [{ name: "Renamed", meetingCount: 1 }], revision: "2" });
  await pending;
  expect(useSessionsStore.getState().viewing).toMatchObject({ tags: ["Renamed"], aiNotes: "new notes" });
});
test("inline mutations wait for a pending hashtag save and saving state clears after failure", async () => {
  let reject!: (error: Error) => void;
  vi.mocked(sessionsApi.patch).mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
  const pending = useSessionsStore.getState().update("a", { tags: ["Planning", "New"] });
  await expect(useSessionsStore.getState().mutateTag({ action: "delete", tag: "Planning" })).rejects.toThrow("Wait for the current tag change");
  reject(new Error("disk full"));
  await expect(pending).rejects.toThrow("disk full");
  expect(useSessionsStore.getState().tagsBusy).toBe(false);
});
test("late notes-job responses preserve tags committed after the request", async () => {
  vi.mocked(tagsApi.mutate).mockResolvedValue({ sessions: [{ ...session, tags: ["Renamed"], tagsRevision: "new" }], tags: [{ name: "Renamed", meetingCount: 1 }], revision: "2" });
  await useSessionsStore.getState().mutateTag({ action: "rename", tag: "Planning", name: "Renamed" });
  useSessionsStore.getState().accept({ ...session, aiNotes: "Saved notes", notesJobs: {} });
  expect(useSessionsStore.getState().viewing).toMatchObject({ aiNotes: "Saved notes", tags: ["Renamed"], tagsRevision: "new" });
});
test("silent polling refreshes notes while preserving tag suggestions and guards", async () => {
  vi.mocked(tagsApi.list).mockResolvedValue({ sessions: [{ ...session, aiNotes: "Generated notes" }], tags: [{ name: "Planning", meetingCount: 1 }], revision: "1" });
  const polling = useSessionsStore.getState().load(true);
  expect(useSessionsStore.getState().loading).toBe(false);
  await polling;
  expect(useSessionsStore.getState().viewing?.aiNotes).toBe("Generated notes");
  expect(useSessionsStore.getState().tagCatalog).toEqual([{ name: "Planning", meetingCount: 1 }]);
});
test("a late hashtag save cannot revert a newer manual-note provenance or transcript guard", async () => {
  let finishTags!: (saved: Session) => void;
  vi.mocked(sessionsApi.patch).mockImplementation((_id, patch) => patch.tags ? new Promise(resolve => { finishTags = resolve; }) : Promise.resolve({ ...session, aiNotes: "Manual", transcriptRevision: "new-source", notesMetadata: { origin: "manual", stale: false, sourceRevision: "new-source" } }));
  const tagging = useSessionsStore.getState().update("a", { tags: ["Planning", "New"] });
  await useSessionsStore.getState().update("a", { aiNotes: "Manual" });
  finishTags({ ...session, tags: ["Planning", "New"], transcriptRevision: "old-source", notesMetadata: { origin: "automatic", stale: false, sourceRevision: "old-source" } });
  await tagging;
  expect(useSessionsStore.getState().viewing).toMatchObject({ aiNotes: "Manual", transcriptRevision: "new-source", notesMetadata: { origin: "manual" } });
});
