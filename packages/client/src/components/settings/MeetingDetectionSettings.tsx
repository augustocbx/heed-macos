import { useCallback, useEffect, useRef, useState } from "react";
import { MEETING_APPS, meetingDetectionApi, type DetectionSnapshot, type MeetingApp } from "@/api/meeting-detection";
import { permissionsApi } from "@/api/permissions";
import { useLocale } from "@/lib/i18n";
import styles from "./PermissionsPage.module.css";
const names: Record<MeetingApp, string> = {slack:"Slack",zoom:"Zoom",teams:"Teams",meet:"Google Meet"};
export function MeetingDetectionSettings() {
 const {tr} = useLocale();
 const [snapshot,setSnapshot] = useState<DetectionSnapshot|null>(null);
 const [error,setError] = useState<string|null>(null);
 const [saving,setSaving] = useState(false);
 const mutation = useRef(false), revision = useRef(0);
 const refresh = useCallback(async () => {
  if (mutation.current) return;
  const version = revision.current;
  try { const result = await meetingDetectionApi.status(); if (version === revision.current && !mutation.current) setSnapshot(result); }
  catch { if (version === revision.current) setError("Could not check meeting detection. Open Heed and try again."); }
 },[]);
 useEffect(() => { void refresh(); const interval = setInterval(() => void refresh(),3000); return () => {clearInterval(interval); revision.current++;}; },[refresh]);
 const configure = async (app: MeetingApp, enabled: boolean) => {
  if (mutation.current) return;
  mutation.current = true; revision.current++; setSaving(true); setError(null);
  try { setSnapshot(await meetingDetectionApi.configure({[app]:enabled})); }
  catch { setError("Could not save meeting detection settings."); }
  finally { mutation.current = false; setSaving(false); }
 };
 const authorize = async () => {
  setError(null); setSaving(true);
  try { await permissionsApi.authorize("accessibility"); }
  catch { setError("Could not open Accessibility settings. Open the Heed menu app and try again."); }
  finally { setSaving(false); }
 };
 return <article className={styles.card} aria-labelledby="meeting-detection-title">
  <h2 id="meeting-detection-title">{tr("Automatic meeting detection")}</h2>
  <p>{tr("Choose the apps that may start a recording. Manual recordings always stay under your control.")}</p>
  {MEETING_APPS.map(app => {
   const sources = snapshot?.sources.filter(s => s.app === app) ?? [];
   const label = !snapshot ? "Not checked" : !snapshot.enabled[app] ? "Disabled" : sources.some(s => s.suppressed) ? "Paused for this call" : sources.some(s => s.capability === "permission-required") ? app === "slack" ? "Authorize Slack logs" : "Accessibility permission needed" : sources.some(s => s.capability === "degraded" || s.capability === "unsupported") ? "Detection unavailable — use manual recording" : sources.some(s => s.state === "active") ? "Meeting detected" : sources.length ? "Waiting for a meeting" : "Not checked";
   return <div key={app}><label><input type="checkbox" checked={snapshot?.enabled[app] ?? false} disabled={!snapshot || saving} onChange={event => void configure(app,event.target.checked)}/>{names[app]}</label><p role="status">{tr(label)}</p></div>;
  })}
  <p>{tr("Zoom and Teams use authorized Accessibility controls. Hidden or changed controls suspend detection. Meet requires the scoped Chrome or Edge extension and local native host.")}</p>
  <button disabled={saving} onClick={() => void authorize()}>{tr("Authorize Accessibility")}</button>{" "}
  <a href="https://github.com/augustocbx/heed-macos/blob/main/docs/meeting-detection.md" target="_blank" rel="noreferrer">{tr("Meeting detection setup and capabilities")}</a>
  <p>{tr("Join confirmation takes 3 seconds; a confirmed end waits 5 seconds for reconnects. Missing controls or permission never prove a call ended. Stop manually if detection becomes unavailable.")}</p>
  <p>{tr("Stopping manually pauses automation for the same call. Rejoin after a confirmed end to allow a new recording. Disabling detection leaves an existing recording running for you to stop.")}</p>
  {snapshot?.reconnectSeconds != null && snapshot.reconnectSeconds > 0 && <p role="status">{tr("Waiting for reconnect — {seconds}s",{seconds:snapshot.reconnectSeconds})}</p>}
  {snapshot?.ownerMeetingId && <p role="status">{tr("Heed owns this automatic recording; overlapping detected calls share one capture.")}</p>}
  {(error || snapshot?.error) && <p role="alert" className={styles.error}>{tr(error ?? snapshot?.error ?? "")}</p>}
 </article>;
}
