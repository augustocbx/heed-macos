import { LIVE_EVENT_NAMES, type LiveEvent } from "@heed/shared";

type LiveEventHandlers = {
	[K in LiveEvent["type"]]?: (data: Extract<LiveEvent, { type: K }>["data"]) => void;
};

/**
 * Subscribe to the typed live-transcription SSE contract on an EventSource. Replaces the
 * hand-repeated `addEventListener(name, e => { try { JSON.parse(e.data) } catch {} })` blocks
 * with one typed, exhaustive loop: the handler payloads are inferred from the discriminated
 * union in `@heed/shared`, so a renamed/removed event is a compile error here, not a silent
 * runtime no-op. Returns an unsubscribe fn that removes exactly the listeners it added.
 */
export function subscribeLiveEvents(es: EventSource, handlers: LiveEventHandlers): () => void {
	const added: Array<[string, EventListener]> = [];
	for (const name of LIVE_EVENT_NAMES) {
		const handler = handlers[name];
		if (!handler) continue;
		const listener: EventListener = (e) => {
			try {
				(handler as (d: unknown) => void)(JSON.parse((e as MessageEvent).data));
			} catch {
				/* malformed event payload — skip this event, keep the stream alive */
			}
		};
		es.addEventListener(name, listener);
		added.push([name, listener]);
	}
	return () => {
		for (const [name, listener] of added) es.removeEventListener(name, listener);
	};
}
