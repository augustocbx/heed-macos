import type { VoicesListResponse } from "@heed/shared";
import { apiClient } from "./client.ts";

export const voicesApi = {
	list: () => apiClient.get<VoicesListResponse>("/api/voices"),
	save: (name: string, embedding: number[]) =>
		apiClient.post<{ ok: boolean; name: string; total: number }>("/api/voices/save", { name, embedding }),
	delete: (name: string) =>
		apiClient.post<{ ok: boolean }>("/api/voices/delete", { name }),
};

// The user's own (mic) channel label — a fixed name, not a voiceprint. Renaming the "Me" speaker
// stores it here so it persists as the default mic label across sessions.
export const userNameApi = {
	get: () => apiClient.get<{ name: string }>("/api/user-name"),
	set: (name: string) => apiClient.post<{ ok: boolean; name: string }>("/api/user-name", { name }),
};
