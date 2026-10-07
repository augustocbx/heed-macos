import type { RecordingSnapshot } from "@heed/shared";
import { useRecordingStore } from "@/stores/recording";
import { tr } from "./i18n";

/** Apply a server revision without resurrecting a dismissed completed result. */
export function applyRecordingSnapshot(snapshot:RecordingSnapshot) {
  const local=useRecordingStore.getState();
  if(!snapshot || !Number.isSafeInteger(snapshot.revision))return;
  // Revisions belong to the durable coordinator, including across meetings/restarts.
  if(snapshot.revision<local.coordinatorRevision)return;
  if(local.coordinatorMeetingId===snapshot.meetingId && local.coordinatorState==="completed" && snapshot.state==="completed" && snapshot.revision===local.coordinatorRevision)return;
  if(local.coordinatorMeetingId===snapshot.meetingId && local.coordinatorState==="completed" && ["starting","recording","stopping","finalizing"].includes(snapshot.state))return;
  if(snapshot.state==="idle"){
    if(local.coordinatorState!=="idle")local.reset();
    useRecordingStore.setState({coordinatorMeetingId:snapshot.meetingId,coordinatorRevision:snapshot.revision,coordinatorState:"idle",coordinatorError:null,coordinatorPath:null});
    return;
  }
  if(local.dismissedMeetingId===snapshot.meetingId && ["idle","completed","failed"].includes(snapshot.state))return;
  const active=["starting","recording","stopping","finalizing"].includes(snapshot.state);
  const changed=local.coordinatorMeetingId!==snapshot.meetingId;
  if(changed && snapshot.state==="recording")local.startRecording();
  const session=snapshot.session;
  const saved=snapshot.state==="completed" && !!session?.transcriptFinalized;
  const segments=saved?session.segments:snapshot.segments;
  useRecordingStore.setState({
    meetingMode:snapshot.meetingMode ?? "audio-transcript",audioCleanup:snapshot.audioCleanup ?? null,
    realTimeTranscription:snapshot.realTimeTranscription !== false,
    liveOptions:snapshot.liveOptions || null,liveSpeechLanguage:snapshot.liveSpeechLanguage || "en",liveModel:snapshot.liveModel || snapshot.liveOptions?.initialModel || null,
    coordinatorMeetingId:snapshot.meetingId,coordinatorRevision:snapshot.revision,
    coordinatorState:snapshot.state,coordinatorError:snapshot.error,coordinatorPath:snapshot.path,
    ...(active?{dismissedMeetingId:null}:{}),
    recording:snapshot.state==="recording",
    processing:["starting","stopping","finalizing"].includes(snapshot.state),
    processStep:tr(snapshot.state==="starting"?"Preparing services…":"Finalizing..."),
    seconds:Math.floor(saved?session.duration:snapshot.seconds),
    segments,speakers:saved?session.speakers:[...new Set(segments.map(s=>s.speaker))],
    transcript:saved?session.transcript:segments.map(s=>s.text).join("\n"),
    speakerNames:saved?{}:snapshot.speakerNames,
    currentSessionId:saved?session.id:null,
    ...(saved?{resultLanguage:session.language,embeddings:session.embeddings || {},files:{wav:session.files?.wav || "",srt:session.files?.srt || "",txt:session.files?.txt || ""},notesText:session.aiNotes,processProgress:100}:{}),
    finalSavePending:false,
  });
}
