import { useEffect, useRef, useState } from "react";
import { useRecordingStore } from "@/stores/recording.ts";

interface DetectorEvent {
	event: "meeting_started" | "meeting_ended";
	app: string;
}

export interface DetectedMeeting {
	app: string;
}

/**
 * Subscribes to /api/meeting-detector SSE.
 * Returns the currently detected (and not dismissed) app, or null.
 */
export function useMeetingDetector() {
	const [detected, setDetected] = useState<DetectedMeeting | null>(null);
	const dismissedRef = useRef<Set<string>>(new Set());
	const evtRef = useRef<EventSource | null>(null);

	useEffect(() => {
		const connect = () => {
			try {
				const evt = new EventSource("/api/meeting-detector");
				evtRef.current = evt;
				evt.onmessage = (e) => {
					try {
						const data = JSON.parse(e.data) as DetectorEvent;
						if (data.event === "meeting_started") {
							if (dismissedRef.current.has(data.app)) return;
							if (useRecordingStore.getState().recording) return;
							setDetected({ app: data.app });
						} else if (data.event === "meeting_ended") {
							setDetected((d) => (d?.app === data.app ? null : d));
							dismissedRef.current.delete(data.app);
						}
					} catch {}
				};
				evt.onerror = () => {
					evt.close();
					evtRef.current = null;
					setTimeout(connect, 5000);
				};
			} catch {}
		};
		connect();
		return () => { evtRef.current?.close(); };
	}, []);

	const dismiss = () => {
		if (detected) dismissedRef.current.add(detected.app);
		setDetected(null);
	};
	const clear = () => setDetected(null);

	return { detected, dismiss, clear };
}
