import type { SetupCheckResult, InstallProgress } from "@heed/shared";
import { apiClient, buildUrl } from "./client.ts";

export const setupApi = {
	check: () => apiClient.get<SetupCheckResult>("/api/setup/check"),

	/** Start a locally-installed Ollama that isn't running. Resolves once the API is up (or times out). */
	startOllama: () =>
		apiClient.post<{ running: boolean; alreadyRunning?: boolean; error?: string }>("/api/setup/start-ollama"),

	/** SSE stream of `curl ... | sh` for ollama. Caller closes the EventSource. */
	installOllama: (onEvent: (e: InstallProgress) => void): EventSource => {
		const es = new EventSource(buildUrl("/api/setup/install-ollama"));
		es.onmessage = (msg) => {
			try {
				const data: InstallProgress = JSON.parse(msg.data);
				onEvent(data);
				if (data.status === "done" || data.status === "error") es.close();
			} catch {}
		};
		es.onerror = () => {
			onEvent({ status: "error", error: "Connection lost during install" });
			es.close();
		};
		return es;
	},

	/** SSE stream of `apt/dnf/pacman/brew install ffmpeg`. */
	installFfmpeg: (onEvent: (e: InstallProgress) => void): EventSource => {
		const es = new EventSource(buildUrl("/api/setup/install-ffmpeg"));
		es.onmessage = (msg) => {
			try {
				const data: InstallProgress = JSON.parse(msg.data);
				onEvent(data);
				if (data.status === "done" || data.status === "error") es.close();
			} catch {}
		};
		es.onerror = () => {
			onEvent({ status: "error", error: "Connection lost during install" });
			es.close();
		};
		return es;
	},
};
