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
import {MeetingModeSelect} from "./MeetingModeSelect";
import { RecordingRecovery } from "./RecordingRecovery";
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

	const { start, stop, recordFinalOnly, liveStartError, starting } = useRecording({
		micBars,
		systemBars,
	});

	useDesktopControl();

	// Atomic selectors (stores/selectors.ts): subscribe to the narrowest slices instead of the whole
	// store, so RecordPage doesn't re-render on every unrelated store write (e.g. live segment ticks).
	const recording = useIsRecording();
 const realTimeTranscription=useRecordingStore(s=>s.realTimeTranscription);
	const processing = useIsProcessing();
	const processStep = useProcessStep();
	const segments = useSegments();
	const transcript = useTranscript();
	const liveQuality = useLiveQuality();
	const currentSessionId = useCurrentSessionId();
	// Show result card when recording (live preview) or after stop (final result)
	const showResult = (recording && realTimeTranscription) || processing || segments.length > 0 || !!transcript;
	// Block recording button while processing (transcribing + diarizing after stop)
	const canRecord = !recording && !processing && !starting;
 const liveOptions=useRecordingStore(s=>s.liveOptions);
 const liveLanguage=useRecordingStore(s=>s.liveSpeechLanguage);
 const liveModel=useRecordingStore(s=>s.liveModel);
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
			<RecordingRecovery />
			<div className={styles.center}>
				<Timer seconds={useSeconds()} />
                <MeetingModeSelect/>
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
                {liveStartError && !recording && !processing && <div role="alert">
                  <p>{tr(liveStartError==='live-language-unsupported' ? 'The live model does not support this language. Choose a compatible model or record final-only.' : 'Live language capabilities are unavailable. Retry when the service is ready or record final-only.')}</p>
                  <button disabled={starting} onClick={()=>void recordFinalOnly()}>{tr('Record final-only (keeps real-time off)')}</button>
                  <p>{tr('Recording final-only turns real-time transcription off for future recordings. Turn it back on in Settings.')}</p>
                </div>}
				{recording && liveQuality && !liveQuality.ok && (
					<div className={styles.qualityWarn} role="status">
						<span className={styles.qualityWarnIcon} aria-hidden="true">!</span>
						<span>{tr(liveQuality.hint || "")}</span>
					</div>
				)}
				{!processing && (
					<div className={styles.options}>
                        {recording && realTimeTranscription && <p role="status">{tr('Provisional live text: {language} • {engine} / {model}',undefined,{language:tr(liveLanguage==='pt'?'Brazilian Portuguese':'English'),engine:liveOptions?.engine || tr('Unknown'),model:liveModel || tr('Unknown')})}{liveOptions?.initialModel && liveModel!==liveOptions.initialModel && ' ('+tr('Initial model: {model}',undefined,{model:liveOptions.initialModel})+')'}</p>}
						<span role={recording && !realTimeTranscription ? "status" : undefined}>{tr(recording && !realTimeTranscription ? "Live text is disabled. Audio is being recorded; the transcript and speakers will be prepared after stopping." : "Live speech language is configured in Settings. The final transcript automatically detects English or Portuguese.")}</span>
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
