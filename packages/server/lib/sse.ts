/**
 * One place for Server-Sent Events. The codebase had the same SSE boilerplate
 * (`new ReadableStream` + `TextEncoder` + `event:/data:` formatting + identical headers) copy-pasted
 * across 7+ endpoints. This collapses it to a single deep module (Ousterhout): a simple `sseResponse`
 * interface hiding the stream/encoder/heartbeat plumbing.
 *
 * Reliability rules baked in (from the streaming research):
 *  - errors travel IN-BAND as an `error` event — never throw after headers flush (that kills the
 *    process / leaves the client hanging),
 *  - anti-buffering headers + `X-Accel-Buffering: no` so proxies don't hold the stream,
 *  - optional heartbeat comment so a dead connection is detectable,
 *  - the producer is invoked with an `aborted` signal so it can stop work when the client leaves.
 */
export const SSE_HEADERS: Record<string, string> = {
	"Content-Type": "text/event-stream",
	"Cache-Control": "no-cache",
	Connection: "keep-alive",
	"X-Accel-Buffering": "no",
};

const encoder = new TextEncoder();

/** Encode a single SSE frame. `event` omitted → a default (unnamed) `data:` message. */
export function sseFrame(data: unknown, event?: string): Uint8Array {
	const prefix = event ? `event: ${event}\n` : "";
	return encoder.encode(`${prefix}data: ${JSON.stringify(data)}\n\n`);
}

export interface SseSink {
	/** Send a named event (`event: name\ndata: ...`). */
	send: (event: string, data: unknown) => void;
	/** Send an unnamed `data:` message (Ollama-style token streams). */
	data: (data: unknown) => void;
	/** Send a keep-alive comment line (ignored by EventSource, keeps the socket warm). */
	comment: (text?: string) => void;
	/** True once the client disconnected or the stream closed — stop producing. */
	readonly closed: boolean;
}

export interface SseOptions {
	/** Heartbeat interval in ms (comment frames). 0/undefined disables it. */
	heartbeatMs?: number;
	/** Extra response headers. */
	headers?: Record<string, string>;
}

/**
 * Build an SSE `Response`. The producer gets a sink and an `AbortSignal`; if it throws, the error
 * is delivered in-band as an `error` event and the stream closes cleanly (no post-flush throw).
 */
export function sseResponse(
	producer: (sink: SseSink, signal: AbortSignal) => void | Promise<void>,
	opts: SseOptions = {},
): Response {
	const controllerRef: { c: ReadableStreamDefaultController | null } = { c: null };
	const abort = new AbortController();
	let closed = false;
	let heartbeat: ReturnType<typeof setInterval> | null = null;

	const safeEnqueue = (bytes: Uint8Array) => {
		if (closed || !controllerRef.c) return;
		try {
			controllerRef.c.enqueue(bytes);
		} catch {
			closed = true; // controller already closed (client gone)
		}
	};

	const sink: SseSink = {
		send: (event, data) => safeEnqueue(sseFrame(data, event)),
		data: (data) => safeEnqueue(sseFrame(data)),
		comment: (text = "") => {
			if (closed || !controllerRef.c) return;
			try {
				controllerRef.c.enqueue(encoder.encode(`:${text}\n\n`));
			} catch {
				closed = true;
			}
		},
		get closed() {
			return closed;
		},
	};

	const stream = new ReadableStream({
		async start(controller) {
			controllerRef.c = controller;
			if (opts.heartbeatMs && opts.heartbeatMs > 0) {
				heartbeat = setInterval(() => sink.comment("hb"), opts.heartbeatMs);
			}
			try {
				await producer(sink, abort.signal);
			} catch (e) {
				sink.send("error", { message: e instanceof Error ? e.message : String(e) });
			} finally {
				if (heartbeat) clearInterval(heartbeat);
				if (!closed) {
					closed = true;
					try {
						controller.close();
					} catch {}
				}
			}
		},
		cancel() {
			// Client disconnected — signal the producer and stop.
			closed = true;
			if (heartbeat) clearInterval(heartbeat);
			abort.abort();
		},
	});

	return new Response(stream, { headers: { ...SSE_HEADERS, ...opts.headers } });
}
