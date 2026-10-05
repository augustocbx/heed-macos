import { beforeEach, expect, test, vi } from "vitest";
import { useSessionsStore } from "./sessions";
import { tagsApi } from "@/api/tags";
import { sessionsApi } from "@/api/sessions";
import type { Session, TagSnapshot } from "@heed/shared";
vi.mock("@/api/tags", () => ({ tagsApi: { list: vi.fn(), mutate: vi.fn() } }));
vi.mock("@/api/sessions", () => ({ sessionsApi: { patch: vi.fn(), list: vi.fn() } }));
const session = { id: "a", title: "Meeting", tags: ["Planning"], tagsRevision: "old" } as Session;
beforeEach(() => {
  vi.resetAllMocks();
  useSessionsStore.setState({ sessions: [session], viewing: session, tagsBusy: false, tagsError: "", tagRevision: "1", tagCatalog: [{ name: "Planning", meetingCount: 1 }], lastTagChange: null });
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
