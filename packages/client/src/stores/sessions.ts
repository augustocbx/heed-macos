import { create } from "zustand";
import type { Session, SessionPatch } from "@heed/shared";
import { sessionsApi } from "@/api/sessions.ts";

interface SessionsState {
	sessions: Session[];
	loading: boolean;
	viewing: Session | null;
	load: (silent?: boolean) => Promise<void>;
	create: (session: Partial<Session>) => Promise<Session>;
	update: (id: string, patch: SessionPatch) => Promise<void>;
	remove: (id: string) => Promise<void>;
	view: (session: Session | null) => void;
 accept: (session: Session) => void;
}

export const useSessionsStore = create<SessionsState>((set, get) => ({
	sessions: [],
	loading: false,
	viewing: null,

	load: async (silent = false) => {
		const before = get().sessions;
  if (!silent) set({ loading: true });
		try {
			const sessions = await sessionsApi.list();
			// A response captured before a local save must never undo that save.
   set(state => state.sessions !== before ? { loading: false } : { sessions, loading: false, viewing: state.viewing ? sessions.find(session => session.id === state.viewing!.id) || null : null });
		} catch {
			set({ loading: false });
		}
	},

	create: async (session) => {
		const created = await sessionsApi.create(session);
		set((state) => ({ sessions: [created, ...state.sessions] }));
		return created;
	},

	update: async (id, patch) => {
		const updated = await sessionsApi.patch(id, patch);
		set((state) => ({
			sessions: state.sessions.map((s) => (s.id === id ? updated : s)),
			viewing: state.viewing?.id === id ? updated : state.viewing,
		}));
	},

	remove: async (id) => {
		await sessionsApi.delete(id);
		set((state) => ({
			sessions: state.sessions.filter((s) => s.id !== id),
			viewing: state.viewing?.id === id ? null : state.viewing,
		}));
	},

	view: (session) => set({ viewing: session }),
 accept: (session) => set(state => ({ sessions: state.sessions.some(existing => existing.id === session.id) ? state.sessions.map(existing => existing.id === session.id ? session : existing) : [session, ...state.sessions], viewing: state.viewing?.id === session.id ? session : state.viewing })),
}));
