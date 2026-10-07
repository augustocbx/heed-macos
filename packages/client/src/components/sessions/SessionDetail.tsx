import { TasksPanel } from "@/components/tasks/TasksPanel";
import { MeetingChat } from "@/components/chat/MeetingChat";
import { tr, useLocale } from "@/lib/i18n.ts";
import { useState, useEffect, useRef } from "react";
import type { Session, TranscriptEvidence,TranscriptGuard,TranscriptTarget,TranscriptCommand } from "@heed/shared";
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
import { guardForSession } from "@/lib/acceptedSession";
import { applySpeakerNames } from "@/lib/speakerNames.ts";
import { RetranscribeDialog } from "./RetranscribeDialog";
import {TranscriptSegmentEditor} from './TranscriptSegmentEditor';
import {TranscriptReplaceDialog} from './TranscriptReplaceDialog';
import {TranscriptHistoryDialog} from './TranscriptHistoryDialog';
import {transcriptEditingApi} from '@/api/transcript-editing';
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
 const transcriptHasText=session.segments.length?session.segments.some(segment=>!!segment.text.trim()):!!session.transcript.trim();
  const [editDraft, setEditDraft] = useState<{
    id: string;
    target: TranscriptTarget;
    guard: TranscriptGuard;
    value: string;
    generationId?: string;
  } | null>(null);
  const [correctionDialog, setCorrectionDialog] = useState<
    "replace" | "history" | null
  >(null);
  const pendingCorrection = useRef<{
    key: string;
    command: TranscriptCommand;
  } | null>(null);
 const notesBusy = automaticNotesBusy(session);
	useLocale();
	const [showTranscribe,setShowTranscribe] = useState(false);
 const [transcribing,setTranscribing] = useState(false);
 const recordingBusy = useRecordingStore(s=>s.recording || s.processing);
 const update = useSessionsStore((s) => s.update);
	const showToast = useUIStore((s) => s.showToast);
  function openTextEditor(index?: number) {
    try {
      const guard = guardForSession(session),
        target: TranscriptTarget =
          index === undefined ? { kind: "document" } : { kind: "segment", index };
      pendingCorrection.current = null;
      setEditDraft({
        id: session.id,
        target,
        guard,
        value:
          index === undefined
            ? session.transcript
            : session.segments[index]!.text,
        generationId: session.transcriptEditing?.activeGenerationId,
      });
    } catch {
      showToast(
        tr("The transcript source is unavailable. Refresh before saving."),
      );
    }
  }
  async function saveText(text: string) {
    if (!editDraft) return;
    const key = JSON.stringify({
      guard: editDraft.guard,
      target: editDraft.target,
      text,
    });
    if (pendingCorrection.current?.key !== key)
      pendingCorrection.current = {
        key,
        command: {
          ...editDraft.guard,
          requestId: crypto.randomUUID(),
          action: "edit",
          target: editDraft.target,
          text,
        },
      };
    await transcriptEditingApi.command(
      editDraft.id,
      pendingCorrection.current.command,
    );
    setEditDraft(null);
  }
  async function reloadText(): Promise<string> {
    if (!editDraft) throw Error("No open transcript draft");
    await useSessionsStore.getState().load(true);
    const state = useSessionsStore.getState(),
      listed = state.sessions.find((value) => value.id === editDraft.id),
      viewed = state.viewing?.id === editDraft.id ? state.viewing : null;
    const current =
      viewed &&
      (viewed.transcriptVersion ?? 0) > (listed?.transcriptVersion ?? -1)
        ? viewed
        : listed;
    if (
      !current ||
      (editDraft.generationId &&
        editDraft.generationId !==
          current.transcriptEditing?.activeGenerationId) ||
      (!editDraft.generationId &&
        (current.transcriptEditing?.generations.length ?? 0) > 1) ||
      (editDraft.target.kind === "segment" &&
        !current.segments[editDraft.target.index]) ||
      (editDraft.target.kind === "document" && current.segments.length)
    )
      throw Error("Source structure changed");
    const value =
      editDraft.target.kind === "document"
        ? current.transcript
        : current.segments[editDraft.target.index]!.text;
    pendingCorrection.current = null;
    setEditDraft({
      ...editDraft,
      guard: guardForSession(current),
      value,
      generationId: current.transcriptEditing?.activeGenerationId,
    });
    return value;
  }
	const { templates, load: loadTemplates } = useTemplatesStore();
	const modelsData = useModelsStore((s) => s.data);
	const loadModels = useModelsStore((s) => s.load);
	const openPicker = useModelsStore((s) => s.openPicker);

	const [activeTab, setActiveTab] = useState<TabId>("speakers");
	const [templateId, setTemplateId] = useState<string>("general");
	const [generating, setGenerating] = useState(false);
	const [streamingNotes, setStreamingNotes] = useState("");
	const [speakerNames, setSpeakerNames] = useState<Record<string, string>>({});
 const audioAvailable=session.meetingMode !== "transcript-only" && !!session.files?.wav;
 const audioRef = useRef<HTMLAudioElement>(null);
 const [focusedSource,setFocusedSource]=useState<{segmentIndex:number|null;paragraphIndex:number|null}|null>(null);
 const cancelSourceSeek=()=>{if(useUIStore.getState().taskSourceSeek?.sessionId===session.id)useUIStore.setState({taskSourceSeek:null});};
 const sourceSeekGeneration=useRef(0);
 useEffect(()=>{
  const generation=++sourceSeekGeneration.current,pending=useUIStore.getState().taskSourceSeek;
  if(pending&&(pending.sessionId!==session.id||(pending.sourceRevision&&pending.sourceRevision!==session.transcriptRevision)))useUIStore.setState({taskSourceSeek:null});
  if(!audioAvailable)cancelSourceSeek();
  // StrictMode replays setup after cleanup; only a real departure cancels the pending request.
  return ()=>{const pending=useUIStore.getState().taskSourceSeek;queueMicrotask(()=>{if(sourceSeekGeneration.current===generation&&useUIStore.getState().taskSourceSeek===pending)cancelSourceSeek();});};
 },[session.id,session.transcriptRevision,session.files?.wav,audioAvailable]);
 const textRef=useRef<HTMLDivElement>(null);
 useEffect(()=>{setFocusedSource(null);},[session.id,session.transcriptRevision]);
 useEffect(()=>{if(activeTab==="speakers")textRef.current?.querySelector<HTMLElement>('[aria-current="true"]')?.scrollIntoView?.({block:"center"});},[activeTab,focusedSource]);
 const [playbackTime,setPlaybackTime] = useState<number|null>(null);
 const [audioDuration,setAudioDuration] = useState<number|null>(null);
 useEffect(()=>{setPlaybackTime(null);setAudioDuration(null);},[session.id]);
 useEffect(()=>{setSpeakerNames({});},[session.id, session.transcriptRevision, session.transcriptVersion]);
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
  if(audioAvailable&&citation.start!==null)seekAudio(citation.start);
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
		if (!transcriptHasText || generating || notesBusy || recordingBusy || transcribing) return;
  if (session.aiNotes && !window.confirm(tr(replacementPrompt))) return;
		setGenerating(true);
		setStreamingNotes("");
		setActiveTab("notes");
		try {
			const guard = guardForSession(session);
			let acc = "";
			await generateNotes(
				session.segments?.length ? session.segments.map(segment => `${segment.speaker}: ${segment.text}`).join("\n") : session.transcript,
				session.language || "en",
				templateId,
				{
					onToken: (tok) => { acc += tok; setStreamingNotes(acc); },
					onDone: async (full) => {
						await update(session.id, { aiNotes: full, expectedNotes: session.aiNotes || "", ...guard });
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

	const handleSpeakerRename = async (original: string, newName: string) => {
		const names = { ...speakerNames, [original]: newName };
		setSpeakerNames(names);
		try {
			await update(session.id, { ...applySpeakerNames(session.segments || [], session.speakers || [], session.embeddings || {}, names), ...guardForSession(session) });
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
		try {
   await update(session.id, { segments: newSegments, speakers: newSpeakers, ...guardForSession(session) });
   showToast(tr("Merged"));
  } catch (error) { showToast(tr("Error: {message}", undefined, {message: tr((error as Error).message)})); }
	};

	const displayNotes = streamingNotes || session.aiNotes || "";
 useEffect(()=>{
  const citation=useUIStore.getState().chatSourceFocus;
  if(!citation||citation.sessionId!==session.id)return;
  useUIStore.setState({chatSourceFocus:null});
  if(citation.sourceRevision!==session.transcriptRevision){showToast(tr("The transcript changed. Refresh before asking or retrying."));return;}
  setFocusedSource({segmentIndex:citation.segmentIndex,paragraphIndex:citation.paragraphIndex});setActiveTab("speakers");
  if(audioAvailable&&citation.start!==null){
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
					<button className={styles.btn} onClick={()=>setShowTranscribe(true)} title={session.meetingMode === "transcript-only"?tr("Transcript-only meeting. Playback and retranscription are unavailable."):undefined} disabled={!audioAvailable || recordingBusy || generating}>{tr("Transcribe")}</button>
     {!!session.transcriptEditing?.candidates.length&&<button type="button" className={styles.btn} onClick={()=>setShowTranscribe(true)}>{tr('Review new transcript')}</button>}
     <button className={styles.btn} disabled={transcribing} onClick={onBack}>{tr("← Back")}</button>
				</div>
			</div>

			{showTranscribe && <RetranscribeDialog session={session} onClose={()=>setShowTranscribe(false)} onBusy={setTranscribing}/>}
   {editDraft&&<TranscriptSegmentEditor value={editDraft.value} label={tr(editDraft.target.kind==='document'?'Edit transcript':'Edit segment {number}',undefined,{number:editDraft.target.kind==='segment'?editDraft.target.index+1:0})} onSave={saveText} onCancel={()=>setEditDraft(null)} onReload={reloadText}/>}
   {correctionDialog==='replace'&&<TranscriptReplaceDialog session={session} onClose={()=>setCorrectionDialog(null)} onSaved={()=>setCorrectionDialog(null)}/>}
   {correctionDialog==='history'&&<TranscriptHistoryDialog session={session} onClose={()=>setCorrectionDialog(null)} onSaved={()=>setCorrectionDialog(null)}/>}
   <div className={styles.meta}>{meta}</div>
   {session.transcriptionDiagnostics?.warnings.includes('microphone-all-asr-filtered') && <p role="status">{tr('All recognized microphone text was filtered as possible echo. Check the saved audio and transcript.')}</p>}
   {session.transcriptionDiagnostics?.warnings.includes('microphone-attribution-fallback') && <p role="status">{tr('Some microphone speech has uncertain speaker labels. Review the transcript and speaker names.')}</p>}
   {session.transcriptionDiagnostics?.warnings.includes('system-attribution-fallback') && <p role="status">{tr('Some participant speech has uncertain speaker labels. Review the transcript and speaker names.')}</p>}
   <SessionAudioPlayer archived={session.audioArchived} sessionId={session.id} available={audioAvailable} unavailableReason={session.meetingMode === "transcript-only"?"transcript-only":undefined} cleanupPending={session.audioCleanup?.status === "pending"}
    audioRef={audioRef} onTime={seconds=>{setPlaybackTime(seconds);if(seconds===null)cancelSourceSeek();}} onDuration={duration=>{
     setAudioDuration(duration);
     const source=useUIStore.getState().taskSourceSeek;
     if(source?.sessionId===session.id){useUIStore.setState({taskSourceSeek:null});if(source.sourceRevision&&source.sourceRevision!==session.transcriptRevision){showToast(tr("The transcript changed. Refresh before asking or retrying."));return;}seekAudio(source.seconds);}
    }}/>

      <TagEditor session={session} onTagClick={onTagClick} />

			<NotesJobStatus session={session} />
   <Tabs tabs={tabs} active={activeTab} onChange={(id) => setActiveTab(id as TabId)} />

			{activeTab === "tasks" && <TasksPanel session={session} onSeek={audioAvailable?seekAudio:undefined} onShowTranscript={source=>{setFocusedSource(source&&session.segments?.length?{segmentIndex:source.segmentIndex,paragraphIndex:null}:null);setActiveTab("speakers");}}/>}
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
     onSeek={audioAvailable ? seekAudio : undefined}
     onEditText={session.transcriptFinalized?index=>openTextEditor(index):undefined}
     editingDisabled={transcribing}
				/> : <div ref={textRef} className={styles.textTranscript}>{session.transcript ? session.transcript.split(/\n\s*\n/).map((paragraph,index)=><p key={index} aria-current={focusedSource?.paragraphIndex===index ? "true" : undefined}>{paragraph}</p>) : <p>{tr(session.transcriptFinalized?'Empty transcript text':"No speaker segments in this meeting yet.")}</p>}{session.transcriptFinalized&&<button className={styles.btn} disabled={transcribing} onClick={()=>openTextEditor()}>{tr('Edit transcript')}</button>}</div>
			)}
   {activeTab==='speakers'&&session.transcriptFinalized&&<div className={styles.actionsRow}><button className={styles.btn} disabled={transcribing} onClick={()=>setCorrectionDialog('replace')}>{tr('Find and replace')}</button><button className={styles.btn} onClick={()=>setCorrectionDialog('history')}>{tr('Recovery history')}</button></div>}

   {activeTab === "chat" && <MeetingChat session={session} onCitation={openCitation}/>}

   {activeTab === "notes" && <NotesView notes={displayNotes} streaming={isStreaming} placeholder={tr("Click \"Generate AI notes\" below")}/>}
   {activeTab==='notes'&&!transcriptHasText&&<p role="status">{tr('This transcript has no usable text. Add a correction before generating notes.')}</p>}

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
							<button className={styles.btn} onClick={() => handleGenerate(false)} disabled={generating || notesBusy || recordingBusy || transcribing || !transcriptHasText}>
								{generating ? <><Spinner />{tr("Generating…")}</> : tr("Generate AI notes · ~{seconds}s", undefined, {seconds: estimateNotesSeconds(currentModel?.vram_mb, true)})}
							</button>
						) : (
							<button className={styles.btnCpu} onClick={() => handleGenerate(true)} disabled={generating || notesBusy || recordingBusy || transcribing || !transcriptHasText}>
								{generating ? <><Spinner />{tr("Generating on CPU…")}</> : tr("Generate on CPU · ~{seconds}s", undefined, {seconds:estimateNotesSeconds(currentModel?.vram_mb, false)})}
							</button>
						)}
					</>
				)}
			</div>
		</div>
	);
}
