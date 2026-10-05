import { tr, useLocale } from "@/lib/i18n.ts";
import { useRef, useEffect, useState } from "react";
import { useDesktopControl } from "@/hooks/useDesktopControl.ts";
import { useRecording } from "@/hooks/useRecording.ts";
import { useRecordingStore } from "@/stores/recording.ts";
import {
	useIsRecording, useIsProcessing, useProcessStep, useSegments,
	useTranscript, useLiveQuality, useCurrentSessionId, useSeconds,
} from "@/stores/selectors.ts";
import { RecordButton } from "./RecordButton.tsx";
import { Timer } from "./Timer.tsx";
import { Visualizer } from "./Visualizer.tsx";
import vizStyles from "./Visualizer.module.css";
import { ResultCard } from "./ResultCard.tsx";
import { ErrorBoundary } from "@/components/ErrorBoundary.tsx";
import styles from "./RecordPage.module.css";

const FAST_PROCESS_MESSAGES_EN = [
	"Transcribing mic...",
	"Transcribing sys...",
	"Identifying speakers...",
	"Aligning speaker timeline...",
	"Merging segments...",
	"It's almost ready!",
];

export function RecordPage() {
	useLocale();
	const micBars = useRef<HTMLDivElement[]>([]);
	const systemBars = useRef<HTMLDivElement[]>([]);
	const [language, setLanguage] = useState("en");

	const { start, stop } = useRecording({
		micBars,
		systemBars,
		getLanguage: () => language,
	});

	useDesktopControl({start,stop}, setLanguage);

	// Atomic selectors (stores/selectors.ts): subscribe to the narrowest slices instead of the whole
	// store, so RecordPage doesn't re-render on every unrelated store write (e.g. live segment ticks).
	const recording = useIsRecording();
	const processing = useIsProcessing();
	const processStep = useProcessStep();
	const segments = useSegments();
	const transcript = useTranscript();
	const liveQuality = useLiveQuality();
	const currentSessionId = useCurrentSessionId();
	// Show result card when recording (live preview) or after stop (final result)
	const showResult = recording || processing || segments.length > 0 || !!transcript;
	// Block recording button while processing (transcribing + diarizing after stop)
	const canRecord = !recording && !processing;
	const [rotatingStep, setRotatingStep] = useState("");
	const [rotatingStepKey, setRotatingStepKey] = useState(0);

	// Listen for meeting detector trigger
	useEffect(() => {
		const handler = () => {
			if (!useRecordingStore.getState().recording && !useRecordingStore.getState().processing) start();
		};
		window.addEventListener("heed:start-recording", handler);
		return () => window.removeEventListener("heed:start-recording", handler);
	}, [start]);

	useEffect(() => {
		if (!processing) {
			setRotatingStep("");
			return;
		}

		const liveStep = (processStep || "").trim();
		const poolRaw = [liveStep, ...FAST_PROCESS_MESSAGES_EN].filter(Boolean);
		const uniquePool = Array.from(new Map(poolRaw.map((msg) => [msg.toLowerCase(), msg])).values());

		const updateMessage = (msg: string) => {
			setRotatingStep(msg);
			setRotatingStepKey((k) => k + 1);
		};

		let idx = 0;
		updateMessage(uniquePool[0] || tr("It's almost ready!"));

		const id = window.setInterval(() => {
			if (!uniquePool.length) return;
			idx = (idx + 1) % uniquePool.length;
			updateMessage(uniquePool[idx]);
		}, 2000);

		return () => clearInterval(id);
	}, [processing, processStep]);

	return (
		<div>
			<div className={styles.center}>
				<Timer seconds={useSeconds()} />
				<div className={vizStyles.dualWrap}>
					<Visualizer ref={micBars} barCount={24} variant="mic" label={tr("Microphone")} />
					<Visualizer ref={systemBars} barCount={24} variant="system" label={tr("System")} />
				</div>
				{processing ? (
					<div className={styles.processingStatus}>
						<div className={styles.processingDot} />
						<span key={rotatingStepKey} className={styles.processingText}>
							{tr(rotatingStep || processStep || "Finalizing...")}
						</span>
					</div>
				) : (
					<RecordButton recording={recording} onClick={() => (recording ? stop() : canRecord ? start() : null)} />
				)}
				<div className={styles.label}>
					{recording ? tr("Recording... click to stop") : processing ? "" : !showResult ? tr("Click to start recording") : ""}
				</div>
				{recording && liveQuality && !liveQuality.ok && (
					<div className={styles.qualityWarn} role="status">
						<span className={styles.qualityWarnIcon} aria-hidden="true">!</span>
						<span>{tr(liveQuality.hint || "")}</span>
					</div>
				)}
				{!processing && (
					<div className={styles.options}>
						<span>{tr("Live preview starts in English. The final transcript automatically detects English or Portuguese.")}</span>
					</div>
				)}
			</div>

			{/* Transcript view is isolated: a render crash here must never take down the page or the
			    record/stop controls above. Auto-recovers when a new session loads (resetKeys). */}
			{showResult && (
				<ErrorBoundary resetKeys={[currentSessionId]}>
					<ResultCard />
				</ErrorBoundary>
			)}
		</div>
	);
}
