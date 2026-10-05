import type { Segment } from "./speaker.ts";

/**
 * The recording lifecycle, as an explicit state machine (discriminated union) instead of the
 * current soup of independent booleans (`recording`, `processing`, `seconds`, `liveQuality`).
 *
 * Today an illegal combination like `recording && processing` is *constructible* and the code has
 * to defend against it everywhere. Modeling the lifecycle as a union makes illegal states
 * UNREPRESENTABLE (Wlaschin) and lets the UI render off a single `status` with `assertNever`
 * exhaustiveness — adding a state becomes a compile error at every switch, not a runtime surprise.
 *
 * Linear by design (a *line*, not a chart — so we hand-roll it; XState would be over-engineering
 * for ~5 states, per the streaming/state-machine research). Transitions:
 *   idle → recording → processing → done
 *                    ↘ (any) ↘ error → idle
 */
export type RecordingStatus = "idle" | "recording" | "processing" | "done" | "error";

export type RecordingPhase =
	| { status: "idle" }
	| { status: "recording"; seconds: number; liveQuality: { ok: boolean; hint?: string } | null }
	| { status: "processing"; step: string; progress: number }
	| { status: "done"; sessionId: string | null }
	| { status: "error"; message: string };

/** Result payload carried alongside a finished recording (kept separate from the phase). */
export interface RecordingResult {
	transcript: string;
	segments: Segment[];
	speakers: string[];
	embeddings: Record<string, number[]>;
}

/**
 * Exhaustiveness helper. Call in the `default` branch of a switch over a union's discriminant:
 * if a new variant is added and not handled, this fails to type-check. (Standard TS idiom; see
 * totaltypescript "discriminated unions".) At runtime it throws — a defined error, not silent drift.
 */
export function assertNever(x: never, context = "value"): never {
	throw new Error(`Unexpected ${context}: ${JSON.stringify(x)}`);
}
