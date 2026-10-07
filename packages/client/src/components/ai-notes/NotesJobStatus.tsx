import { useState } from 'react';
import type { Session, NotesJob } from '@heed/shared';
import { automaticNotesApi } from '@/api/automaticNotes';
import { aiWaitingMessage } from '@/lib/ai-waiting';
import { useLocale } from '@/lib/i18n';
import styles from './AutomaticNotes.module.css';
const labels = {
 queued: 'Automatic notes queued', waiting: 'Automatic notes waiting', running: 'Generating automatic notes', completed: 'Automatic notes ready', failed: 'Automatic notes failed', cancelled: 'Automatic notes cancelled', superseded: 'Automatic notes superseded',
};
const reasons: Record<string, string> = {
 'resources-busy': 'Waiting for recording, transcription or local AI resources.',
 disabled: 'Automatic notes are disabled.',
 'ollama-unavailable': 'Local notes model unavailable. Start Ollama and retry.',
 'generation-timeout': 'Notes generation timed out. Please retry.',
 'local-only': 'Choose a local notes model. Cloud models are not supported.',
 'template-missing': 'Notes template is no longer available.',
 'notes-changed': 'Notes changed. Previous generation was discarded.',
 'generation-failed': 'Notes generation failed. Please retry.',
 'incomplete-output': 'Notes generation was incomplete. Please retry.',
 'capture-active': 'Waiting for recording to finish.', 'transcription-active': 'Waiting for transcription to finish.',
 'model-unavailable': 'Local notes model unavailable. Start Ollama and retry.', 'model-missing': 'Local notes model is no longer installed.',
 'existing-notes': 'Existing notes kept. Confirm replacement to generate new notes.', 'transcript-changed': 'Transcript changed. Previous generation was discarded.',
 cancelled: 'Cancelled by you.', interrupted: 'Generation interrupted. Retry when ready.',
};
export function currentNotesJob(session: Session): NotesJob | undefined { return session.transcriptRevision ? Object.values(session.notesJobs || {}).find(job => job.sourceRevision === session.transcriptRevision) : undefined; }
export function automaticNotesBusy(session?: Session | null): boolean { const job = session && currentNotesJob(session); return !!job && ['queued', 'waiting', 'running'].includes(job.status); }
export const replacementPrompt = 'Replace existing notes? Your current notes will be replaced after successful generation.';
export function NotesJobStatus({ session, compact = false }: { session: Session; compact?: boolean }) {
 const { tr } = useLocale();
 const [busy, setBusy] = useState(false);
 const [error, setError] = useState(false);
 const job = currentNotesJob(session);
 const metadata = session.notesMetadata;
 const unknown = !!metadata && metadata.sourceRevision === null;
 const stale = !!metadata && (metadata.stale || metadata.sourceRevision !== session.transcriptRevision);
 if (!job && !metadata) return null;
 const control = async (action: 'cancel' | 'retry') => {
  const replace = action === 'retry' && !!session.aiNotes;
  if (replace && !window.confirm(tr(replacementPrompt))) return;
  setBusy(true); setError(false);
  try {
   await automaticNotesApi.control({ sessionId: session.id, jobId: job!.id, action, ...(replace ? { replaceExisting: true as const, expectedNotes: session.aiNotes } : {}) });
  } catch { setError(true); }
  finally { setBusy(false); }
 };
 const waiting = job && ['queued', 'waiting'].includes(job.status);
 const reason = waiting && job.waitingReason ? aiWaitingMessage(job.waitingReason) : job?.reason ? reasons[job.reason] || 'Automatic notes need attention.' : waiting ? aiWaitingMessage() : undefined;
 const source = metadata ? metadata.sourceRevision : job?.sourceRevision;
 const provenance = metadata?.origin === 'automatic' ? metadata : job;
 return <div className={compact ? styles.compact : styles.status}>
  {job && <div role="status">{tr(labels[job.status])}{job.status === 'running' && !compact && <span> · {tr('{count} characters generated', { count: job.generatedCharacters })}</span>}</div>}
  {reason && <p>{tr(reason)}</p>}
  {unknown ? <p>{tr('Notes source is unknown. Regenerate notes to verify the current transcript.')}</p> : stale && <p>{tr('Notes are stale: the transcript or speakers changed.')}</p>}
  {!compact && <>

   {provenance && <p className={styles.provenance}>{[provenance.model, provenance.templateName ? tr(provenance.templateName) : undefined, provenance.language].filter(Boolean).join(' · ')}</p>}
   {source && <p className={styles.provenance} title={source}>{tr('Transcript revision: {revision}', { revision: source.slice(0, 8) })}</p>}
   {metadata?.origin === 'manual' && <p>{tr('Manual notes')}</p>}
   {job && <div className={styles.actions}>
    {automaticNotesBusy(session) && <button disabled={busy} onClick={() => void control('cancel')}>{tr('Cancel automatic notes')}</button>}
    {job.retryable && ['failed', 'cancelled', 'completed'].includes(job.status) && <button disabled={busy} onClick={() => void control('retry')}>{tr(session.aiNotes ? 'Replace existing notes' : 'Retry automatic notes')}</button>}
   </div>}
   {error && <p role="alert">{tr('Could not update automatic notes. Refresh the meeting and retry.')}</p>}
  </>}
 </div>;
}
