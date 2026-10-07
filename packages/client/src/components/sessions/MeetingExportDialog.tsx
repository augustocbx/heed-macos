import { useEffect, useRef, useState } from 'react';
import type { MeetingExportFormat, MeetingExportPreview, MeetingExportSelection, Session, TaskView, TranscriptGuard } from '@heed/shared';
import { useSessionsStore } from '@/stores/sessions';
import { guardForSession } from '@/lib/acceptedSession';
import { meetingExportApi } from '@/api/meeting-export';
import { tasksApi } from '@/api/tasks';
import { Dialog } from '@/components/layout/Dialog';
import { tr, useLocale } from '@/lib/i18n';
import { buildExportBlocks } from '@/lib/export/content';
import { startMeetingExport, type MeetingExportArtifact } from '@/lib/export/worker';
import { downloadMeetingExport } from '@/lib/export/download';
import styles from './MeetingExportDialog.module.css';

// Keep export feedback localized while the shared guard validates displayed tokens.
function exportGuard(session: Session): TranscriptGuard {
 try { return guardForSession(session); }
 catch { throw Error('Refresh the meeting before exporting.'); }
}
type Stage = 'choosing' | 'previewing' | 'review-ready' | 'validating' | 'generating' | 'completed';
function errorText(error: unknown): string {
 const status = (error as { status?: number })?.status;
 if (status === 409) return tr('Content changed. Preview and review it again.');
 if (status === 413) return tr('Export exceeds the size limit. Choose a smaller scope.');
 const message = error instanceof Error ? error.message : 'Could not generate export. Try again.';
 const glyph = /^PDF font does not support (.+)\. Use UTF-8 text export for these characters\.$/.exec(message);
 return glyph ? tr('PDF does not support these characters: {characters}. Use text export.', undefined, { characters: glyph[1]! }) : tr(message);
}
const initialSelection: MeetingExportSelection = { transcript: true, notes: false, taskIds: [], speakers: true, timestamps: true };

