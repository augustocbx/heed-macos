import { useCallback, useEffect, useRef, useState } from 'react';
import { directSmbApi, DirectSmbApiError, type DirectSmbEndpoint, type DirectSmbReview, type DirectSmbSnapshot, type DirectSmbTarget, type DirectSmbConnection } from '@/api/smb-direct';
import { useLocale } from '@/lib/i18n';
import styles from './PermissionsPage.module.css';

const EMPTY_ENDPOINT: DirectSmbEndpoint = { server: '', port: 445, share: '', folder: '', requireEncryption: false };
const NOTICES: Record<string, string> = {
 'invalid-input': 'Check the server, share, folder and account. Use port 445, or ports 48000–48999 on localhost only.',
 'read-only': 'Direct SMB requires write access for coordination. Use the mounted option for read-only imports.',
 'unsupported-coordination': 'This destination does not support the required direct SMB coordination.',
 'unsupported-security': 'The destination does not meet the required SMB signing or encryption policy.',
 'unsupported-namespace': 'The destination namespace is not safe for direct synchronization.',
 'unsupported-identity': 'The destination identity could not be verified. Test a supported destination.',
 'unsupported-destination': 'Choose an existing compatible library or a verified empty folder.',
 'destination-exists': 'The destination already exists. Test this connection again.',
 'identity-changed': 'The destination identity changed. Test this connection again.',
 'stale-generation': 'This connection changed. Review the refreshed status before trying again.',
 'receipt-expired': 'The review expired. Test this connection again.',
 'destination-busy': 'This destination is busy. Wait and review its status before trying again.',
 'recovery-required': 'Direct synchronization requires recovery. Preserve configuration and pending copies.',
 'bounds-exceeded': 'The direct synchronization limit was reached. Review pending work before trying again.',
 'access-denied': 'Authentication or access was refused. Review your account and test again.',
 'credential-unavailable': 'The saved credential is unavailable. Retest this destination with your account.',
 'forbidden': 'Direct SMB controls are only available from this Mac.',
 'invalid-preview': 'The connection review is unsupported or inconsistent. Test a compatible destination again.',
};
const GENERIC_NOTICE = 'Could not complete the direct SMB operation. Review access, security and pending work before trying again.';
const notice = (code: string) => Object.hasOwn(NOTICES, code) ? NOTICES[code] : GENERIC_NOTICE;

