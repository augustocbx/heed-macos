import { useEffect, useRef } from "react";
import { recordingApi } from "@/api/recording.ts";
import { createRecordingSession } from "@/lib/recordingSession.ts";
import { sessionsApi } from "@/api/sessions.ts";
import { notesApi } from "@/api/notes.ts";
import { useRecordingStore } from "@/stores/recording.ts";
import { useSessionsStore } from "@/stores/sessions.ts";
import { useUIStore } from "@/stores/ui.ts";
import { useHealthStore } from "@/stores/health.ts";
import { fmtDate } from "@/lib/format.ts";
import { resolveLanguage } from "@/lib/languages.ts";
import { subscribeLiveEvents } from "@/lib/liveEvents.ts";

// Always send a language the ACTIVE engine can transcribe (Parakeet has no auto-detect),
// resolved at send-time from the live health info — independent of UI render timing.
function effectiveLanguage(requested: string): string {
	return resolveLanguage(requested, useHealthStore.getState().health.languages);
}

interface UseRecordingOptions {
	micBars: React.RefObject<HTMLDivElement[] | null>;
	systemBars: React.RefObject<HTMLDivElement[] | null>;
	getLanguage: () => string;
}

const VIZ_BARS = 24;

export function useRecording({ micBars, systemBars, getLanguage }: UseRecordingOptions) {
	const store = useRecordingStore();
	const showToast = useUIStore((s) => s.showToast);
	const reloadSessions = useSessionsStore((s) => s.load);

	const tickInterval = useRef<number | null>(null);
	const micStreamRef = useRef<MediaStream | null>(null);
	const audioCtxRef = useRef<AudioContext | null>(null);
	const analyserRef = useRef<AnalyserNode | null>(null);
	const sysEventRef = useRef<EventSource | null>(null);
	const liveEventRef = useRef<EventSource | null>(null);
	const sysLevelsRef = useRef<number[]>(new Array(24).fill(0));
	const micCurrentRef = useRef<number[]>(new Array(VIZ_BARS).fill(0));
	const sysCurrentRef = useRef<number[]>(new Array(VIZ_BARS).fill(0));
	const animFrameRef = useRef<number | null>(null);

	const captureLanguage = useRef<string | null>(null);
 const recordingLanguage = () => captureLanguage.current || getLanguage();
 const start = async (language?:string) => {
  captureLanguage.current = language || getLanguage();
		try {
			const data = await recordingApi.start("both", effectiveLanguage(recordingLanguage()));
			// System audio (ScreenCaptureKit) needs Screen Recording permission. If it's not
			// granted yet, the server does NOT start recording — we ask the user to grant it and
			// press record again. The timer never starts until the permission is resolved.
			if ((data as { permissionNeeded?: boolean }).permissionNeeded) {
				showToast("Allow Screen Recording in the Settings window, then try recording again");
				return false;
			}
			if ((data as { error?: string }).error) {
				showToast((data as { error?: string }).error || "Failed to start");
				return false;
			}

			store.startRecording();

			tickInterval.current = window.setInterval(() => useRecordingStore.getState().tick(), 1000);

			// Mic stream for visualizer
			try {
				micStreamRef.current = await navigator.mediaDevices.getUserMedia({ audio: true });
				audioCtxRef.current = new AudioContext();
				analyserRef.current = audioCtxRef.current.createAnalyser();
				analyserRef.current.fftSize = 64;
				audioCtxRef.current.createMediaStreamSource(micStreamRef.current).connect(analyserRef.current);
			} catch {}

			// System levels via SSE
			sysLevelsRef.current = new Array(24).fill(0);
			sysEventRef.current = new EventSource("/api/sysrecord/levels");
			sysEventRef.current.onmessage = (e) => {
				try { sysLevelsRef.current = JSON.parse(e.data); } catch {}
			};

			// Live transcription via SSE — segments appear while recording. Short delay just to
			// let the recorder create the WAV; the heavy model warm-up is pre-loaded server-side.
			setTimeout(() => {
				if (!useRecordingStore.getState().recording) return;
				const liveLang = encodeURIComponent(effectiveLanguage(recordingLanguage()));
				liveEventRef.current = new EventSource(`/api/sysrecord/live?lang=${liveLang}`);
				// Typed live-transcription contract (@heed/shared). Each live MODE produces one event:
				//   segment = chunk mode (append, Whisper/CPU) · live = full mode (replace, Parakeet/MLX)
				//   turn = stream mode (karaoke, upsert by id) · quality = audio-quality hint (heed diff).
				subscribeLiveEvents(liveEventRef.current, {
					segment: (seg) => useRecordingStore.getState().appendSegment(seg),
					live: (seg) => useRecordingStore.getState().setLiveSegment(seg),
					turn: (turn) => useRecordingStore.getState().upsertLiveTurn(turn),
					quality: (q) => useRecordingStore.getState().setLiveQuality(q),
				});
				liveEventRef.current.onerror = () => {
					liveEventRef.current?.close();
					liveEventRef.current = null;
				};
			}, 300);

			startVisualizerLoop();
			return true;
		} catch (e) {
			showToast(`Error: ${(e as Error).message}`);
			return false;
		}
	};

	const startVisualizerLoop = () => {
		const tick = () => {
			if (!useRecordingStore.getState().recording) {
				micBars.current?.forEach((b) => { if (b) b.style.height = "2px"; });
				systemBars.current?.forEach((b) => { if (b) b.style.height = "2px"; });
				return;
			}

			// Mic levels (real, from browser AnalyserNode)
			let micLevels = new Array(VIZ_BARS).fill(0);
			if (analyserRef.current) {
				const freq = new Uint8Array(analyserRef.current.frequencyBinCount);
				analyserRef.current.getByteFrequencyData(freq);
				micLevels = Array.from(freq).slice(0, VIZ_BARS);
			}

			// System levels (from server SSE, already 24 bins)
			const sysLevels = sysLevelsRef.current;

			// Animate mic bars
			const micCurrent = micCurrentRef.current;
			for (let i = 0; i < VIZ_BARS; i++) {
				const target = micLevels[i] || 0;
				micCurrent[i] = target > micCurrent[i]
					? micCurrent[i] + (target - micCurrent[i]) * 0.5
					: micCurrent[i] + (target - micCurrent[i]) * 0.25;
				const bar = micBars.current?.[i];
				if (bar) bar.style.height = `${Math.max(2, micCurrent[i] / 3.5)}px`;
			}

			// Animate system bars
			const sysCurrent = sysCurrentRef.current;
			for (let i = 0; i < VIZ_BARS; i++) {
				const target = sysLevels[i] || 0;
				sysCurrent[i] = target > sysCurrent[i]
					? sysCurrent[i] + (target - sysCurrent[i]) * 0.5
					: sysCurrent[i] + (target - sysCurrent[i]) * 0.25;
				const bar = systemBars.current?.[i];
				if (bar) bar.style.height = `${Math.max(2, sysCurrent[i] / 3.5)}px`;
			}

			animFrameRef.current = requestAnimationFrame(tick);
		};
		tick();
	};

	const stop = async (language?:string) => {
  if (!captureLanguage.current) captureLanguage.current = language || getLanguage();
		if (tickInterval.current) {
			clearInterval(tickInterval.current);
			tickInterval.current = null;
		}

		// Stop visualizer + live transcription sources
		micStreamRef.current?.getTracks().forEach((t) => t.stop());
		micStreamRef.current = null;
		try { audioCtxRef.current?.close(); } catch {}
		audioCtxRef.current = null;
		analyserRef.current = null;
		sysEventRef.current?.close();
		sysEventRef.current = null;
		liveEventRef.current?.close();
		liveEventRef.current = null;
		if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);

		micBars.current?.forEach((b) => { if (b) b.style.height = "2px"; });
		systemBars.current?.forEach((b) => { if (b) b.style.height = "2px"; });
		micCurrentRef.current = new Array(VIZ_BARS).fill(0);
		sysCurrentRef.current = new Array(VIZ_BARS).fill(0);

		store.stopRecording();

		try {
			const { path, streaming, streamText, turns, embeddings, autoNamed } = await recordingApi.stop(effectiveLanguage(recordingLanguage()));
			await finalizeRecording(path, streaming, streamText, turns, embeddings, autoNamed);
   const result = useRecordingStore.getState();
   if (result.transcript.trim() && !result.currentSessionId) throw new Error("The transcript could not be saved. The audio remains available in recovery.");
			return true;
		} catch (e) {
			showToast(`Stop failed: ${(e as Error).message}`);
			useRecordingStore.setState({processing:false});
			return false;
		}
	};

	const finalizeRecording = async (
		audioPath: string,
		streaming?: boolean,
		streamText?: string,
		turns?: Array<{ id: number; speaker: string; channel: "mic" | "sys"; text: string; start?: number; end?: number; auto?: boolean }>,
		embeddings?: Record<string, number[]>,
		_autoNamed?: Record<string, { name: string; score: number }>,
	) => {
		const lang = effectiveLanguage(recordingLanguage());
		const seconds = useRecordingStore.getState().seconds;

		// AUTHORITATIVE stop: the server re-transcribed the whole recording via /finalize, so each
		// turn now carries REAL start/end timestamps + coherent segmentation + echo-free attribution.
		if (streaming && turns && turns.length) {
			const segments = turns.map((t) => ({ id: t.id, speaker: t.speaker, channel: t.channel, text: t.text, start: t.start ?? 0, end: t.end ?? 0, auto: t.auto }));
			const text = turns.map((t) => t.text).join("\n");
			const words = text.split(/\s+/).filter(Boolean);
			if (words.length === 0) {
				useRecordingStore.getState().reset();
				showToast("No speech detected in the recording — nothing to save");
				return;
			}
			const speakers = [...new Set(turns.map((t) => t.speaker))];
			const emb = embeddings || {};
			useRecordingStore.getState().setResult({
				success: true, text,
				files: { wav: audioPath, srt: "", txt: "" },
				metadata: { language: lang, model: "parakeet-stream" },
				speakers, segments, embeddings: emb, wordCount: words.length,
			});
			try {
				const created = await createRecordingSession({
					title: words.slice(0, 8).join(" ") + (words.length > 8 ? "..." : ""),
					createdAt: new Date().toISOString(), duration: seconds, language: lang,
					transcript: text, speakers, segments, embeddings: emb,
					files: { wav: audioPath, srt: "", txt: "" }, aiNotes: "", summary: "", tags: [], pinned: false,
				});
				useRecordingStore.getState().setSessionId(created.id);
				reloadSessions();
			} catch { /* keep the on-screen result even if persistence fails */ }
			return;
		}

		// Fallback seamless (streaming mic-only without turns): the streamed text IS the final.
		const isDual = audioPath.includes("dual-capture-");
		if (streaming && !isDual) {
			const text = (streamText || useRecordingStore.getState().transcript || "").trim();
			const words = text.split(/\s+/).filter(Boolean);
			if (words.length === 0) {
				useRecordingStore.getState().reset();
				showToast("No speech detected in the recording — nothing to save");
				return;
			}
			const seg = { speaker: "Me", start: 0, end: seconds, text, channel: "mic" as const };
			useRecordingStore.getState().setResult({
				success: true, text,
				files: { wav: audioPath, srt: "", txt: "" },
				metadata: { language: lang, model: "parakeet-stream" },
				speakers: ["Me"], segments: [seg], embeddings: {},
				wordCount: words.length,
			});
			try {
				const created = await createRecordingSession({
					title: words.slice(0, 8).join(" ") + (words.length > 8 ? "..." : ""),
					createdAt: new Date().toISOString(), duration: seconds, language: lang,
					transcript: text, speakers: ["Me"], segments: [seg], embeddings: {},
					files: { wav: audioPath, srt: "", txt: "" }, aiNotes: "", summary: "", tags: [], pinned: false,
				});
				useRecordingStore.getState().setSessionId(created.id);
				reloadSessions();
			} catch { /* keep the on-screen result even if persistence fails */ }
			return;
		}
		// DON'T clear live segments — they stay visible in Speakers.
		// We only need to: 1) transcribe remaining chunks, 2) run pyannote.
		useRecordingStore.getState().setProcessing("Finishing transcription...", 30);

		// Send live segments + WAV to the server. It transcribes the remaining
		// audio (what live missed) and runs pyannote for speaker reveal.
		const res = await fetch("/api/transcribe", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ url: audioPath, language: lang, diarize: true }),
		});

		if (!res.ok) throw new Error(`Finalize failed (HTTP ${res.status})`);
		if (!res.body) throw new Error("Finalize failed: missing transcript stream");

		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		let currentEvent = "";
  let finalized = false;
  let finalizeError: string | null = null;

		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";
			for (const line of lines) {
				if (line.startsWith("event: ")) {
					currentEvent = line.slice(7).trim();
				} else if (line.startsWith("data: ")) {
					try {
						const data = JSON.parse(line.slice(6));
						switch (currentEvent) {
							case "step":
								useRecordingStore.getState().setProcessing(data.message, useRecordingStore.getState().processProgress);
								break;
							case "segment":
								// Append NEW segments from the full processing
								// (these fill in what live missed)
								useRecordingStore.getState().appendSegment(data);
								break;
							case "speakers":
								// Pyannote finished — replace "???" with real names
								useRecordingStore.getState().revealSpeakers(
									data.speakers || [],
									data.segments || [],
									data.embeddings || {},
								);
								break;
							case "result": {
								useRecordingStore.getState().setResult(data);
								const words = (data.text || "").split(/\s+/).filter(Boolean);
								// Guard: don't persist a phantom session when nothing was captured
								// (no transcript and no segments) — tell the user instead of saving
								// an empty "Meeting ..." card.
								const hasSegs = Array.isArray(data.segments) && data.segments.length > 0;
								if (words.length === 0 && !hasSegs) {
									showToast("No speech detected in the recording — nothing to save");
         useRecordingStore.getState().reset();
         finalized = true;
									break;
								}
								const heuristicTitle = words.length > 0
									? words.slice(0, 8).join(" ") + (words.length > 8 ? "..." : "")
									: `Meeting ${fmtDate(new Date().toISOString())}`;

								const created = await createRecordingSession({
									title: heuristicTitle,
									createdAt: new Date().toISOString(),
									duration: seconds,
									language: lang,
									transcript: data.text,
									speakers: data.speakers || [],
									segments: data.segments || [],
									embeddings: data.embeddings || {},
									files: data.files,
									aiNotes: "",
									summary: "",
									tags: [],
									pinned: false,
								});
								useRecordingStore.getState().setSessionId(created.id);
        finalized = true;
								reloadSessions();
								if (data.text && data.text.length > 30) {
									notesApi.summaryLine(data.text)
										.then((d) => {
											if (d.summary) {
												sessionsApi.patch(created.id, {
													title: d.summary,
													summary: d.summary,
												}).then(() => reloadSessions());
											}
										})
										.catch(() => {});
								}
								break;
							}
							case "error":
								finalizeError = data.message || "Transcription failed";
								showToast(`Error: ${data.message}`);
								break;
						}
					} catch (e) { finalizeError = (e as Error).message; }
				}
			}
		}
  if (finalizeError) throw new Error(finalizeError);
  if (!finalized) throw new Error("Transcription ended without a final result. The audio is available in recovery.");
	};

	useEffect(() => {
		return () => {
			if (tickInterval.current) clearInterval(tickInterval.current);
			if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
			micStreamRef.current?.getTracks().forEach((t) => t.stop());
			try { audioCtxRef.current?.close(); } catch {}
			liveEventRef.current?.close();
			sysEventRef.current?.close();
		};
	}, []);

	return { start, stop };
}
