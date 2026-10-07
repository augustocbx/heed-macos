import { TasksPanel } from "@/components/tasks/TasksPanel";
import { MeetingChat } from "@/components/chat/MeetingChat";
import { tr, useLocale } from "@/lib/i18n.ts";
import { useState, useEffect, useRef } from "react";
import type { Session, TranscriptEvidence } from "@heed/shared";
import { useSessionsStore } from "@/stores/sessions.ts";
import { useTemplatesStore } from "@/stores/templates.ts";
import { useModelsStore } from "@/stores/models.ts";
import { useUIStore } from "@/stores/ui.ts";
import { generateNotes } from "@/api/notes.ts";
import { fmtDate, fmtDuration, cpuFallbackWarning, estimateNotesSeconds } from "@/lib/format.ts";
import { Tabs } from "@/components/shared/Tabs.tsx";
import { SpeakerView } from "@/components/speakers/SpeakerView.tsx";
import { NotesView } from "@/components/ai-notes/NotesView.tsx";
import { NotesJobStatus, automaticNotesBusy, replacementPrompt } from "@/components/ai-notes/NotesJobStatus";
import { NotesHardwareHint } from "@/components/ai-notes/NotesHardwareHint.tsx";
import { Spinner } from "@/components/shared/Spinner.tsx";
import { TagEditor } from "./TagEditor";
import { TitleInput } from "./TitleInput.tsx";
import { SessionAudioPlayer } from "./SessionAudioPlayer.tsx";
import { applySpeakerNames } from "@/lib/speakerNames.ts";
import { RetranscribeDialog } from "./RetranscribeDialog";
import { useRecordingStore } from "@/stores/recording";
import { sessionLanguageLabel, sessionModelLabels } from "@/lib/sessionMetadata";
import styles from "./SessionDetail.module.css";

interface Props {
	session: Session;
	onBack: () => void;
  onTagClick?: (tag: string) => void;
}

type TabId = "speakers" | "notes" | "tasks" | "chat";

