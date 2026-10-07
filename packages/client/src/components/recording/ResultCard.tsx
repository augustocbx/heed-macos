import { tr, useLocale } from "@/lib/i18n.ts";
import { useState, useEffect } from "react";
import { useRecordingStore } from "@/stores/recording.ts";
import { useSessionsStore } from "@/stores/sessions.ts";
import { useTemplatesStore } from "@/stores/templates.ts";
import { useModelsStore } from "@/stores/models.ts";
import { useUIStore } from "@/stores/ui.ts";
import { generateNotes } from "@/api/notes.ts";
import { guardForSession } from "@/lib/acceptedSession";
import { recordingApi } from "@/api/recording";
import { applyRecordingSnapshot } from "@/lib/recordingSnapshot";
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
 const updateSession = useSessionsStore(state => state.update);
 const showToast = useUIStore((s) => s.showToast);
 const displayNames = savedSession?.transcriptFinalized ? {} : speakerNames;
 const displaySource = savedSession?.transcriptFinalized ? savedSession : { transcript, segments, speakers, embeddings };
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
			const text = displaySource.segments.map((s) => `${displayNames[s.speaker] || s.speaker}: ${s.text}`).join("\n");
			navigator.clipboard.writeText(text);
		}
		showToast(tr("Copied"));
	};

	const handleCopyPlain = () => {
		navigator.clipboard.writeText(displaySource.transcript);
		showToast(tr("Copied plain text"));
	};

	const handleGenerate = async (forceCpu = false) => {
		if (!savedSession?.transcript || generating || notesBusy || recordingBusy) return;
  if (savedSession.aiNotes && !window.confirm(tr(replacementPrompt))) return;
		setGenerating(true);
		setStreamingNotes("");
		setActiveTab("notes");
		try {
			const guard = guardForSession(savedSession);
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
						await updateSession(savedSession.id, { aiNotes: full, expectedNotes: savedSession.aiNotes || "", ...guard });
      const updated = useSessionsStore.getState().sessions.find(session => session.id === savedSession.id);
      if (updated && useRecordingStore.getState().currentSessionId === savedSession.id) setNotes(updated.aiNotes);
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
		}
	};

	const handleRename = async (original: string, newName: string) => {
  if (useRecordingStore.getState().finalSavePending) return;
		const previousName = useRecordingStore.getState().speakerNames[original];
		renameSpeaker(original, newName);
		const state = useRecordingStore.getState();
		if (!state.currentSessionId && state.coordinatorMeetingId) {
   try {
    const snapshot=await recordingApi.rename(state.coordinatorMeetingId,state.coordinatorRevision,{[original]:newName});
    applyRecordingSnapshot(snapshot);
   } catch {
    useRecordingStore.setState(latest=>({speakerNames:{...latest.speakerNames,[original]:previousName || original}}));
    showToast(tr("Could not save the speaker name. Please try again."));
   }
   return;
  }
		if (state.currentSessionId) {
			try {
				if (!savedSession || savedSession.id !== state.currentSessionId) throw new Error("The transcript source is unavailable. Refresh before saving.");
    await updateSession(state.currentSessionId, { ...applySpeakerNames(savedSession.segments, savedSession.speakers, savedSession.embeddings || {}, { [original]: newName }), ...guardForSession(savedSession) });
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
  const newSegments = displaySource.segments.map(segment => segment.speaker === from ? { ...segment, speaker: into } : segment);
  const newSpeakers = displaySource.speakers.filter(speaker => speaker !== from);
  const names = savedSession?.transcriptFinalized ? {} : { ...useRecordingStore.getState().speakerNames };
  delete names[from];
  try {
   if (currentSessionId) {
    if (!savedSession || savedSession.id !== currentSessionId) throw new Error("The transcript source is unavailable. Refresh before saving.");
    await updateSession(currentSessionId, { ...applySpeakerNames(newSegments, newSpeakers, displaySource.embeddings || {}, names), ...guardForSession(savedSession) });
   } else {
    useRecordingStore.setState({ segments: newSegments, speakers: newSpeakers, speakerNames: names });
   }
   showToast(tr("Merged"));
  } catch (error) { showToast(tr("Error: {message}", undefined, {message: tr((error as Error).message)})); }
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
					segments={displaySource.segments}
					speakers={displaySource.speakers}
					embeddings={displaySource.embeddings || {}}
					speakerNames={displayNames}
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
