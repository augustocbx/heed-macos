import { useState } from "react";
import { recordingApi } from "@/api/recording";
import { useRecordingStore } from "@/stores/recording";
import { applyRecordingSnapshot } from "@/lib/recordingSnapshot";
import { tr, useLocale } from "@/lib/i18n";
import styles from "./RecordPage.module.css";

export function RecordingRecovery() {
  useLocale();const state=useRecordingStore();const [busy,setBusy]=useState(false);const [error,setError]=useState("");const [confirmDiscard,setConfirmDiscard]=useState(false);
  if(state.coordinatorState!=="failed" || !state.coordinatorPath || !state.coordinatorMeetingId)return null;
  const retry=async()=>{
    if(busy)return;setBusy(true);
    try {applyRecordingSnapshot(await recordingApi.retry(state.coordinatorMeetingId!));}
    catch { /* The durable failed snapshot keeps retained audio available for retry. */ }
    finally {setBusy(false);}
  };
  const discard=async()=>{if(busy)return;setBusy(true);setError("");try{applyRecordingSnapshot(await recordingApi.discard(state.coordinatorMeetingId!));setConfirmDiscard(false);}catch{setError("Could not discard temporary audio. Retry cleanup.");}finally{setBusy(false);}};
  const transcriptOnly=state.meetingMode === "transcript-only";
  const abandon=async()=>{
    if(busy)return;setBusy(true);setError("");
    try {applyRecordingSnapshot(await recordingApi.abandon(state.coordinatorMeetingId!));window.dispatchEvent(new Event("heed:recovery-refresh"));}
    catch {setError("Could not leave recovery. The audio is still retained.");}
    finally {setBusy(false);}
  };
  return <div className={styles.qualityWarn} role="alert">
    <span>{tr(transcriptOnly?"Temporary audio cleanup is pending. Retry finalization or explicitly discard temporary audio. Saved transcripts are preserved.":"Recording could not be completed. Retained audio is available for recovery.")}</span>
    {!transcriptOnly&&<span>{tr("The audio stays available in Recovery.")}</span>}
    {error&&<span>{tr(error)}</span>}
    {transcriptOnly?<button type="button" disabled={busy} onClick={()=>setConfirmDiscard(true)}>{tr("Discard temporary audio")}</button>:<button type="button" disabled={busy} onClick={()=>void abandon()}>{tr("Keep audio and leave recovery")}</button>}
    {confirmDiscard&&<div><p>{tr("Discard unsaved temporary audio? The unsaved meeting cannot be recovered. Saved transcripts are preserved.")}</p><button type="button" disabled={busy} onClick={()=>void discard()}>{tr("Confirm discard")}</button><button type="button" disabled={busy} onClick={()=>setConfirmDiscard(false)}>{tr("Cancel")}</button></div>}
    <button type="button" disabled={busy} onClick={()=>void retry()}>{tr(busy?"Finalizing...":"Retry finalization")}</button>
  </div>;
}
