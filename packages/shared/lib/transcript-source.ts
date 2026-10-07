import { createHash } from "node:crypto";
import type { Session } from "../types/session.ts";

/** Keep serialization byte-identical to existing notes/chat/task source revisions. */
export function sourceRevision(session: Pick<Session, "transcript" | "language" | "speakers" | "segments">): string {
 return createHash("sha256").update(JSON.stringify({ transcript: session.transcript, language: session.language, speakers: session.speakers || [], segments: (session.segments || []).map(({ speaker, start, end, text, channel }) => ({ speaker, start, end, text, channel })) })).digest("hex");
}
