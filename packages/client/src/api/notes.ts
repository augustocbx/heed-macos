import { buildUrl, apiClient } from "./client.ts";

export interface SummaryHandlers {
	onToken?: (token: string) => void;
	onDone?: (full: string) => void;
	onError?: (msg: string) => void;
}

/**
 * Streams AI notes generation token by token.
 */
export async function generateNotes(
	transcript: string,
	language: string,
	templateId: string | undefined,
	handlers: SummaryHandlers,
	force_cpu = false,
): Promise<string> {
	const res = await fetch(buildUrl("/api/summarize"), {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ transcript, language, templateId, force_cpu }),
	});
	if (!res.ok || !res.body) {
		// 409 = no notes model selected yet. Signal callers to open the model picker
		// instead of surfacing a raw error — the user picks a model, then retries.
		if (res.status === 409) {
			const e = new Error("needs-model-selection") as Error & { needsModelSelection?: boolean };
			e.needsModelSelection = true;
			throw e;
		}
		const msg = `Summarize failed: ${res.status}`;
		handlers.onError?.(msg);
		throw new Error(msg);
	}

	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let full = "";

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		const lines = buffer.split("\n");
		buffer = lines.pop() || "";
		for (const line of lines) {
			if (!line.startsWith("data: ")) continue;
			try {
				const data = JSON.parse(line.slice(6));
				if (data.token) {
					full += data.token;
					handlers.onToken?.(data.token);
				}
				if (data.done) handlers.onDone?.(full);
			} catch {}
		}
	}
	return full;
}

export const notesApi = {
	summaryLine: (transcript: string) =>
		apiClient.post<{ summary: string }>("/api/summary-line", { transcript }),
};
