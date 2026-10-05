import { useCallback, useEffect, useState } from 'react';
import { permissionsApi, type PermissionAction, type PermissionSnapshot } from '@/api/permissions.ts';
import styles from './PermissionsPage.module.css';

export function PermissionsPage() {
 const [snapshot, setSnapshot] = useState<PermissionSnapshot | null>(null);
 const [loadError, setLoadError] = useState(false);
 const [actionError, setActionError] = useState<string | null>(null);
 const [action, setAction] = useState<PermissionAction | null>(null);
 const [notice, setNotice] = useState<string | null>(null);
 const refresh = useCallback(async () => {
  try { setSnapshot(await permissionsApi.status()); setLoadError(false); }
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
  try { await permissionsApi.authorize(target); setNotice('Complete authorization in the macOS window. This page checks permissions automatically.'); await refresh(); }
  catch { setActionError('Could not open authorization. Make sure the Heed app is running and try again.'); }
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
  <header><h1 id="settings-title">Settings</h1><p>Permissions on this Mac</p></header>
  <div className={`${styles.summary} ${ready ? styles.ready : styles.attention}`} role="status"><strong>{title}</strong><p>{!connected ? 'Open the Heed app from the menu bar icon to check and authorize access.' : ready ? 'The required permissions are authorized.' : 'Complete the authorizations below before starting a meeting.'}</p><button onClick={() => void refresh()}>Check again</button></div>
  {(actionError || snapshot?.error) && <p className={styles.error} role="alert">{actionError || snapshot?.error}</p>}
  {notice && <p className={styles.notice} role="status">{notice}</p>}
  <div className={styles.cards}>{rows.map(row => <article key={row.id} className={styles.card} aria-labelledby={`permission-${row.id}`}>
   <div className={styles.cardHeading}><h2 id={`permission-${row.id}`}>{row.title}</h2><span className={row.allowed ? styles.authorized : styles.pending}>{row.status}</span></div>
   <p>{row.description}</p>
   {(!row.allowed || row.id !== 'slackLogs') && <><p className={styles.help}>{row.help}</p><button disabled={disabled} onClick={() => void authorize(row.id)}>{action === row.id ? 'Opening authorization…' : row.button}</button></>}
  </article>)}</div>
  <aside className={styles.tip}><strong>Already authorized, but recording still fails?</strong><p>After an update, macOS may require renewed authorization. In Settings, turn Heed off and on for the indicated permission. If macOS asks, choose “Quit & Reopen”. Return to this page and check the status before testing.</p><p>Keep the Heed interface open during automatic recording.</p></aside>
 </section>;
}
