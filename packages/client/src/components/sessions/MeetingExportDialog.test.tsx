import { beforeEach, expect, test, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MeetingExportDialog } from './MeetingExportDialog';
import { useSessionsStore } from '@/stores/sessions';
import { exportPreview } from '@/lib/export/fixtures.test-support';
import { useLocaleStore } from '@/stores/locale';
import type { Session } from '@heed/shared';
const mocks = vi.hoisted(() => ({ preview: vi.fn(), validate: vi.fn(), tasks: vi.fn(), start: vi.fn(), download: vi.fn(), load: vi.fn() }));
vi.mock('@/api/meeting-export', () => ({ meetingExportApi: { preview: mocks.preview, validate: mocks.validate } }));
vi.mock('@/api/tasks', () => ({ tasksApi: { list: mocks.tasks } }));
vi.mock('@/lib/export/worker', () => ({ startMeetingExport: mocks.start }));
vi.mock('@/lib/export/download', () => ({ downloadMeetingExport: mocks.download }));
const session = (): Session => ({ id: 'meeting', title: 'Reunião', createdAt: '2026-10-07', duration: 4, language: 'pt', transcript: 'Ação', segments: [{ speaker: 'Ana', start: 0, end: 4, text: 'Ação' }], speakers: ['Ana'], aiNotes: 'Notes', summary: '', tags: [], pinned: false, transcriptFinalized: true, transcriptRevision: 'a'.repeat(64), transcriptVersion: 3 });
beforeEach(() => {
 vi.clearAllMocks(); useLocaleStore.setState({ locale: 'en' }); useSessionsStore.setState({ sessions: [session()], load: mocks.load });
 mocks.tasks.mockResolvedValue({ tasks: [] }); mocks.preview.mockResolvedValue(exportPreview()); mocks.validate.mockResolvedValue({ valid: true, snapshotKey: 'snapshot' });
 mocks.start.mockReturnValue({ result: Promise.resolve({ bytes: new Uint8Array([1]), mime: 'application/pdf', extension: 'pdf', snapshotKey: 'snapshot' }), cancel: vi.fn() }); mocks.download.mockReturnValue(vi.fn());
});
test('previews literal content, binds notes/tasks/stale review and generates before separate Save', async () => {
 render(<MeetingExportDialog sessionId="meeting" onClose={vi.fn()} />);
 await waitFor(() => expect(screen.getByRole('button', { name: 'Preview selected content' })).toBeEnabled());
 fireEvent.click(screen.getByRole('checkbox', { name: 'Notes' })); fireEvent.click(screen.getByRole('button', { name: 'Preview selected content' }));
 expect(await screen.findByText((_text, element) => element?.tagName === 'PRE' && element.textContent === '<b>Plain notes</b>\nNo remote image')).toBeVisible();
 expect(screen.getByRole('button', { name: 'Generate export' })).toBeDisabled(); expect(mocks.download).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('checkbox', { name: 'I reviewed these notes' })); fireEvent.click(screen.getByRole('checkbox', { name: 'I reviewed the selected tasks' })); fireEvent.click(screen.getByRole('checkbox', { name: 'I understand the selected content may be outdated' }));
 fireEvent.click(screen.getByRole('button', { name: 'Generate export' })); await screen.findByRole('button', { name: 'Save export' });
 expect(mocks.validate).toHaveBeenCalledWith('meeting', expect.objectContaining({ snapshotKey: 'snapshot', expectedTranscriptVersion: 3, staleAcknowledgmentKey: 'stale', selection: expect.objectContaining({ reviewedNotesHash: 'notes', reviewedTaskRevisions: { task: 'r1' } }) }));
 expect(mocks.start).toHaveBeenCalledWith(exportPreview()); expect(mocks.download).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('button', { name: 'Save export' })); expect(mocks.download).toHaveBeenCalledTimes(1);
});
test('subtitle selection is forced transcript-only and changing scope invalidates review/artifact', async () => {
 render(<MeetingExportDialog sessionId="meeting" onClose={vi.fn()} />); await waitFor(() => expect(mocks.tasks).toHaveBeenCalled());
 fireEvent.change(screen.getByRole('combobox', { name: 'Export format' }), { target: { value: 'vtt' } });
 expect(screen.getByRole('checkbox', { name: 'Transcript' })).toBeChecked(); expect(screen.getByRole('checkbox', { name: 'Transcript' })).toBeDisabled();
 expect(screen.getByRole('checkbox', { name: 'Notes' })).toBeDisabled(); expect(screen.getByRole('checkbox', { name: 'Timestamps' })).toBeChecked();
 fireEvent.click(screen.getByRole('button', { name: 'Preview selected content' })); await screen.findByRole('region', { name: 'Export preview' });
 fireEvent.change(screen.getByRole('combobox', { name: 'Export format' }), { target: { value: 'pdf' } });
 expect(screen.queryByRole('button', { name: 'Generate export' })).not.toBeInTheDocument(); expect(screen.queryByRole('button', { name: 'Save export' })).not.toBeInTheDocument();
});
test('conflict refreshes accepted source and requires fresh review, preserving chosen scope', async () => {
 const p = exportPreview(); p.review = { taskRevisions: {} }; p.selection = { transcript: true, notes: false, taskIds: [], speakers: true, timestamps: true }; p.snapshot.notes = undefined; p.snapshot.tasks = []; p.snapshot.warnings = [];
 mocks.preview.mockResolvedValue(p); mocks.validate.mockRejectedValue(Object.assign(new Error('Conflict'), { status: 409 }));
 render(<MeetingExportDialog sessionId="meeting" onClose={vi.fn()} />); await waitFor(() => expect(screen.getByRole('button', { name: 'Preview selected content' })).toBeEnabled());
 fireEvent.click(screen.getByRole('button', { name: 'Preview selected content' })); fireEvent.click(await screen.findByRole('button', { name: 'Generate export' }));
 expect(await screen.findByRole('alert')).toHaveTextContent('Content changed'); expect(mocks.load).toHaveBeenCalledWith(true); expect(mocks.start).not.toHaveBeenCalled();
 expect(screen.getByRole('checkbox', { name: 'Transcript' })).toBeChecked(); expect(screen.queryByRole('button', { name: 'Generate export' })).not.toBeInTheDocument();
});
test('cancel and close terminate owned work; a late result never offers a stale download', async () => {
 const p = exportPreview(); p.review = { taskRevisions: {} }; p.selection = { transcript: true, notes: false, taskIds: [], speakers: true, timestamps: true };
 let resolve!: (value: unknown) => void; const pending = new Promise(resolvePromise => { resolve = resolvePromise; }); const cancel = vi.fn(); mocks.start.mockReturnValue({ result: pending, cancel }); mocks.preview.mockResolvedValue(p);
 const close = vi.fn(); const rendered = render(<MeetingExportDialog sessionId="meeting" onClose={close} />); await waitFor(() => expect(screen.getByRole('button', { name: 'Preview selected content' })).toBeEnabled());
 fireEvent.click(screen.getByRole('button', { name: 'Preview selected content' })); fireEvent.click(await screen.findByRole('button', { name: 'Generate export' }));
 await waitFor(() => expect(mocks.start).toHaveBeenCalled()); fireEvent.click(screen.getByRole('button', { name: 'Cancel generation' })); expect(cancel).toHaveBeenCalledTimes(1);
 await act(async () => resolve({ bytes: new Uint8Array([1]), mime: 'application/pdf', extension: 'pdf', snapshotKey: 'snapshot' }));
 expect(screen.queryByRole('button', { name: 'Save export' })).not.toBeInTheDocument(); rendered.unmount(); expect(mocks.download).not.toHaveBeenCalled();
});
test('unfinalized/deleted meetings explain unavailable exports; literal headings remain safe', () => {
 useSessionsStore.setState({ sessions: [{ ...session(), transcriptFinalized: false }] });
 const view = render(<MeetingExportDialog sessionId="meeting" onClose={vi.fn()} />); expect(screen.getByRole('alert')).toHaveTextContent('finalized'); expect(screen.queryByRole('button', { name: 'Preview selected content' })).not.toBeInTheDocument(); view.unmount();
 useSessionsStore.setState({ sessions: [] }); render(<MeetingExportDialog sessionId="meeting" onClose={vi.fn()} />); expect(screen.getByRole('alert')).toHaveTextContent('no longer available');
});
test('a held old preview cannot replace a newer scope; invalid preview timing is accurate retryable feedback', async () => {
 let resolve!: (value: unknown) => void; mocks.preview.mockReturnValueOnce(new Promise(done => { resolve = done; }));
 render(<MeetingExportDialog sessionId="meeting" onClose={vi.fn()} />); await waitFor(() => expect(screen.getByRole('button', { name: 'Preview selected content' })).toBeEnabled());
 fireEvent.click(screen.getByRole('button', { name: 'Preview selected content' })); await waitFor(() => expect(mocks.preview).toHaveBeenCalledTimes(1));
 fireEvent.click(screen.getByRole('checkbox', { name: 'Speaker labels' }));
 await act(async () => resolve(exportPreview())); expect(screen.queryByRole('region', { name: 'Export preview' })).not.toBeInTheDocument();
 const invalid = exportPreview(); invalid.snapshot.segments[0]!.start = Number.NaN; mocks.preview.mockResolvedValueOnce(invalid);
 fireEvent.click(screen.getByRole('button', { name: 'Preview selected content' })); expect(await screen.findByRole('alert')).toHaveTextContent('timestamps are invalid');
 expect(screen.getByRole('button', { name: 'Preview selected content' })).toBeEnabled(); expect(mocks.start).not.toHaveBeenCalled();
});
test('closing after Save revokes its owned Blob and later accepted edits do not mutate frozen renderer input', async () => {
 const p = exportPreview(); p.review = { taskRevisions: {} }; p.selection = { transcript: true, notes: false, taskIds: [], speakers: true, timestamps: true }; mocks.preview.mockResolvedValue(p);
 const cleanup = vi.fn(); mocks.download.mockReturnValue(cleanup); const close = vi.fn();
 const view = render(<MeetingExportDialog sessionId="meeting" onClose={close} />); await waitFor(() => expect(screen.getByRole('button', { name: 'Preview selected content' })).toBeEnabled());
 fireEvent.click(screen.getByRole('button', { name: 'Preview selected content' })); fireEvent.click(await screen.findByRole('button', { name: 'Generate export' }));
 await screen.findByRole('button', { name: 'Save export' });
 act(() => useSessionsStore.setState({ sessions: [{ ...session(), transcript: 'Later corrected', transcriptVersion: 4 }] }));
 expect(mocks.start.mock.calls[0]![0].snapshot.sourceVersion).toBe(3); expect(screen.getByRole('button', { name: 'Save export' })).toBeEnabled();
 fireEvent.click(screen.getByRole('button', { name: 'Save export' })); fireEvent.click(screen.getByRole('button', { name: 'Close' })); expect(cleanup).toHaveBeenCalledTimes(1); expect(close).toHaveBeenCalledTimes(1); view.unmount(); expect(cleanup).toHaveBeenCalledTimes(1);
});
test.each([['pt-BR', 'Exportar PDF ou legendas', 'Visualizar conteúdo selecionado'], ['fr', 'Exporter en PDF ou sous-titres', 'Afficher le contenu sélectionné'], ['de', 'PDF oder Untertitel exportieren', 'Ausgewählte Inhalte ansehen']] as const)('shows export controls in %s without translating authored content', async (locale, title, action) => {
 useLocaleStore.setState({ locale }); render(<MeetingExportDialog sessionId="meeting" onClose={vi.fn()} />);
 expect(screen.getByRole('dialog', { name: title })).toBeVisible(); await waitFor(() => expect(screen.getByRole('button', { name: action })).toBeEnabled());
});

test('rejects an invalid displayed source version before requesting an export and gives localized refresh feedback', async () => {
 useLocaleStore.setState({ locale: 'pt-BR' });
 useSessionsStore.setState({ sessions: [{ ...session(), transcriptVersion: -1 }] });
 render(<MeetingExportDialog sessionId="meeting" onClose={vi.fn()} />);
 await waitFor(() => expect(screen.getByRole('button', { name: 'Visualizar conteúdo selecionado' })).toBeEnabled());
 fireEvent.click(screen.getByRole('button', { name: 'Visualizar conteúdo selecionado' }));
 expect(await screen.findByRole('alert')).toHaveTextContent('Atualize a reunião antes de exportar.');
 expect(mocks.preview).not.toHaveBeenCalled(); expect(mocks.start).not.toHaveBeenCalled();
});
