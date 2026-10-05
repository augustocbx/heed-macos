import { tr, useLocale } from "@/lib/i18n.ts";
import { useState, useEffect } from "react";
import { useRecordingStore } from "@/stores/recording.ts";
import { useSessionsStore } from "@/stores/sessions.ts";
import { useTemplatesStore } from "@/stores/templates.ts";
import { useModelsStore } from "@/stores/models.ts";
import { useUIStore } from "@/stores/ui.ts";
import { generateNotes } from "@/api/notes.ts";
import { sessionsApi } from "@/api/sessions.ts";
import { Tabs } from "@/components/shared/Tabs.tsx";
import { SpeakerView } from "@/components/speakers/SpeakerView.tsx";
import { NotesView } from "@/components/ai-notes/NotesView.tsx";
import { NotesJobStatus, automaticNotesBusy, replacementPrompt } from "@/components/ai-notes/NotesJobStatus";
import { NotesHardwareHint } from "@/components/ai-notes/NotesHardwareHint.tsx";
import { Spinner } from "@/components/shared/Spinner.tsx";
import { cpuFallbackWarning, estimateNotesSeconds } from "@/lib/format.ts";
import { applySpeakerNames } from "@/lib/speakerNames.ts";
import styles from "./ResultCard.module.css";

type Tab = "speakers" | "notes";

