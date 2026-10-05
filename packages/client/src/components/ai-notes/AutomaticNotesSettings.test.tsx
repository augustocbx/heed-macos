import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { AutomaticNotesSettings as Settings } from '@heed/shared';
import { AutomaticNotesSettings } from './AutomaticNotesSettings';
import { setLocale } from '@/lib/i18n';
const settings: Settings = { enabled: false, templateId: 'general', model: null, language: 'meeting' };
let saved = settings;
let unavailable = false;
let saveFails = false;
const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
 if (url.endsWith('/models') && unavailable) return new Response(JSON.stringify({ error: 'Ollama unavailable' }), { status: 503 });
 if (init?.method === 'PATCH' && saveFails) return new Response(JSON.stringify({ error: 'Model disappeared' }), { status: 409 });
 if (init?.method === 'PATCH') { saved = JSON.parse(String(init.body)); return Response.json(saved); }
 return Response.json(url.endsWith('/settings') ? saved : url.endsWith('/models') ? { models: ['local:latest'] } : [{ id: 'general', name: 'General' }]);
});
beforeEach(() => { setLocale('en'); saved = settings; unavailable = false; saveFails = false; fetchMock.mockClear(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => vi.unstubAllGlobals());
test('requires an installed model before opting in and persists output choices', async () => {
 render(<AutomaticNotesSettings />);
 const toggle = await screen.findByRole('checkbox', { name: 'Generate notes automatically' });
 expect(toggle).not.toBeChecked(); expect(toggle).toBeDisabled();
 fireEvent.change(screen.getByLabelText('Local notes model'), { target: { value: 'local:latest' } });
 fireEvent.change(screen.getByLabelText('Notes language'), { target: { value: 'pt' } });
 fireEvent.click(toggle);
 fireEvent.click(screen.getByRole('button', { name: 'Save automatic notes settings' }));
 await waitFor(() => expect(saved).toEqual({ ...settings, enabled: true, model: 'local:latest', language: 'pt' }));
});
test('retains a failed choice and permits retrying unavailable models', async () => {
 unavailable = true; render(<AutomaticNotesSettings />);
 expect(await screen.findByRole('alert')).toHaveTextContent('Could not load automatic notes settings');
 expect(screen.getByRole('checkbox')).toBeDisabled();
 unavailable = false; fireEvent.click(screen.getByRole('button', { name: 'Retry loading' }));
 await screen.findByRole('option', { name: 'local:latest' });
 expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});
test('allows disabling saved automatic notes while Ollama is unavailable', async () => {
 saved = { ...settings, enabled: true, model: 'local:latest' };
 unavailable = true; render(<AutomaticNotesSettings />);
 const toggle = await screen.findByRole('checkbox', { name: 'Generate notes automatically' });
 await screen.findByRole('alert');
 expect(toggle).toBeChecked(); expect(toggle).toBeEnabled();
 fireEvent.click(toggle);
 fireEvent.click(screen.getByRole('button', { name: 'Save automatic notes settings' }));
 await waitFor(() => expect(saved.enabled).toBe(false));
});

test('preserves selected settings after a failed save and explains how to retry', async () => {
 render(<AutomaticNotesSettings />);
 await screen.findByRole('option', { name: 'local:latest' });
 fireEvent.change(screen.getByLabelText('Local notes model'), { target: { value: 'local:latest' } });
 fireEvent.change(screen.getByLabelText('Notes language'), { target: { value: 'de' } });
 fireEvent.click(screen.getByRole('checkbox'));
 saveFails = true; fireEvent.click(screen.getByRole('button', { name: 'Save automatic notes settings' }));
 expect(await screen.findByRole('alert')).toHaveTextContent('Could not save automatic notes settings');
 expect(screen.getByLabelText('Local notes model')).toHaveValue('local:latest');
 expect(screen.getByLabelText('Notes language')).toHaveValue('de');
 expect(screen.getByRole('checkbox')).toBeChecked();
 saveFails = false; fireEvent.click(screen.getByRole('button', { name: 'Save automatic notes settings' }));
 expect(await screen.findByRole('status')).toHaveTextContent('Automatic notes settings saved.');
});
