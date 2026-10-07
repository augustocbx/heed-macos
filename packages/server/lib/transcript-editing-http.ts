import type { CandidateInput, ReplaceInput, TranscriptCommand, TranscriptGuard } from "../../shared/types/transcript-editing";
import { TagError } from "./session-tags";
import { TranscriptEditingError } from "./transcript-editing";
import type { TranscriptService } from "./transcript-service";

const maxBodyBytes = 16_000_000;
function safeId(encoded: string): string {
 let id: string; try { id = decodeURIComponent(encoded); } catch { throw new TagError("Invalid meeting or candidate ID"); }
 if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(id)) throw new TagError("Invalid meeting or candidate ID");
 return id;
}
async function body(req: Request): Promise<Record<string, any>> {
 if (Number(req.headers.get("Content-Length")) > maxBodyBytes) throw new TranscriptEditingError("Transcript request exceeds the size limit", 413);
 const reader = req.body?.getReader(); if (!reader) throw new TagError("Invalid transcript request body");
 const chunks: Uint8Array[] = []; let bytes = 0;
 try {
  while (true) { const { value, done } = await reader.read(); if (done) break; bytes += value.byteLength; if (bytes > maxBodyBytes) { await reader.cancel(); throw new TranscriptEditingError("Transcript request exceeds the size limit", 413); } chunks.push(value); }
 } finally { reader.releaseLock(); }
 let parsed: unknown;
 try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes))); } catch { throw new TagError("Invalid transcript request body"); }
 if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new TagError("Invalid transcript request body");
 return parsed as Record<string, any>;
}
/** Called with the server's existing loopback/origin decision; parsing starts only after admission. */
export async function transcriptEditingResponse(req: Request, service: TranscriptService, allowed: boolean): Promise<Response | null> {
 const route = /^\/api\/sessions\/([^/]+)\/transcript\/(preview|commands|candidates)(?:\/([^/]+)\/(discard))?$/.exec(new URL(req.url).pathname);
 if (!route || (route[3] && route[2] !== "candidates")) return null;
 if (!allowed) return Response.json({ error: "Transcript request denied" }, { status: 403 });
 try {
  if (req.method !== "POST") throw new TagError("Transcript operations require POST");
  const id = safeId(route[1]!), candidateId = route[3] ? safeId(route[3]) : undefined, input = await body(req);
  const result = candidateId ? service.discard(id, candidateId, input.requestId) : route[2] === "preview" ? service.preview(id, input.input as ReplaceInput, input.guard as TranscriptGuard) : route[2] === "commands" ? service.command(id, input as TranscriptCommand) : service.stage(id, input as CandidateInput);
  return Response.json(result, { headers: { "Cache-Control": "no-store" } });
 } catch (error) {
  if (error instanceof TagError || error instanceof TranscriptEditingError) return Response.json({ error: error.message }, { status: error.status });
  // Storage failure is recoverable; never expose local paths or partial success.
  return Response.json({ error: "Could not save the transcript. Preserve your draft and try again." }, { status: 409 });
 }
}
