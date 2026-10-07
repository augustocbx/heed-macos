import {VocabularySettings} from './VocabularySettings';
import { useLocale } from "@/lib/i18n.ts";
import { UI_LOCALES, type Locale } from "@/lib/locale.ts";
import { useLocaleStore } from "@/stores/locale.ts";
import { useCallback, useEffect, useRef, useState } from 'react';
import { permissionsApi, type PermissionAction, type PermissionSnapshot } from '@/api/permissions.ts';
import styles from './PermissionsPage.module.css';
import {StorageLibrarySettings} from "./StorageLibrarySettings";
import { AutomaticNotesSettings } from '@/components/ai-notes/AutomaticNotesSettings';
import {LiveSpeechLanguageSettings} from "./LiveSpeechLanguageSettings";
import {RealTimeTranscriptionSettings} from "./RealTimeTranscriptionSettings";
import {StorageSettings} from './StorageSettings';
import {RemoteStorageSettings} from './RemoteStorageSettings';

import { MeetingDetectionSettings } from "./MeetingDetectionSettings";

export function PermissionsPage() {
 const {locale,tr}=useLocale();
 const [librarySelection,setLibrarySelection]=useState(0);
 const selectLocale=useLocaleStore(s=>s.select);
 const [savingLocale,setSavingLocale]=useState(false);
 const [localeError,setLocaleError]=useState(false);
 const changeLocale=async(value:Locale)=>{setSavingLocale(true);setLocaleError(false);try{await selectLocale(value);}catch{setLocaleError(true);}finally{setSavingLocale(false);}};
 const [snapshot, setSnapshot] = useState<PermissionSnapshot | null>(null);
 const [loadError, setLoadError] = useState(false);
 const [actionError, setActionError] = useState<string | null>(null);
 const [action, setAction] = useState<PermissionAction | null>(null);
 const [notice, setNotice] = useState<string | null>(null);
 const recovery = useRef({ requested: false, observedPending: false, restarting: false });
 const refresh = useCallback(async () => {
  try {
   const next = await permissionsApi.status();
   setSnapshot(next); setLoadError(false);
   if (recovery.current.requested) {
    if (next.error || (next.controllerConnected && next.permissions?.screenCapture === true)) {
     recovery.current = { requested: false, observedPending: false, restarting: false };
     setNotice(null);
    } else if (!next.controllerConnected) {
     recovery.current.restarting = true;
     setNotice('Restarting Heed to renew system audio access…');
    } else if (recovery.current.restarting || (recovery.current.observedPending && !next.pending)) {
     recovery.current = { requested: false, observedPending: false, restarting: false };
     setNotice(null);
    } else if (next.pending) {
     recovery.current.observedPending = true;
    }
   }
  }
  catch { setLoadError(true); }
 }, []);
 useEffect(() => {
  void refresh();
  const interval = window.setInterval(() => void refresh(), 3000);
  const onFocus = () => void refresh();
  window.addEventListener('focus', onFocus);
  return () => { clearInterval(interval); window.removeEventListener('focus', onFocus); };
 }, [refresh]);
 const authorize = async (target: PermissionAction) => {
  setAction(target); setActionError(null); setNotice(null);
  try {
   await permissionsApi.authorize(target);
   if (target === 'recoverScreenCapture') {
    recovery.current = { requested: true, observedPending: false, restarting: false };
    setNotice('Confirm recovery in the Heed window. Heed will restart, then macOS will ask for authorization.');
   } else {
    recovery.current = { requested: false, observedPending: false, restarting: false };
    setNotice('Complete authorization in the macOS window. This page checks permissions automatically.');
   }
   await refresh();
  }
  catch { setActionError(target === 'recoverScreenCapture' ? 'Could not start permission recovery. Make sure Heed is running and try again.' : 'Could not open authorization. Make sure the Heed app is running and try again.'); }
  finally { setAction(null); }
 };
 const connected = !loadError && snapshot?.controllerConnected === true;
 const permissions = connected ? snapshot?.permissions : null;
 const microphone = permissions?.microphone ?? 'unknown';
 const system = permissions?.screenCapture ?? null;
 const slack = permissions?.slackLogs ?? null;
 const slackOptional = permissions?.slackAutoRecord === false;
 const missing = microphone === 'denied' || microphone === 'restricted' || microphone === 'notDetermined' || system === false || (!slackOptional && slack === false);
 const ready = connected && microphone === 'authorized' && system === true && (slackOptional || (permissions?.slackAutoRecord === true && slack === true));
 const title = loadError ? 'Could not check permissions' : !snapshot ? 'Checking permissions…' : !connected ? 'Heed app disconnected' : missing ? 'Permissions needed' : ready ? 'Permissions authorized' : 'Check incomplete';
 const boolStatus = (value: boolean | null) => value === true ? 'Authorized' : value === false ? 'Not authorized' : 'Not checked';
 const disabled = !connected || !!action || !!snapshot?.pending;
 const rows = [
  { id: 'microphone' as const, title: 'Microphone', description: 'Records your voice.', status: microphone === 'authorized' ? 'Authorized' : microphone === 'denied' ? 'Not authorized' : microphone === 'restricted' ? 'Restricted by macOS' : microphone === 'notDetermined' ? 'Awaiting authorization' : 'Not checked', allowed: microphone === 'authorized', button: microphone === 'authorized' || microphone === 'denied' || microphone === 'restricted' ? 'Open microphone settings' : 'Authorize microphone', help: 'In System Settings → Privacy & Security → Microphone, enable Heed.' },
  { id: 'screenCapture' as const, title: 'System audio', description: 'Records other participants, including when you use headphones.', status: boolStatus(system), allowed: system === true, button: system === true ? 'Open system audio settings' : 'Authorize system audio', help: 'In System Settings → Privacy & Security → Screen & System Audio Recording, enable Heed. The option name may vary with your macOS version.' },
  { id: 'slackLogs' as const, title: 'Slack meeting detection', description: 'Detects when you join a meeting in the Slack app.', status: slackOptional ? 'Optional — automatic recording disabled' : boolStatus(slack), allowed: slack === true, button: 'Authorize Slack logs', help: 'In the folder picker, authorize the Slack logs folder selected by Heed. Enable “Automatically record Slack meetings” from the menu bar icon.' },
 ];
 return <section className={styles.page} aria-labelledby="settings-title">
  <header><h1 id="settings-title">{tr('Settings')}</h1><p>{tr('Permissions on this Mac')}</p></header>
  <article className={styles.card}>
   <label htmlFor="interface-language">{tr("Interface language")}</label>
   <select id="interface-language" value={locale} disabled={savingLocale} onChange={event=>void changeLocale(event.target.value as Locale)}>
    {UI_LOCALES.map(value=><option key={value} value={value}>{({en:"English","pt-BR":"Português (Brasil)",fr:"Français",de:"Deutsch"})[value]}</option>)}
   </select>
   <p>{tr("Interface language does not change the meeting transcription language.")}</p>
   {savingLocale && <p role="status">{tr("Saving…")}</p>}
   {localeError && <p role="alert">{tr("Could not save interface language. Check that Heed is running and try again.")}</p>}
  </article>
  <RealTimeTranscriptionSettings /><VocabularySettings/>
 <LiveSpeechLanguageSettings />
  <AutomaticNotesSettings />
  <RemoteStorageSettings onProviderChanged={()=>setLibrarySelection(value=>value+1)}/>
  <MeetingDetectionSettings />
  <StorageSettings />
  <StorageLibrarySettings key={librarySelection}/>
  <div className={`${styles.summary} ${ready ? styles.ready : styles.attention}`} role="status"><strong>{tr(title)}</strong><p>{tr(!connected ? 'Open the Heed app from the menu bar icon to check and authorize access.' : ready ? 'The required permissions are authorized.' : 'Complete the authorizations below before starting a meeting.')}</p><button onClick={() => void refresh()}>{tr('Check again')}</button></div>
  {(actionError || snapshot?.error) && <p className={styles.error} role="alert">{tr(actionError || snapshot?.error || "")}</p>}
  {notice && <p className={styles.notice} role="status">{tr(notice)}</p>}
  <div className={styles.cards}>{rows.map(row => <article key={row.id} className={styles.card} aria-labelledby={`permission-${row.id}`}>
   <div className={styles.cardHeading}><h2 id={`permission-${row.id}`}>{tr(row.title)}</h2><span className={row.allowed ? styles.authorized : styles.pending}>{tr(row.status)}</span></div>
   <p>{tr(row.description)}</p>
   {(!row.allowed || row.id !== 'slackLogs') && <><p className={styles.help}>{tr(row.help)}</p><button disabled={disabled} onClick={() => void authorize(row.id)}>{tr(action === row.id ? 'Opening authorization…' : row.button)}</button></>}
   {row.id === 'screenCapture' && connected && system === false && <>
    <p className={styles.help}>{tr('Recover access if system audio stays unavailable after authorization. Heed will ask for confirmation before restarting. Your meetings and other permissions are preserved.')}</p>
    <button disabled={disabled || snapshot?.recoveryAvailable !== true} onClick={() => void authorize('recoverScreenCapture')}>{tr(action === 'recoverScreenCapture' ? 'Opening recovery…' : 'Recover system audio permission')}</button>
    {snapshot?.recoveryAvailable !== true && <p className={styles.help}>{tr(snapshot?.recoveryBlockedReason || 'Open the updated Heed menu app to recover system audio access.')}</p>}
   </>}
  </article>)}</div>
  <aside className={styles.tip}><strong>{tr('Already authorized, but recording still fails?')}</strong><p>{tr('If system audio stays unavailable after authorization, use Recover system audio permission. Your meetings and other permissions are preserved.')}</p><p>{tr('Recording continues with browser tabs closed. Keep the Heed app and local services running.')}</p></aside>
 </section>;
}
