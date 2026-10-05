import type { Template } from "@heed/shared";
import { apiClient } from "./client.ts";

export const templatesApi = {
	list: () => apiClient.get<Template[]>("/api/templates"),
	save: (template: Partial<Template>) => apiClient.post<Template>("/api/templates", template),
	delete: (id: string) => apiClient.delete<{ ok: boolean }>(`/api/templates?id=${encodeURIComponent(id)}`),
};