export function SessionDetail({ session, onBack, onTagClick }: Props) {
 const notesBusy = automaticNotesBusy(session);
	useLocale();
	const [showTranscribe,setShowTranscribe] = useState(false);
 const [transcribing,setTranscribing] = useState(false);
 const recordingBusy = useRecordingStore(s=>s.recording || s.processing);
 const update = useSessionsStore((s) => s.update);
	const showToast = useUIStore((s) => s.showToast);
	const { templates, load: loadTemplates } = useTemplatesStore();
	const modelsData = useModelsStore((s) => s.data);
	const loadModels = useModelsStore((s) => s.load);
	const openPicker = useModelsStore((s) => s.openPicker);

	const [activeTab, setActiveTab] = useState<TabId>("speakers");
	const [templateId, setTemplateId] = useState<string>("general");
	const [generating, setGenerating] = useState(false);
	const [streamingNotes, setStreamingNotes] = useState("");
	const [speakerNames, setSpeakerNames] = useState<Record<string, string>>({});
 const audioRef = useRef<HTMLAudioElement>(null);
 const [focusedSource,setFocusedSource]=useState<{segmentIndex:number|null;paragraphIndex:number|null}|null>(null);
 const cancelSourceSeek=()=>{if(useUIStore.getState().taskSourceSeek?.sessionId===session.id)useUIStore.setState({taskSourceSeek:null});};
 const sourceSeekGeneration=useRef(0);
 useEffect(()=>{
  const generation=++sourceSeekGeneration.current,pending=useUIStore.getState().taskSourceSeek;
  if(pending&&(pending.sessionId!==session.id||(pending.sourceRevision&&pending.sourceRevision!==session.transcriptRevision)))useUIStore.setState({taskSourceSeek:null});
  if(!session.files?.wav)cancelSourceSeek();
  // StrictMode replays setup after cleanup; only a real departure cancels the pending request.
  return ()=>{const pending=useUIStore.getState().taskSourceSeek;queueMicrotask(()=>{if(sourceSeekGeneration.current===generation&&useUIStore.getState().taskSourceSeek===pending)cancelSourceSeek();});};
 },[session.id,session.transcriptRevision,session.files?.wav]);
 const textRef=useRef<HTMLDivElement>(null);
 useEffect(()=>{setFocusedSource(null);},[session.id,session.transcriptRevision]);
 useEffect(()=>{if(activeTab==="speakers")textRef.current?.querySelector<HTMLElement>('[aria-current="true"]')?.scrollIntoView?.({block:"center"});},[activeTab,focusedSource]);
 const [playbackTime,setPlaybackTime] = useState<number|null>(null);
 const [audioDuration,setAudioDuration] = useState<number|null>(null);
 useEffect(()=>{setPlaybackTime(null);setAudioDuration(null);setSpeakerNames({});},[session.id]);
 const seekAudio = (seconds:number) => {
  const audio=audioRef.current;
  if(!audio || audio.error || !Number.isFinite(seconds) || seconds<0)return;
  if(Number.isFinite(audio.duration)&&seconds>=audio.duration) {
   showToast(tr("This segment is outside the available audio duration."));return;
  }
  cancelSourceSeek();
  audio.currentTime=seconds;
  setPlaybackTime(seconds);
  void audio.play().catch(()=>showToast(tr("Click Play to start audio playback.")));
 };

	useEffect(() => { loadTemplates(); loadModels(); }, [loadTemplates, loadModels]);

	const currentModel = modelsData?.models.find((m) => m.id === modelsData.current?.id);
	const fitsGpu = currentModel?.gpu_runtime_ok !== false;

	const openCitation=(citation:TranscriptEvidence)=>{
  if(citation.sessionId!==session.id||citation.sourceRevision!==session.transcriptRevision){showToast(tr("The transcript changed. Refresh before asking or retrying."));return;}
  setFocusedSource({segmentIndex:citation.segmentIndex,paragraphIndex:citation.paragraphIndex});setActiveTab("speakers");
  if(session.files?.wav&&citation.start!==null)seekAudio(citation.start);
 };

 const meta = [
		fmtDate(session.createdAt),
		(audioDuration ?? session.duration) ? fmtDuration(Math.floor(audioDuration ?? session.duration)) : null,
		session.language ? sessionLanguageLabel(session.language) : null,
  sessionModelLabels(session) || null,
		session.speakers?.length ? tr(session.speakers.length===1 ? "{count} speaker" : "{count} speakers", undefined, {count:session.speakers.length}) : null,
	].filter(Boolean).join(" · ");

	const tabs = [
		{ id: "speakers", label: tr("Speakers") },
		{ id: "notes", label: tr("AI Notes") },
  { id:"tasks",label:tr("Tasks") },
  { id: "chat", label: tr("Chat") },
	];


	const handleCopy = () => {
		if (activeTab === "notes") {
			navigator.clipboard.writeText(session.aiNotes || "");
		} else if (session.segments) {
			const text = session.segments.map((s) => `${speakerNames[s.speaker] || s.speaker}: ${s.text}`).join("\n");
			navigator.clipboard.writeText(text);
		}
		showToast(tr("Copied"));
	};

	const handleCopyPlain = () => {
		navigator.clipboard.writeText(session.transcript || "");
		showToast(tr("Copied plain text"));
	};

	const handleGenerate = async (forceCpu = false) => {
		if (!session.transcript || generating || notesBusy || recordingBusy || transcribing) return;
  if (session.aiNotes && !window.confirm(tr(replacementPrompt))) return;
		setGenerating(true);
		setStreamingNotes("");
		setActiveTab("notes");
		try {
			let acc = "";
			await generateNotes(
				session.segments?.length ? session.segments.map(segment => `${segment.speaker}: ${segment.text}`).join("\n") : session.transcript,
				session.language || "en",
				templateId,
				{
					onToken: (tok) => { acc += tok; setStreamingNotes(acc); },
					onDone: async (full) => {
						await update(session.id, { aiNotes: full, expectedNotes: session.aiNotes || "", expectedTranscriptRevision: session.transcriptRevision });
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

	const handleSpeakerRename = async (original: string, newName: string) => {
		const names = { ...speakerNames, [original]: newName };
		setSpeakerNames(names);
		try {
			await update(session.id, applySpeakerNames(session.segments || [], session.speakers || [], session.embeddings || {}, names));
		} catch {
			setSpeakerNames((latest) => {
				if (latest[original] !== newName) return latest;
				const restored = { ...latest };
				if (speakerNames[original]) restored[original] = speakerNames[original];
				else delete restored[original];
				return restored;
			});
			showToast(tr("Could not save the speaker name. Please try again."));
		}
	};

	const handleSpeakerMerge = async (from: string, into: string) => {
		const newSegments = (session.segments || []).map((s) =>
			s.speaker === from ? { ...s, speaker: into } : s,
		);
		const newSpeakers = (session.speakers || []).filter((s) => s !== from);
		await update(session.id, { segments: newSegments, speakers: newSpeakers });
		showToast(tr("Merged"));
	};

	const displayNotes = streamingNotes || session.aiNotes || "";
 useEffect(()=>{
  const citation=useUIStore.getState().chatSourceFocus;
  if(!citation||citation.sessionId!==session.id)return;
  useUIStore.setState({chatSourceFocus:null});
  if(citation.sourceRevision!==session.transcriptRevision){showToast(tr("The transcript changed. Refresh before asking or retrying."));return;}
  setFocusedSource({segmentIndex:citation.segmentIndex,paragraphIndex:citation.paragraphIndex});setActiveTab("speakers");
  if(session.files?.wav&&citation.start!==null){
   if((audioRef.current?.readyState||0)>=1){cancelSourceSeek();seekAudio(citation.start);}
   else useUIStore.setState({taskSourceSeek:{sessionId:session.id,seconds:citation.start,sourceRevision:citation.sourceRevision}});
  }
 },[session.id,session.transcriptRevision]);

	const isStreaming = !!streamingNotes && generating;

	return (
		<div>
			<div className={styles.header}>
				<TitleInput sessionId={session.id} value={session.title || ""} tags={session.tags || []} />
				<div className={styles.actions}>
					<button className={styles.btn} onClick={()=>setShowTranscribe(true)} disabled={!session.files?.wav || recordingBusy || generating}>{tr("Transcribe")}</button>
     <button className={styles.btn} disabled={transcribing} onClick={onBack}>{tr("← Back")}</button>
				</div>
			</div>

			{showTranscribe && <RetranscribeDialog session={session} onClose={()=>setShowTranscribe(false)} onBusy={setTranscribing}/>}
   <div className={styles.meta}>{meta}</div>
   {session.transcriptionDiagnostics?.warnings.includes('microphone-all-asr-filtered') && <p role="status">{tr('All recognized microphone text was filtered as possible echo. Check the saved audio and transcript.')}</p>}
   {session.transcriptionDiagnostics?.warnings.includes('microphone-attribution-fallback') && <p role="status">{tr('Some microphone speech has uncertain speaker labels. Review the transcript and speaker names.')}</p>}
   {session.transcriptionDiagnostics?.warnings.includes('system-attribution-fallback') && <p role="status">{tr('Some participant speech has uncertain speaker labels. Review the transcript and speaker names.')}</p>}
   <SessionAudioPlayer archived={session.audioArchived} sessionId={session.id} available={!!session.files?.wav}
    audioRef={audioRef} onTime={seconds=>{setPlaybackTime(seconds);if(seconds===null)cancelSourceSeek();}} onDuration={duration=>{
     setAudioDuration(duration);
     const source=useUIStore.getState().taskSourceSeek;
     if(source?.sessionId===session.id){useUIStore.setState({taskSourceSeek:null});if(source.sourceRevision&&source.sourceRevision!==session.transcriptRevision){showToast(tr("The transcript changed. Refresh before asking or retrying."));return;}seekAudio(source.seconds);}
    }}/>

      <TagEditor session={session} onTagClick={onTagClick} />

			<NotesJobStatus session={session} />
   <Tabs tabs={tabs} active={activeTab} onChange={(id) => setActiveTab(id as TabId)} />

			{activeTab === "tasks" && <TasksPanel session={session} onSeek={session.files?.wav?seekAudio:undefined} onShowTranscript={source=>{setFocusedSource(source&&session.segments?.length?{segmentIndex:source.segmentIndex,paragraphIndex:null}:null);setActiveTab("speakers");}}/>}
			{activeTab === "speakers" && (session.segments?.length ?
				<SpeakerView
					segments={session.segments || []}
					speakers={session.speakers || []}
					embeddings={session.embeddings}
					speakerNames={speakerNames}
					onRename={handleSpeakerRename}
					onMerge={handleSpeakerMerge}
					emptyMessage={tr("No speaker segments in this meeting yet.")}
					animateEmpty={false}
     playbackTime={playbackTime}
     focusedSegmentIndex={focusedSource?.segmentIndex ?? undefined}
     onSeek={session.files?.wav ? seekAudio : undefined}
				/> : <div ref={textRef} className={styles.textTranscript}>{session.transcript ? session.transcript.split(/\n\s*\n/).map((paragraph,index)=><p key={index} aria-current={focusedSource?.paragraphIndex===index ? "true" : undefined}>{paragraph}</p>) : <p>{tr("No speaker segments in this meeting yet.")}</p>}</div>
			)}

   {activeTab === "chat" && <MeetingChat session={session} onCitation={openCitation}/>}

   {activeTab === "notes" && <NotesView notes={displayNotes} streaming={isStreaming} placeholder={tr("Click \"Generate AI notes\" below")}/>}

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

			<div className={styles.actionsRow} style={{ marginTop: "12px" }} hidden={activeTab==="chat"}>
				<button hidden={activeTab === "tasks"} className={styles.btn} onClick={handleCopy}>{tr("Copy")}</button>
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
							<button className={styles.btn} onClick={() => handleGenerate(false)} disabled={generating || notesBusy || recordingBusy || transcribing}>
								{generating ? <><Spinner />{tr("Generating…")}</> : tr("Generate AI notes · ~{seconds}s", undefined, {seconds: estimateNotesSeconds(currentModel?.vram_mb, true)})}
							</button>
						) : (
							<button className={styles.btnCpu} onClick={() => handleGenerate(true)} disabled={generating || notesBusy || recordingBusy || transcribing}>
								{generating ? <><Spinner />{tr("Generating on CPU…")}</> : tr("Generate on CPU · ~{seconds}s", undefined, {seconds:estimateNotesSeconds(currentModel?.vram_mb, false)})}
							</button>
						)}
					</>
				)}
			</div>
		</div>
	);
}
