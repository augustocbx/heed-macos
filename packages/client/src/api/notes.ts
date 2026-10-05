import { buildUrl, apiClient } from "./client.ts";

export interface SummaryHandlers {
	onToken?: (token: string) => void;
	onDone?: (full: string) => void | Promise<void>;
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

 let complete = false;
 const consume = (line: string) => {
  if (!line.startsWith("data: ")) return;
  let data: { token?: unknown; done?: unknown; error?: unknown };
  try { data = JSON.parse(line.slice(6)); }
  catch { throw new Error("Notes generation returned a malformed stream."); }
  if (data.error) throw new Error(String(data.error));
  if (data.token !== undefined) {
   if (typeof data.token !== "string" || complete) throw new Error("Notes generation returned a malformed stream.");
   full += data.token; handlers.onToken?.(data.token);
  }
  if (data.done === true) complete = true;
 };
 try {
  while (true) {
   const { done, value } = await reader.read();
   if (done) break;
   buffer += decoder.decode(value, { stream: true });
   const lines = buffer.split("\n");
   buffer = lines.pop() || "";
   for (const line of lines) consume(line);
  }
  buffer += decoder.decode();
  if (buffer) consume(buffer);
  if (!complete || !full.trim()) throw new Error("Notes generation was incomplete. Please retry.");
  await handlers.onDone?.(full);
 } catch (error) {
  handlers.onError?.((error as Error).message);
  await reader.cancel().catch(() => {});
  throw error;
 } finally { reader.releaseLock(); }

	return full;
}

export const notesApi = {
	summaryLine: (transcript: string) =>
		apiClient.post<{ summary: string }>("/api/summary-line", { transcript }),
};
