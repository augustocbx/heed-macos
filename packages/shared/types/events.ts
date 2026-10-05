import type { Segment } from "./speaker.ts";

/**
 * The live-transcription SSE contract (server `/api/sysrecord/live` → client EventSource).
 *
 * Today the event shapes are implicit JSON parsed with `JSON.parse(e.data)` and no validation —
 * a renamed field on the Python/server side fails silently at runtime. Modeling them as a
 * DISCRIMINATED UNION (Wlaschin, "make illegal states unrepresentable"; totaltypescript on unions)
 * turns a contract drift into a COMPILE error and lets the consumer `switch` exhaustively.
 *
 * The discriminant is the SSE event *name* (the string passed to `addEventListener`). Each variant
 * documents which live MODE produces it:
 *   - "segment" : chunk mode  (Whisper/CPU)      → append a finished chunk
 *   - "live"    : full  mode  (Parakeet/MLX)     → replace the single live segment per channel
 *   - "turn"    : stream mode (karaoke)          → upsert a chronological turn by id
 *   - "quality" : audio-quality hint (any mode)  → heed differentiator (too quiet / echoey)
 *   - "error"   : in-band failure (NEVER thrown after SSE headers flush — travels as data)
 *   - "heartbeat": keep-alive so the client can detect a dead stream
 *   - "stopped" : the server finished/closed the stream cleanly
 */
export type LiveEventName = "segment" | "live" | "turn" | "quality" | "error" | "heartbeat" | "stopped";

/** A chronological karaoke turn (stream mode). `id` identifies a contiguous speaker turn. */
export interface LiveTurn {
	id: number;
	speaker: string;
	channel?: "mic" | "sys";
	text: string;
	/** True when this speaker was auto-recognized from a saved voice (cross-session). */
	auto?: boolean;
}

/** Audio-quality assessment surfaced live (heed differentiator). `ok:false` carries a `hint`. */
export interface LiveQuality {
	ok: boolean;
	hint?: string;
}

export type LiveEvent =
	| { type: "segment"; data: Segment }
	| { type: "live"; data: Segment }
	| { type: "turn"; data: LiveTurn }
	| { type: "quality"; data: LiveQuality }
	| { type: "error"; data: { message: string } }
	| { type: "heartbeat"; data: { t: number } }
	| { type: "stopped"; data: Record<string, never> };

/** Map an event name to its payload type — lets a typed listener stay exhaustive. */
export type LiveEventPayload<N extends LiveEventName> = Extract<LiveEvent, { type: N }>["data"];

/** All live event names, as a runtime array (single source of truth for wiring listeners). */
export const LIVE_EVENT_NAMES: readonly LiveEventName[] = [
	"segment",
	"live",
	"turn",
	"quality",
	"error",
	"heartbeat",
	"stopped",
] as const;
