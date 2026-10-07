import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { NotesJob, Session } from '@heed/shared';
import { NotesJobStatus } from './NotesJobStatus';
import { setLocale } from '@/lib/i18n';
const job = { id: 'job', sourceRevision: 'r1', status: 'running', templateId: 'general', templateName: 'General', model: 'local:latest', language: 'pt', generatedCharacters: 24, retryable: true } as NotesJob;
const session = { id: 's', transcriptRevision: 'r1', aiNotes: '', notesJobs: { 'notes-r1': job } } as unknown as Session;
const fetchMock = vi.fn(async () => Response.json(session));
beforeEach(() => { setLocale('en'); vi.stubGlobal('fetch', fetchMock); fetchMock.mockClear(); });
afterEach(() => vi.unstubAllGlobals());
test('shows actual character progress and cancels the current job', async () => {
 render(<NotesJobStatus session={session} />);
 expect(screen.getByRole('status')).toHaveTextContent('24 characters generated');
 fireEvent.click(screen.getByRole('button', { name: 'Cancel automatic notes' }));
 await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/notes/jobs', expect.objectContaining({ body: JSON.stringify({ sessionId: 's', jobId: 'job', action: 'cancel' }) })));
});
test('replacement requires confirmation and sends the exact current notes', async () => {
 const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValue(true);
 render(<NotesJobStatus session={{ ...session, aiNotes: 'My edits', notesJobs: { 'notes-r1': { ...job, status: 'failed' } } }} />);
 fireEvent.click(screen.getByRole('button', { name: 'Replace existing notes' }));
 expect(fetchMock).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('button', { name: 'Replace existing notes' }));
 await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/notes/jobs', expect.objectContaining({ body: JSON.stringify({ sessionId: 's', jobId: 'job', action: 'retry', replaceExisting: true, expectedNotes: 'My edits' }) })));
 expect(confirm).toHaveBeenCalledTimes(2); confirm.mockRestore();
});
test('renders translated stale provenance without offering obsolete retries', () => {
 setLocale('pt-BR');
 render(<NotesJobStatus session={{ ...session, transcriptRevision: 'r2', notesMetadata: { origin: 'automatic', sourceRevision: 'r1', stale: true, model: 'local:latest', templateName: 'General', language: 'pt' } }} />);
 expect(screen.getByText('Notas desatualizadas: a transcrição ou os participantes mudaram.')).toBeInTheDocument();
 expect(screen.queryByRole('button', { name: 'Retry automatic notes' })).not.toBeInTheDocument();
 expect(screen.getByText(/local:latest/)).toBeInTheDocument();
});
test('identifies the source transcript revision for manual notes without implying generation', () => {
 render(<NotesJobStatus session={{ ...session, transcriptRevision: 'revision-current-123', notesJobs: {}, notesMetadata: { origin: 'manual', sourceRevision: 'revision-source-456', stale: true } }} />);
 expect(screen.getByText('Manual notes')).toBeInTheDocument();
 expect(screen.getByText('Transcript revision: revision')).toHaveAttribute('title', 'revision-source-456');
 expect(screen.queryByText('Manually generated notes')).not.toBeInTheDocument();
});


test('waiting notes identify changing AI blockers with a truthful legacy fallback', () => {
 const waiting={...job,status:'waiting' as const,reason:'resources-busy' as const,waitingReason:'tasks' as const};
 const view=render(<NotesJobStatus session={{...session,transcriptFinalized:true,notesJobs:{'notes-r1':waiting}}}/>);
 expect(screen.getByText('Waiting for task suggestions to finish.')).toBeInTheDocument();
 view.rerender(<NotesJobStatus session={{...session,notesJobs:{'notes-r1':{...waiting,waitingReason:'transcription' as const}}}}/>);
 expect(screen.getByText('Waiting for transcription to finish.')).toBeInTheDocument();
 expect(screen.queryByText('Waiting for task suggestions to finish.')).not.toBeInTheDocument();
 view.rerender(<NotesJobStatus session={{...session,notesJobs:{'notes-r1':{...waiting,waitingReason:undefined}}}}/>);
 expect(screen.getByText('Waiting for recording, transcription or local AI resources.')).toBeInTheDocument();
 expect(screen.getByRole('button',{name:'Cancel automatic notes'})).toBeEnabled();
});

test('queued notes show the queue reason before another job starts', () => {
 render(<NotesJobStatus session={{...session,notesJobs:{'notes-r1':{...job,status:'queued',waitingReason:'queued'}}}}/>);
 expect(screen.getByText('Waiting for local AI resources.')).toBeInTheDocument();
});