export function DirectSmbSettings({ onProviderChanged }: { onProviderChanged?: () => void } = {}) {
 const { tr } = useLocale();
 const [snapshot, setSnapshot] = useState<DirectSmbSnapshot | null>(null);
 const [endpoint, setEndpoint] = useState<DirectSmbEndpoint>(EMPTY_ENDPOINT);
 const [name, setName] = useState('');
 const [credentials, setCredentials] = useState({ username: '', domain: '', password: '' });
 const [review, setReview] = useState<DirectSmbReview | null>(null);
 const [create, setCreate] = useState(false);
 const [target, setTarget] = useState<DirectSmbTarget | undefined>();
 const [busy, setBusy] = useState<'test' | 'control' | null>(null);
 const [error, setError] = useState<string | null>(null);
 const [unavailable, setUnavailable] = useState(false);
 const [edits, setEdits] = useState<Record<string, string>>({});
 const mounted = useRef(false);
 const sequence = useRef(0);
 const statusSequence = useRef(0);
 const operation = useRef<AbortController | null>(null);
 const statusRequest = useRef<AbortController | null>(null);
 const active = useRef<'test' | 'control' | null>(null);
 // Pending request callbacks retain this ref rather than a second credential copy.
 const credentialMemory = useRef(credentials);
 credentialMemory.current = credentials;
 const clearCredentials = () => {
  credentialMemory.current = { username: '', domain: '', password: '' };
  setCredentials(credentialMemory.current);
 };
 const invalidateReview = () => { setReview(null); setCreate(false); };
 const refresh = useCallback(async () => {
  if (active.current) return;
  const version = ++statusSequence.current;
  statusRequest.current?.abort();
  const controller = new AbortController(); statusRequest.current = controller;
  try {
   const next = await directSmbApi.status(controller.signal);
   if (!mounted.current || version !== statusSequence.current || controller.signal.aborted) return;
   setSnapshot(next); setUnavailable(false);
  } catch (failure) {
   if (!mounted.current || version !== statusSequence.current || controller.signal.aborted) return;
   setError(notice(failure instanceof DirectSmbApiError ? failure.code : 'transport-unavailable'));
   setUnavailable(true);
  }
 }, []);
 useEffect(() => {
  mounted.current = true; void refresh();
  const timer = window.setInterval(() => void refresh(), 3000);
  return () => {
   mounted.current = false; ++sequence.current; ++statusSequence.current;
   operation.current?.abort(); statusRequest.current?.abort(); clearInterval(timer);
   credentialMemory.current = { username: '', domain: '', password: '' };
  };
 }, [refresh]);
 useEffect(() => {
  if (!review) return;
  const expire = () => { invalidateReview(); setError(notice('receipt-expired')); };
  if (review.expiresAt <= Date.now()) { expire(); return; }
  const timer = window.setTimeout(expire, Math.min(review.expiresAt - Date.now(), 2147483647));
  return () => clearTimeout(timer);
 }, [review]);
 const blocked = !!busy || unavailable || !snapshot || snapshot.syncing || snapshot.recoveryRequired;
 const begin = (kind: 'test' | 'control') => {
  if (active.current) return null;
  active.current = kind; setBusy(kind); setError(null);
  ++statusSequence.current; statusRequest.current?.abort(); operation.current?.abort();
  const controller = new AbortController(); operation.current = controller;
  return { controller, version: ++sequence.current };
 };
 const current = (request: { controller: AbortController; version: number }) => mounted.current && sequence.current === request.version && !request.controller.signal.aborted;
 const finish = (request: { controller: AbortController; version: number }) => {
  if (current(request)) { active.current = null; setBusy(null); }
 };
 const handleFailure = async (failure: unknown, request: { controller: AbortController; version: number }) => {
  if (!current(request)) return;
  const code = failure instanceof DirectSmbApiError ? failure.code : 'transport-unavailable';
  setError(notice(code));
  if (['receipt-expired', 'stale-generation', 'identity-changed', 'invalid-preview'].includes(code)) invalidateReview();
  if (code === 'recovery-required' && failure instanceof DirectSmbApiError && failure.status === 503) setUnavailable(true);
  if (['stale-generation', 'destination-busy', 'recovery-required'].includes(code)) {
   setUnavailable(true);
   finish(request); await refresh();
  }
 };
 const test = async () => {
  if (blocked) return;
  const request = begin('test'); if (!request) return;
  invalidateReview();
  try {
   const next = await directSmbApi.test(endpoint, credentialMemory.current, request.controller.signal);
   if (current(request)) setReview(next);
  } catch (failure) { await handleFailure(failure, request); }
  finally { finish(request); }
 };
 const run = async (action: (signal: AbortSignal) => Promise<DirectSmbSnapshot>, recovery = false, connected = false) => {
  if (busy || unavailable || !snapshot || snapshot.syncing || (snapshot.recoveryRequired && !recovery)) return;
  const request = begin('control'); if (!request) return;
  try {
   const next = await action(request.controller.signal);
   if (!current(request)) return;
   setSnapshot(next); setUnavailable(false);
   if (connected) { invalidateReview(); clearCredentials(); setTarget(undefined); }
   onProviderChanged?.();
  } catch (failure) { await handleFailure(failure, request); }
  finally { finish(request); }
 };
 const connect = () => {
  if (!review) return;
  if (review.expiresAt <= Date.now()) { invalidateReview(); setError(notice('receipt-expired')); return; }
  if (review.needsCreation && !create) return;
  void run(signal => directSmbApi.connect(name, review.receipt, create, target, signal), false, true);
 };
 const cancel = () => {
  if (active.current === 'control') return;
  ++sequence.current; operation.current?.abort(); active.current = null; setBusy(null);
  invalidateReview(); clearCredentials(); setTarget(undefined); setError(null);
 };
 const retest = (connection: DirectSmbConnection) => {
  if (blocked) return;
  invalidateReview(); clearCredentials(); setError(null); setName(connection.name);
  setEndpoint({ ...connection.endpoint }); setTarget({ id: connection.id, generation: connection.generation });
 };
 const updateEndpoint = (changes: Partial<DirectSmbEndpoint>) => { setEndpoint(previous => ({ ...previous, ...changes })); invalidateReview(); };
 const updateCredentials = (changes: Partial<typeof credentials>) => { setCredentials(previous => ({ ...previous, ...changes })); invalidateReview(); };
 return <article className={styles.card} aria-labelledby="direct-smb-title">
  <h2 id="direct-smb-title">{tr('Direct SMB connection')}</h2>
  <p>{tr('Connect directly with an SMB account. Use the mounted option above for macOS mounts and read-only imports.')}</p>
  <p>{tr('Credentials stay in this review only. Connecting saves them in the macOS credential vault; cancel clears this form.')}</p>
  <p>{tr('Testing verifies access and destination safety. It does not publish meetings or confirm replication.')}</p>
  {!snapshot && !error && <p role="status">{tr('Checking direct connections…')}</p>}
  {error && <p role="alert" className={styles.error}>{tr(error)}</p>}
  {snapshot?.recoveryRequired && <p role="status">{tr(notice('recovery-required'))}</p>}
  {snapshot?.syncing && <p role="status">{tr('A direct synchronization operation is running. Wait before changing connections.')}</p>}
  <button disabled={!!busy} onClick={() => void refresh()}>{tr('Refresh direct status')}</button>
  <form onSubmit={event => { event.preventDefault(); void test(); }} autoComplete="off">
   <label htmlFor="direct-smb-name">{tr('Direct destination name')}</label>
   <input id="direct-smb-name" value={name} maxLength={120} disabled={blocked} onChange={event => setName(event.target.value)}/>
   <label htmlFor="direct-smb-server">{tr('Server')}</label>
   <input id="direct-smb-server" value={endpoint.server} maxLength={253} disabled={blocked} onChange={event => updateEndpoint({ server: event.target.value })}/>
   <label htmlFor="direct-smb-port">{tr('Port')}</label>
   <input id="direct-smb-port" type="number" min={1} max={65535} value={Number.isNaN(endpoint.port) ? '' : endpoint.port} disabled={blocked} onChange={event => updateEndpoint({ port: event.target.valueAsNumber })}/>
   <p>{tr('Use port 445. Alternate ports 48000–48999 are available only on localhost or 127.0.0.1.')}</p>
   <label htmlFor="direct-smb-share">{tr('Share')}</label>
   <input id="direct-smb-share" value={endpoint.share} maxLength={255} disabled={blocked} onChange={event => updateEndpoint({ share: event.target.value })}/>
   <label htmlFor="direct-smb-folder">{tr('Folder')}</label>
   <input id="direct-smb-folder" value={endpoint.folder} maxLength={512} disabled={blocked} onChange={event => updateEndpoint({ folder: event.target.value })}/>
   <label htmlFor="direct-smb-domain">{tr('Domain')}</label>
   <input id="direct-smb-domain" value={credentials.domain} maxLength={255} disabled={blocked} autoComplete="off" onChange={event => updateCredentials({ domain: event.target.value })}/>
   <label htmlFor="direct-smb-account">{tr('Account')}</label>
   <input id="direct-smb-account" value={credentials.username} maxLength={255} disabled={blocked} autoComplete="off" onChange={event => updateCredentials({ username: event.target.value })}/>
   <label htmlFor="direct-smb-password">{tr('Password')}</label>
   <input id="direct-smb-password" type="password" value={credentials.password} maxLength={1024} disabled={blocked} autoComplete="new-password" onChange={event => updateCredentials({ password: event.target.value })}/>
   <label><input type="checkbox" checked={endpoint.requireEncryption} disabled={blocked} onChange={event => updateEndpoint({ requireEncryption: event.target.checked })}/>{tr('Require SMB encryption')}</label>
   <button type="submit" disabled={blocked || !endpoint.server || !endpoint.share || !credentials.username || !credentials.password}>{tr('Test direct connection')}</button>
   <button type="button" disabled={busy === 'control'} onClick={cancel}>{tr('Cancel direct review')}</button>
  </form>
  {busy === 'test' && <p role="status">{tr('Testing direct connection…')}</p>}
  {review && <section aria-label={tr('Direct connection review')}>
   <h3>{tr('Direct connection review')}</h3>
   <p>{tr('Authentication verified')}</p><p>{review.capabilities.dialect}</p>
   <p>{tr(review.capabilities.encrypted ? 'SMB encryption verified' : 'SMB signing verified')}</p>
   <p>{tr('Read/write access verified; direct coordination requires write access.')}</p>
   <p>{tr('Namespace safety verified')}</p>
   <p>{tr(review.needsCreation ? 'The selected folder is empty. Creation requires your confirmation.' : 'Existing destination verified. No library will be created.')}</p>
   {review.needsCreation && <label><input type="checkbox" checked={create} disabled={blocked} onChange={event => setCreate(event.target.checked)}/>{tr('Create a Heed Library in this verified empty folder')}</label>}
   <button disabled={blocked || !name.trim() || (review.needsCreation && !create)} onClick={connect}>{tr('Connect reviewed destination')}</button>
  </section>}
  <p>{tr('Pending revisions and errors are not publication acknowledgment. Share readback does not prove survival of server power loss.')}</p>
  {snapshot?.connections.map(connection => <section key={connection.id} role="region" aria-label={connection.name}>
   <h3>{connection.name}</h3>
   <p>{connection.endpoint.server}:{connection.endpoint.port} / {connection.endpoint.share}{connection.endpoint.folder && ` / ${connection.endpoint.folder}`}</p>
   <p>{tr(connection.enabled ? 'Direct destination enabled' : 'Direct destination disabled')}</p>
   <p>{tr('Imported: {imported}; skipped: {skipped}; pending: {pending}.', { imported: connection.progress.imported, skipped: connection.progress.skipped, pending: connection.progress.pending })}</p>
   {connection.error && <p role="alert">{tr(notice(connection.error.code))}</p>}
   <label htmlFor={`direct-smb-rename-${connection.id}`}>{tr('Rename direct destination')}</label>
   <input id={`direct-smb-rename-${connection.id}`} maxLength={120} disabled={blocked} value={edits[connection.id] ?? connection.name} onChange={event => setEdits(previous => ({ ...previous, [connection.id]: event.target.value }))}/>
   <button disabled={blocked || !(edits[connection.id] ?? connection.name).trim()} onClick={() => void run(signal => directSmbApi.rename(connection.id, connection.generation, edits[connection.id] ?? connection.name, signal))}>{tr('Save direct name')}</button>
   <button disabled={blocked} onClick={() => void run(signal => directSmbApi.enable(connection.id, connection.generation, !connection.enabled, signal))}>{tr(connection.enabled ? 'Disable direct destination' : 'Enable direct destination')}</button>
   <button disabled={blocked} onClick={() => retest(connection)}>{tr('Retest direct destination')}</button>
   {snapshot.recoveryRequired ? <button disabled={!!busy || unavailable || snapshot.syncing} onClick={() => void run(signal => directSmbApi.sync(connection.id, connection.generation, signal), true)}>{tr('Recover original direct operation')}</button> : <button disabled={blocked || !connection.enabled} onClick={() => void run(signal => directSmbApi.sync(connection.id, connection.generation, signal))}>{tr('Synchronize direct destination')}</button>}
   <button disabled={blocked} onClick={() => void run(signal => directSmbApi.disconnect(connection.id, connection.generation, signal))}>{tr('Disconnect direct destination')}</button>
  </section>)}
 </article>;
}