export function ResultCard() {
	useLocale();
	const {
		transcript, segments, speakers, embeddings, currentSessionId, notesText, setNotes, speakerNames, renameSpeaker,
	} = useRecordingStore();
	const savedSession = useSessionsStore(state => state.sessions.find(session => session.id === currentSessionId));
 const notesBusy = automaticNotesBusy(savedSession);
 const recordingBusy = useRecordingStore(state => state.recording || state.processing);
 const finalSavePending = useRecordingStore(state => state.finalSavePending);
 const acceptSession = useSessionsStore(state => state.accept);
 const showToast = useUIStore((s) => s.showToast);
	const reloadSessions = useSessionsStore((s) => s.load);
	const { templates, load: loadTemplates } = useTemplatesStore();
	const modelsData = useModelsStore((s) => s.data);
	const loadModels = useModelsStore((s) => s.load);
	const openPicker = useModelsStore((s) => s.openPicker);

	const [activeTab, setActiveTab] = useState<Tab>("speakers");
	const [generating, setGenerating] = useState(false);
	const [streamingNotes, setStreamingNotes] = useState("");
	const [templateId, setTemplateId] = useState<string>("general");

	// Load templates + models on mount (models needed for GPU runtime check)
	useEffect(() => { loadTemplates(); loadModels(); }, [loadTemplates, loadModels]);

	// Check if the current model fits in free VRAM right now
	const currentModel = modelsData?.models.find((m) => m.id === modelsData.current?.id);
	const fitsGpu = currentModel?.gpu_runtime_ok !== false; // true if ok or undefined (no data yet)

	const tabs = [
		{ id: "speakers", label: tr("Speakers") },
		{ id: "notes", label: tr("AI Notes") },
	];

	const handleCopy = () => {
		if (activeTab === "notes") {
			navigator.clipboard.writeText(savedSession?.aiNotes ?? notesText);
		} else {
			// Copy with speaker labels
			const text = segments.map((s) => `${speakerNames[s.speaker] || s.speaker}: ${s.text}`).join("\n");
			navigator.clipboard.writeText(text);
		}
		showToast(tr("Copied"));
	};

	const handleCopyPlain = () => {
		navigator.clipboard.writeText(transcript);
		showToast(tr("Copied plain text"));
	};

	const handleGenerate = async (forceCpu = false) => {
		if (!savedSession?.transcript || generating || notesBusy || recordingBusy) return;
  if (savedSession.aiNotes && !window.confirm(tr(replacementPrompt))) return;
		setGenerating(true);
		setStreamingNotes("");
		setActiveTab("notes");
		try {
			let acc = "";
			await generateNotes(
				savedSession.segments?.length ? savedSession.segments.map(segment => `${segment.speaker}: ${segment.text}`).join("\n") : savedSession.transcript,
				savedSession.language || useRecordingStore.getState().resultLanguage || "en",
				templateId,
				{
					onToken: (tok) => {
						acc += tok;
						setStreamingNotes(acc);
					},
					onDone: async (full) => {
						const updated = await sessionsApi.patch(savedSession.id, { aiNotes: full, expectedNotes: savedSession.aiNotes || "", expectedTranscriptRevision: savedSession.transcriptRevision });
      acceptSession(updated);
      if (useRecordingStore.getState().currentSessionId === savedSession.id) setNotes(updated.aiNotes);
      setStreamingNotes("");
					},
				},
				forceCpu,
			);
		} catch (e) {
			if ((e as { needsModelSelection?: boolean }).needsModelSelection) {
				showToast(tr("Choose a notes model before generating notes"));
				openPicker();
			} else {
				showToast(tr("Error: {message}", undefined, {message:tr((e as Error).message)}));
			}
		} finally {
			setGenerating(false);
   setStreamingNotes("");
		}
	};

	const handleRename = async (original: string, newName: string) => {
  if (useRecordingStore.getState().finalSavePending) return;
		const previousName = useRecordingStore.getState().speakerNames[original];
		renameSpeaker(original, newName);
		const state = useRecordingStore.getState();
		if (state.currentSessionId) {
			try {
				await sessionsApi.patch(state.currentSessionId, applySpeakerNames(state.segments, state.speakers, state.embeddings, state.speakerNames));
				await reloadSessions();
			} catch {
				useRecordingStore.setState((latest) => {
					if (latest.speakerNames[original] !== newName) return {};
					const names = { ...latest.speakerNames };
					if (previousName) names[original] = previousName;
					else delete names[original];
					return { speakerNames: names };
				});
				showToast(tr("Could not save the speaker name. Please try again."));
			}
		}
	};

	const handleMerge = async (from: string, into: string) => {
  if (useRecordingStore.getState().finalSavePending) return;
		const newSegments = segments.map((s) =>
			s.speaker === from ? { ...s, speaker: into } : s,
		);
		const newSpeakers = speakers.filter((s) => s !== from);
		// Update store via direct update
		useRecordingStore.setState({ segments: newSegments, speakers: newSpeakers });
		useRecordingStore.setState((state) => {
			const prev = state.speakerNames;
			const copy = { ...prev };
			delete copy[from];
			return { speakerNames: copy };
		});
		if (currentSessionId) {
			await sessionsApi.patch(currentSessionId, applySpeakerNames(newSegments, newSpeakers, embeddings, useRecordingStore.getState().speakerNames));
			reloadSessions();
		}
		showToast(tr("Merged"));
	};

	const displayNotes = streamingNotes || (savedSession?.aiNotes ?? notesText);
	const isStreaming = !!streamingNotes && generating;

	return (
		<div className={styles.card}>
			{savedSession && <NotesJobStatus session={savedSession} />}
   <Tabs tabs={tabs} active={activeTab} onChange={(id) => setActiveTab(id as Tab)} />

			{activeTab === "speakers" && (
				<SpeakerView
     editingDisabled={finalSavePending}
					segments={segments}
					speakers={speakers}
					embeddings={embeddings}
					speakerNames={speakerNames}
					onRename={handleRename}
					onMerge={handleMerge}
				/>
			)}

			{activeTab === "notes" && (
				<NotesView
					notes={displayNotes}
					streaming={isStreaming}
					placeholder={tr("Click \"Generate AI notes\" below")}
				/>
			)}

			{activeTab === "notes" && fitsGpu && !generating && (
				<NotesHardwareHint model={currentModel} modelsData={modelsData} fitsGpu={fitsGpu} />
			)}

			{activeTab === "notes" && !fitsGpu && !generating && (
				<div className={styles.gpuWarn}>
					<span className={styles.gpuWarnText}>
						{cpuFallbackWarning(currentModel?.name, modelsData?.gpu_name)}
					</span>
				</div>
			)}

			<div className={styles.actions}>
				<button className={styles.btn} onClick={handleCopy}>{tr("Copy")}</button>
				{activeTab === "speakers" && (
					<button className={styles.btn} onClick={handleCopyPlain}>{tr("Copy plain text")}</button>
				)}
				{activeTab === "notes" && (
					<>
						<select
							className={styles.templateSelect}
							value={templateId}
							onChange={(e) => setTemplateId(e.target.value)}
						>
							{templates.map((t) => (
								<option key={t.id} value={t.id}>{tr(t.name)}</option>
							))}
						</select>
						{fitsGpu ? (
							<button className={styles.btn} onClick={() => handleGenerate(false)} disabled={generating || notesBusy || recordingBusy || !savedSession}>
								{generating ? <><Spinner />{tr("Generating…")}</> : tr("Generate AI notes · ~{seconds}s", undefined, {seconds: estimateNotesSeconds(currentModel?.vram_mb, true)})}
							</button>
						) : (
							<button className={styles.btnCpu} onClick={() => handleGenerate(true)} disabled={generating || notesBusy || recordingBusy || !savedSession}>
								{generating ? <><Spinner />{tr("Generating on CPU…")}</> : tr("Generate on CPU · ~{seconds}s", undefined, {seconds:estimateNotesSeconds(currentModel?.vram_mb, false)})}
							</button>
						)}
					</>
				)}
			</div>
		</div>
	);
}
