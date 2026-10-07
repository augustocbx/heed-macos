import { create } from "zustand";
import { tagKey, uniqueTags, type Session, type SessionPatch, type TagSnapshot } from "@heed/shared";
import { sessionsApi } from "@/api/sessions.ts";
import { tagsApi, type TagCommand } from "@/api/tags";
import { acceptedSourceKeys, acceptedDerivedKeys, guardForSession, mergeAcceptedSession, sessionVersion } from "@/lib/acceptedSession";
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
  load: (silent?: boolean) => Promise<void>;
  accept: (session: Session, requestOrder?: number) => Session;
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
const issuedRequests = new Map<string, number>();
const appliedRequests = new Map<string, number>();
const metadataOwners = new Map<string, Map<string, number>>();
export function beginSessionRequest(id: string): number {
  ++generation;
  const order = (issuedRequests.get(id) ?? 0) + 1;
  issuedRequests.set(id, order);
  return order;
}
const notesGenerations = new Map<string, number>();
const notesFields = ["aiNotes", "transcript", "language", "speakers", "segments", "transcriptFinalized"] as const;
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
      const current = state.sessions.find(s => s.id === entry.id) ?? (state.viewing?.id === entry.id ? state.viewing : null);
      return !saved ? entry : full ? current ? mergeAcceptedSession(current, saved) : saved : !current ? saved : { ...current, tags: saved.tags, tagsRevision: saved.tagsRevision };
    });
    const membershipChanged = preserveMembership && (sessions.length !== snapshot.sessions.length || sessions.some(s => !snapshot.sessions.some(saved => saved.id === s.id)));
    const savedView = sessions.find(s => s.id === state.viewing?.id);
    return { sessions, viewing: state.viewing ? savedView ?? null : null, tagCatalog: catalogFor(sessions, snapshot.tags), tagRevision: membershipChanged ? "" : snapshot.revision, tagsError: "" };
  });
  const refresh = async (full: boolean, silent = false) => {
    if (get().tagsBusy) return;
    const version = generation;
    const sequence = ++loadSequence;
    if (full && !silent) set({ loading: true });
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
    load: (silent = false) => refresh(true, silent),
    accept: (session, requestOrder) => {
      const current = get().sessions.find(existing => existing.id === session.id) ?? (get().viewing?.id === session.id ? get().viewing : null);
      const order = requestOrder ?? beginSessionRequest(session.id);
      if (current && order < (appliedRequests.get(session.id) ?? 0) && sessionVersion(session) <= sessionVersion(current)) return current;
      appliedRequests.set(session.id, Math.max(order, appliedRequests.get(session.id) ?? 0));
      ++generation;
      notesGenerations.set(session.id, (notesGenerations.get(session.id) ?? 0) + 1);
      set(state => {
        const listed = state.sessions.some(existing => existing.id === session.id);
        const current = state.sessions.find(existing => existing.id === session.id) ?? (state.viewing?.id === session.id ? state.viewing : null);
        // Transcript and notes responses do not own independent meeting metadata.
        const saved = current ? { ...mergeAcceptedSession(current, session), title: current.title, pinned: current.pinned, tags: current.tags, tagsRevision: current.tagsRevision } : session;
        const sessions = listed ? state.sessions.map(existing => existing.id === session.id ? saved : existing) : [saved, ...state.sessions];
        return { sessions, viewing: state.viewing?.id === session.id ? saved : state.viewing, tagCatalog: catalogFor(sessions, state.tagCatalog), ...(current ? {} : { tagRevision: "" }) };
      });
      return get().sessions.find(saved => saved.id === session.id)!;
    },
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
      const changesSource = acceptedSourceKeys.some(key => Object.hasOwn(patch, key));
      const changesNotes = changesSource || notesFields.some(key => Object.hasOwn(patch, key));
      const current = get().sessions.find(s => s.id === id) ?? (get().viewing?.id === id ? get().viewing : null);
      let payload = patch.tags === undefined ? patch : { ...patch, tagsRevision: current?.tagsRevision };
      // Reject incomplete guards before changing request ownership or busy state.
      if (changesSource || Object.hasOwn(patch, "aiNotes")) {
        if (patch.expectedTranscriptRevision !== undefined || patch.expectedTranscriptVersion !== undefined) {
          if (!patch.expectedTranscriptRevision || !Number.isSafeInteger(patch.expectedTranscriptVersion) || patch.expectedTranscriptVersion! < 0)
            throw new Error("The transcript source is unavailable. Refresh before saving.");
        } else {
          if (!current) throw new Error("The transcript source is unavailable. Refresh before saving.");
          payload = { ...payload, ...guardForSession(current) };
        }
      }
      const changesTags = patch.tags !== undefined;
      if (changesTags && get().tagsBusy) throw new Error("Wait for the current tag change to finish.");
      const notesVersion = (notesGenerations.get(id) ?? 0) + (changesNotes ? 1 : 0);
      if (changesNotes) notesGenerations.set(id, notesVersion);
      if (changesTags) set({ tagsBusy: true });
      ++generation;
      const tagVersion = changesTags ? ++tagGeneration : tagGeneration;
      const order = beginSessionRequest(id);
      const owners = metadataOwners.get(id) ?? new Map<string, number>();
      for (const key of Object.keys(patch)) if (!key.startsWith("expected") && !acceptedSourceKeys.includes(key as never)) owners.set(key, order);
      metadataOwners.set(id, owners);
      try {
        const updated = await sessionsApi.patch(id, payload);
        appliedRequests.set(id, Math.max(order, appliedRequests.get(id) ?? 0));
        ++generation;
        set(state => {
          const merge = (existing: Session) => {
            const authoritative = mergeAcceptedSession(existing, updated);
            const newer = sessionVersion(updated) > sessionVersion(existing);
            const fields: Partial<Session> = {};
            for (const key of Object.keys(patch)) {
              if (!key.startsWith("expected") && !acceptedSourceKeys.includes(key as never) && metadataOwners.get(id)?.get(key) === order)
                Object.assign(fields, { [key]: authoritative[key as keyof Session] });
            }
            if (newer) {
              for (const key of [...acceptedSourceKeys, ...acceptedDerivedKeys]) Object.assign(fields, { [key]: authoritative[key] });
            } else if (changesNotes && notesVersion === notesGenerations.get(id) && order >= (appliedRequests.get(id) ?? 0) && sessionVersion(updated) >= sessionVersion(existing)) {
              for (const key of ["aiNotes", "notesMetadata", "notesJobs"] as const) Object.assign(fields, { [key]: updated[key] });
            } else if (changesNotes) { delete fields.aiNotes; }
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
    view: session => set(state => {
      const current = state.sessions.find(saved => saved.id === session?.id);
      return { viewing: session && current && sessionVersion(session) <= sessionVersion(current) ? current : session };
    }),
  };
});
