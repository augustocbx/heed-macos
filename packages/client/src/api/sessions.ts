import type { Session, SessionPatch } from "@heed/shared";
import { apiClient } from "./client.ts";

export const sessionsApi = {
	list: () => apiClient.get<Session[]>("/api/sessions"),
	create: (session: Partial<Session>) => apiClient.post<Session>("/api/sessions", session),
	patch: (id: string, patch: SessionPatch) =>
		apiClient.patch<Session>(`/api/sessions?id=${encodeURIComponent(id)}`, patch),
	delete: (id: string) => apiClient.delete<{ ok: boolean }>(`/api/sessions?id=${encodeURIComponent(id)}`),
};