export function MeetingExportDialog({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
 useLocale();
 const session = useSessionsStore(state => state.sessions.find(item => item.id === sessionId));
 const [format, setFormat] = useState<MeetingExportFormat>('pdf'), formatRef = useRef(format); formatRef.current = format;
 const [selection, setSelection] = useState<MeetingExportSelection>({ ...initialSelection });
 const [tasks, setTasks] = useState<TaskView[]>([]), [tasksLoading, setTasksLoading] = useState(true);
 const [preview, setPreview] = useState<MeetingExportPreview | null>(null), [stage, setStage] = useState<Stage>('choosing');
 const [error, setError] = useState(''), [notesReviewed, setNotesReviewed] = useState(false), [tasksReviewed, setTasksReviewed] = useState(false), [staleReviewed, setStaleReviewed] = useState(false);
 const [artifact, setArtifact] = useState<MeetingExportArtifact | null>(null);
 const sequence = useRef(0), active = useRef<ReturnType<typeof startMeetingExport> | null>(null), cleanupDownload = useRef<(() => void) | null>(null);
 function release(): void { active.current?.cancel(); active.current = null; cleanupDownload.current?.(); cleanupDownload.current = null; }
 function resetReview(): void { setNotesReviewed(false); setTasksReviewed(false); setStaleReviewed(false); }
 function invalidate(): void { ++sequence.current; release(); setPreview(null); setArtifact(null); resetReview(); setStage('choosing'); setError(''); }
 async function refreshCurrent(token: number): Promise<void> {
  await useSessionsStore.getState().load(true);
  if (token !== sequence.current) return;
  try {
   const snapshot = await tasksApi.list(sessionId);
   if (token !== sequence.current) return;
   const accepted = snapshot.tasks.filter(task => task.sessionId === sessionId && task.sourceState !== 'meeting-deleted' && ['open', 'completed'].includes(task.status));
   setTasks(accepted); setSelection(current => ({ ...current, taskIds: current.taskIds.filter(id => accepted.some(task => task.id === id)) }));
  } catch { /* The existing accurate conflict remains visible; the user can reopen to retry task discovery. */ }
 }
 useEffect(() => {
  let alive = true;
  tasksApi.list(sessionId).then(snapshot => {
   if (!alive) return;
   const accepted = snapshot.tasks.filter(task => task.sessionId === sessionId && task.sourceState !== 'meeting-deleted' && ['open', 'completed'].includes(task.status));
   setTasks(accepted); if (formatRef.current === 'pdf') setSelection(current => ({ ...current, taskIds: accepted.map(task => task.id) }));
  }).catch(() => { if (alive) setError(tr('Could not load tasks. Reopen the export dialog.')); }).finally(() => { if (alive) setTasksLoading(false); });
  return () => { alive = false; ++sequence.current; release(); };
 }, [sessionId]);
 useEffect(() => { if (!session) { ++sequence.current; release(); setArtifact(null); setStage('choosing'); } }, [!!session]);
 function changeScope(patch: Partial<MeetingExportSelection>): void {
  invalidate(); setSelection(current => { const next = { ...current, ...patch }; return next.transcript ? next : { ...next, speakers: false, timestamps: false }; });
 }
 function changeFormat(next: MeetingExportFormat): void {
  invalidate(); setFormat(next);
  if (next !== 'pdf') setSelection(current => ({ ...current, transcript: true, notes: false, taskIds: [], timestamps: true }));
 }
 async function makePreview(): Promise<void> {
  if (!session) return;
  const token = ++sequence.current; release(); setArtifact(null); setPreview(null); resetReview(); setError(''); setStage('previewing');
  try {
   const next = await meetingExportApi.preview(sessionId, { ...exportGuard(session), format, selection });
   if (token !== sequence.current) return;
   buildExportBlocks(next); // Invalid presentation data becomes retryable feedback, never a render crash.
   setPreview(next); setStage('review-ready');
  } catch (failure) {
   if (token !== sequence.current) return; setError(errorText(failure)); setStage('choosing');
   if ((failure as { status?: number }).status === 409 || (failure as { status?: number }).status === 404) await refreshCurrent(token);
  }
 }
 async function generate(): Promise<void> {
  if (!preview) return;
  const token = ++sequence.current; release(); setArtifact(null); setError(''); setStage('validating');
  const frozen = structuredClone(preview);
  try {
   await meetingExportApi.validate(sessionId, { expectedTranscriptRevision: frozen.snapshot.sourceRevision, expectedTranscriptVersion: frozen.snapshot.sourceVersion,
    format: frozen.format, selection: { ...frozen.selection, ...(notesReviewed ? { reviewedNotesHash: frozen.review.notesHash } : {}), ...(tasksReviewed ? { reviewedTaskRevisions: frozen.review.taskRevisions } : {}) },
    snapshotKey: frozen.snapshot.snapshotKey, ...(staleReviewed ? { staleAcknowledgmentKey: frozen.review.staleContentKey } : {}) });
   if (token !== sequence.current) return;
   setStage('generating'); const job = startMeetingExport(frozen); active.current = job;
   const completed = await job.result;
   if (token !== sequence.current) return;
   active.current = null; setArtifact(completed); setStage('completed');
  } catch (failure) {
   if (token !== sequence.current) return;
   active.current = null; setError(errorText(failure));
   if ((failure as { status?: number }).status === 409 || (failure as { status?: number }).status === 404) {
    setPreview(null); resetReview(); setStage('choosing'); await refreshCurrent(token);
   } else setStage('review-ready');
  }
 }
 const requiredTasks = preview ? Object.keys(preview.review.taskRevisions).length > 0 : false;
 const reviewed = !!preview && (!preview.review.notesHash || notesReviewed) && (!requiredTasks || tasksReviewed) && (!preview.review.staleContentKey || staleReviewed);
 const busy = ['previewing', 'validating', 'generating'].includes(stage);
 function close(): void { ++sequence.current; release(); onClose(); }
 return <Dialog label={tr('Export PDF or subtitles')} onClose={close} className={styles.dialog}>
  <h2>{tr('Export PDF or subtitles')}</h2>
  <p className={styles.hint}>{tr('Choose content, review the preview, then generate and save a local file.')}</p>
  {!session || session.transcriptFinalized !== true ? <p role="alert">{tr(session ? 'Save a finalized meeting before exporting.' : 'This meeting is no longer available.')}</p> : <>
   <label className={styles.format}>{tr('Export format')}<select value={format} onChange={event => changeFormat(event.target.value as MeetingExportFormat)}><option value="pdf">PDF</option><option value="srt">SRT</option><option value="vtt">VTT</option></select></label>
   <fieldset><legend>{tr('Content scope')}</legend>
    <label><input type="checkbox" checked={selection.transcript} disabled={format !== 'pdf'} onChange={event => changeScope({ transcript: event.target.checked })} />{tr('Transcript')}</label>
    <label><input type="checkbox" checked={selection.notes} disabled={format !== 'pdf' || (!session.aiNotes.trim() && !selection.notes)} onChange={event => changeScope({ notes: event.target.checked })} />{tr('Notes')}</label>
    <label><input type="checkbox" checked={selection.speakers} disabled={!selection.transcript} onChange={event => changeScope({ speakers: event.target.checked })} />{tr('Speaker labels')}</label>
    <label><input type="checkbox" checked={selection.timestamps} disabled={!selection.transcript || format !== 'pdf'} onChange={event => changeScope({ timestamps: event.target.checked })} />{tr('Timestamps')}</label>
    {format === 'pdf' && tasks.map(task => <label key={task.id}><input type="checkbox" checked={selection.taskIds.includes(task.id)} onChange={event => changeScope({ taskIds: event.target.checked ? [...selection.taskIds, task.id] : selection.taskIds.filter(id => id !== task.id) })} />{task.title} <span className={styles.hint}>({tr(task.status === 'completed' ? 'Completed' : 'Open')})</span></label>)}
   </fieldset>
   {format !== 'pdf' && !session.segments.some(segment => segment.text.trim()) && <p>{tr('This meeting has no timed transcript. Choose PDF instead.')}</p>}
   <button type="button" disabled={tasksLoading || busy} onClick={() => void makePreview()}>{stage === 'previewing' ? tr('Preparing preview...') : tr('Preview selected content')}</button>
   {preview && <section aria-label={tr('Export preview')} className={styles.preview}>
    <p className={styles.hint}>{tr('Frozen source version {version}, generated {date}', undefined, { version: preview.snapshot.sourceVersion, date: preview.snapshot.generatedAt })}</p>
    {buildExportBlocks(preview).map((block, index) => block.kind === 'heading' ? <h3 key={index}>{index === 0 ? block.text : tr(block.text)}</h3> : <pre key={index} className={block.kind === 'provenance' ? styles.provenance : undefined}>{block.text}</pre>)}
    {preview.snapshot.warnings.map(warning => <p key={warning}>{tr({ 'notes-stale': 'Selected notes use an earlier source.', 'notes-source-unknown': 'Selected notes have unknown source provenance.', 'tasks-stale': 'Selected tasks use an earlier source.', 'subtitle-overlap': 'Subtitle cues overlap; timing is preserved.', 'subtitle-long-cue': 'Some subtitles are long or dense; segment timing is preserved.' }[warning])}</p>)}
    {preview.review.notesHash && <label><input type="checkbox" checked={notesReviewed} disabled={busy || stage === 'completed'} onChange={event => setNotesReviewed(event.target.checked)} />{tr('I reviewed these notes')}</label>}
    {requiredTasks && <label><input type="checkbox" checked={tasksReviewed} disabled={busy || stage === 'completed'} onChange={event => setTasksReviewed(event.target.checked)} />{tr('I reviewed the selected tasks')}</label>}
    {preview.review.staleContentKey && <label><input type="checkbox" checked={staleReviewed} disabled={busy || stage === 'completed'} onChange={event => setStaleReviewed(event.target.checked)} />{tr('I understand the selected content may be outdated')}</label>}
   </section>}
   {error && <p role="alert" className={styles.error}>{error}</p>}
   {busy && <p role="status">{tr(stage === 'generating' ? 'Generating export...' : stage === 'validating' ? 'Checking current content...' : 'Preparing preview...')}</p>}
   <div className={styles.actions}>
    {busy ? <button type="button" onClick={() => { ++sequence.current; release(); setStage(preview ? 'review-ready' : 'choosing'); }}>{tr('Cancel generation')}</button>
     : preview && !artifact && <button type="button" disabled={!reviewed} onClick={() => void generate()}>{tr('Generate export')}</button>}
    {artifact && <button type="button" onClick={() => { try { cleanupDownload.current?.(); cleanupDownload.current = downloadMeetingExport(artifact, preview!.snapshot.title); } catch (failure) { setError(errorText(failure)); } }}>{tr('Save export')}</button>}
   </div>
  </>}
  <div className={styles.actions}><button type="button" onClick={close}>{tr('Close')}</button></div>
 </Dialog>;
}
