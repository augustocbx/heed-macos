import { create } from "zustand";
import { tagKey, uniqueTags, type Session, type SessionPatch, type TagSnapshot } from "@heed/shared";
import { sessionsApi } from "@/api/sessions.ts";
import { tagsApi, type TagCommand } from "@/api/tags";
import { ApiError } from "@/api/client";

interface SessionsState {
  sessions: Session[];
  loading: boolean;
  viewing: Session | null;
  tagCatalog: TagSnapshot["tags"];
  tagRevision: string;
  tagsBusy: boolean;
  tagsError: string;
  lastTagChange: TagCommand | null;
  load: () => Promise<void>;
  loadTags: () => Promise<void>;
  mutateTag: (command: TagCommand) => Promise<void>;
  create: (session: Partial<Session>) => Promise<Session>;
  update: (id: string, patch: SessionPatch) => Promise<void>;
  remove: (id: string) => Promise<void>;
  view: (session: Session | null) => void;
}
let generation = 0;
let tagGeneration = 0;
let loadSequence = 0;
function catalogFor(sessions: Session[], known: TagSnapshot["tags"] = []): TagSnapshot["tags"] {
  const tags = new Map<string, { name: string; meetingCount: number }>();
  for (const session of sessions) for (const name of uniqueTags(session.tags ?? [], known.map(t => t.name))) {
    const key = tagKey(name);
    const existing = tags.get(key);
    if (existing) existing.meetingCount++; else tags.set(key, { name, meetingCount: 1 });
  }
  return [...tags.values()].sort((a, b) => a.name.localeCompare(b.name));
}
export const useSessionsStore = create<SessionsState>((set, get) => {
  const apply = (snapshot: TagSnapshot, full = false, preserveMembership = false) => set(state => {
    const source = preserveMembership ? state.sessions : snapshot.sessions;
    const sessions = source.map(entry => {
      const saved = snapshot.sessions.find(s => s.id === entry.id);
      const current = state.sessions.find(s => s.id === entry.id);
      return !saved ? entry : full || !current ? saved : { ...current, tags: saved.tags, tagsRevision: saved.tagsRevision };
    });
    const membershipChanged = preserveMembership && (sessions.length !== snapshot.sessions.length || sessions.some(s => !snapshot.sessions.some(saved => saved.id === s.id)));
    const savedView = sessions.find(s => s.id === state.viewing?.id);
    return { sessions, viewing: state.viewing ? savedView ?? null : null, tagCatalog: catalogFor(sessions, snapshot.tags), tagRevision: membershipChanged ? "" : snapshot.revision, tagsError: "" };
  });
  const refresh = async (full: boolean) => {
    if (get().tagsBusy) return;
    const version = generation;
    const sequence = ++loadSequence;
    if (full) set({ loading: true });
    try {
      const snapshot = await tagsApi.list();
      if (version === generation && sequence === loadSequence) apply(snapshot, full);
    } catch {
      if (version === generation && sequence === loadSequence) set({ tagsError: "Failed to load tags" });
    } finally {
      if (sequence === loadSequence) set({ loading: false });
    }
  };
  return {
    sessions: [], loading: false, viewing: null,
    tagCatalog: [], tagRevision: "", tagsBusy: false, tagsError: "", lastTagChange: null,
    load: () => refresh(true),
    loadTags: () => refresh(false),
    mutateTag: async command => {
      if (get().tagsBusy) throw new Error("Wait for the current tag change to finish.");
      if (!get().tagRevision) await get().loadTags();
      if (!get().tagRevision) throw new Error("Failed to load tags");
      if (get().tagsBusy) throw new Error("Wait for the current tag change to finish.");
      ++generation;
      ++tagGeneration;
      set({ tagsBusy: true });
      try {
        const snapshot = await tagsApi.mutate({ ...command, expectedRevision: get().tagRevision });
        apply(snapshot, false, true);
        set({ lastTagChange: command });
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) {
          set({ tagsBusy: false });
          await get().loadTags();
        }
        throw error;
      } finally { set({ tagsBusy: false }); }
    },
    create: async session => {
      ++generation;
      const created = await sessionsApi.create(session);
      ++generation;
      set(state => {
        const sessions = [created, ...state.sessions];
        return { sessions, tagCatalog: catalogFor(sessions, state.tagCatalog), tagRevision: "" };
      });
      return created;
    },
    update: async (id, patch) => {
      const changesTags = patch.tags !== undefined;
      if (changesTags && get().tagsBusy) throw new Error("Wait for the current tag change to finish.");
      if (changesTags) set({ tagsBusy: true });
      ++generation;
      const tagVersion = patch.tags === undefined ? tagGeneration : ++tagGeneration;
      const current = get().sessions.find(s => s.id === id) ?? get().viewing;
      const payload = patch.tags === undefined ? patch : { ...patch, tagsRevision: current?.tagsRevision };
      try {
        const updated = await sessionsApi.patch(id, payload);
        set(state => {
          const merge = (existing: Session) => {
            const fields = Object.fromEntries(Object.keys(patch).map(key => [key, updated[key as keyof Session]]));
            if (tagVersion !== tagGeneration) { delete fields.tags; delete fields.tagsRevision; }
            else if (patch.tags !== undefined) fields.tagsRevision = updated.tagsRevision;
            return { ...existing, ...fields, updatedAt: updated.updatedAt } as Session;
          };
          const sessions = state.sessions.map(s => s.id === id ? merge(s) : s);
          return {
            sessions,
            tagCatalog: catalogFor(sessions, state.tagCatalog),
            viewing: state.viewing?.id === id ? merge(state.viewing) : state.viewing,
            ...(patch.tags !== undefined ? { tagRevision: "" } : {}),
          };
        });
      } catch (error) {
        if (changesTags && error instanceof ApiError && error.status === 409) {
          set({ tagsBusy: false });
          await get().loadTags();
        }
        throw error;
      } finally { if (changesTags) set({ tagsBusy: false }); }
    },
    remove: async id => {
      ++generation;
      await sessionsApi.delete(id);
      ++generation;
      set(state => {
        const sessions = state.sessions.filter(s => s.id !== id);
        return { sessions, tagCatalog: catalogFor(sessions, state.tagCatalog), viewing: state.viewing?.id === id ? null : state.viewing, tagRevision: "" };
      });
    },
    view: session => set({ viewing: session }),
  };
});
