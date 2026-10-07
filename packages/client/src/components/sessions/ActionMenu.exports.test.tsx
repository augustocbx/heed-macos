import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ActionMenu } from './ActionMenu';
import { useLocaleStore } from '@/stores/locale';
import type { Session } from '@heed/shared';
const session: Session = { id: 'meeting', title: 'Meeting', createdAt: '2026-10-07', duration: 3, language: 'pt', transcript: 'Corrected João', speakers: ['Ana'], segments: [{ speaker: 'Ana', start: 0, end: 3, text: 'Corrected João' }], aiNotes: '**Reviewed** notes', summary: '', tags: [], pinned: false, transcriptFinalized: true };
beforeEach(() => useLocaleStore.setState({ locale: 'en' }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
test.each(['{Enter}', ' '])('new export button works with %s and closes the menu with the saved Session', async key => {
 const onExport = vi.fn(), close = vi.fn(); render(<ActionMenu x={20} y={20} session={session} onClose={close} onExport={onExport} onTogglePin={vi.fn()} onDelete={vi.fn()} />);
 const button = screen.getByRole('button', { name: 'Export PDF or subtitles…' }); button.focus(); await userEvent.keyboard(key); expect(onExport).toHaveBeenCalledWith(session); expect(close).toHaveBeenCalledTimes(1);
});
test.each([['Export as .txt', 'Corrected João', 'text/plain', 'meeting-transcript.txt'], ['Export as .md', 'Corrected João', 'text/markdown', 'meeting-transcript.md']])('keeps the existing %s download exactly', async (action, expected, mime, filename) => {
 let blob!: Blob;
 vi.spyOn(URL, 'createObjectURL').mockImplementation(value => { blob = value as Blob; return 'blob:legacy'; });
 const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
 vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { expect(this.download).toBe(filename); });
 render(<ActionMenu x={20} y={20} session={session} onClose={vi.fn()} onTogglePin={vi.fn()} onDelete={vi.fn()} />);
 fireEvent.mouseEnter(screen.getByText('Transcript')); fireEvent.click(screen.getByText(action));
 const text = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result as string); reader.onerror = reject; reader.readAsText(blob); });
 expect(text).toBe(expected); expect(blob.type).toBe(mime); expect(revoke).toHaveBeenCalledWith('blob:legacy');
});
test('provisional sessions cannot start a final saved export', () => {
 render(<ActionMenu x={20} y={20} session={{ ...session, transcriptFinalized: false }} onClose={vi.fn()} onExport={vi.fn()} onTogglePin={vi.fn()} onDelete={vi.fn()} />);
 expect(screen.getByRole('button', { name: 'Export PDF or subtitles…' })).toBeDisabled();
});
test.each([['Transcript', 'Corrected João'], ['Speakers', 'Ana:\n  Corrected João'], ['AI Notes', 'Reviewed notes']])('preserves %s plain-text copy behavior for corrected final data', (category, expected) => {
 const writeText = vi.fn(); vi.stubGlobal('navigator', { clipboard: { writeText } });
 render(<ActionMenu x={20} y={20} session={session} onClose={vi.fn()} onTogglePin={vi.fn()} onDelete={vi.fn()} />);
 fireEvent.mouseEnter(screen.getByText(category)); fireEvent.click(screen.getByText('Copy as text')); expect(writeText).toHaveBeenCalledWith(expected);
});
