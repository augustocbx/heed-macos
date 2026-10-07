import { createHash } from "node:crypto";
import type { TranscriptSourceIdentity } from "../types/transcript-editing.ts";
import type { Session } from "../types/session.ts";

/** Keep serialization byte-identical to existing notes/chat/task source revisions. */
export function sourceRevision(session: Pick<Session, "transcript" | "language" | "speakers" | "segments">): string {
 return createHash("sha256").update(JSON.stringify({ transcript: session.transcript, language: session.language, speakers: session.speakers || [], segments: (session.segments || []).map(({ speaker, start, end, text, channel }) => ({ speaker, start, end, text, channel })) })).digest("hex");
}

/** Capture actual speaker/language/timing identity for later text-journal verification. */
export function transcriptSourceIdentity(session: Pick<Session, "language" | "speakers" | "segments">): TranscriptSourceIdentity {
 return {language:session.language,speakers:[...(session.speakers||[])],segments:(session.segments||[]).map(({speaker,start,end,channel})=>({speaker,start,end,...(channel!==undefined?{channel}:{})}))};
}
