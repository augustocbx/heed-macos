import { useState } from "react";
import { recordingApi } from "@/api/recording";
import { useRecordingStore } from "@/stores/recording";
import { applyRecordingSnapshot } from "@/lib/recordingSnapshot";
import { tr, useLocale } from "@/lib/i18n";
import styles from "./RecordPage.module.css";

export function RecordingRecovery() {
  useLocale();const state=useRecordingStore();const [busy,setBusy]=useState(false);const [error,setError]=useState("");
  if(state.coordinatorState!=="failed" || !state.coordinatorPath || !state.coordinatorMeetingId)return null;
  const retry=async()=>{
    if(busy)return;setBusy(true);
    try {applyRecordingSnapshot(await recordingApi.retry(state.coordinatorMeetingId!));}
    catch { /* The durable failed snapshot keeps retained audio available for retry. */ }
    finally {setBusy(false);}
  };
  const abandon=async()=>{
    if(busy)return;setBusy(true);setError("");
    try {applyRecordingSnapshot(await recordingApi.abandon(state.coordinatorMeetingId!));window.dispatchEvent(new Event("heed:recovery-refresh"));}
    catch {setError("Could not leave recovery. The audio is still retained.");}
    finally {setBusy(false);}
  };
  return <div className={styles.qualityWarn} role="alert">
    <span>{tr("Recording could not be completed. Retained audio is available for recovery.")}</span>
    <span>{tr("The audio stays available in Recovery.")}</span>
    {error&&<span>{tr(error)}</span>}
    <button type="button" disabled={busy} onClick={()=>void abandon()}>{tr("Keep audio and leave recovery")}</button>
    <button type="button" disabled={busy} onClick={()=>void retry()}>{tr(busy?"Finalizing...":"Retry finalization")}</button>
  </div>;
}
