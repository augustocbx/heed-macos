import type { ModelsResponse, PullProgress } from "@heed/shared";
import { apiClient, buildUrl } from "./client.ts";

export const modelsApi = {
	list: () => apiClient.get<ModelsResponse>("/api/models"),
	select: (id: string, num_gpu?: number) =>
		apiClient.post<{ ok: boolean; model: string; num_gpu?: number }>(
			"/api/models/select",
			{ id, num_gpu },
		),
	/** SSE stream of `ollama pull <id>` progress. Caller is responsible for closing. */
	pullStream: (id: string, onEvent: (e: PullProgress) => void): EventSource => {
		const es = new EventSource(buildUrl(`/api/models/pull?id=${encodeURIComponent(id)}`));
		es.onmessage = (msg) => {
			try {
				const data: PullProgress = JSON.parse(msg.data);
				onEvent(data);
				if (data.done || data.error) es.close();
			} catch {}
		};
		es.onerror = () => {
			onEvent({ error: "Connection lost during pull" });
			es.close();
		};
		return es;
	},
};
