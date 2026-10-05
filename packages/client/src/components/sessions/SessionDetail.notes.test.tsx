import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { Session } from '@heed/shared';
import { SessionDetail } from './SessionDetail';
import { useSessionsStore } from '@/stores/sessions';
import { useTemplatesStore } from '@/stores/templates';
import { useModelsStore } from '@/stores/models';
import { useRecordingStore } from '@/stores/recording';
import { setLocale } from '@/lib/i18n';
const session = { id: 's', title: 'Meeting', createdAt: '2026-10-05T12:00:00Z', language: 'de', transcript: 'Hallo', transcriptRevision: 'r', aiNotes: '', speakers: ['Anna'], segments: [{ speaker: 'Anna', text: 'Hallo', start: 0, end: 1 }], tags: [] } as unknown as Session;
beforeEach(() => {
 setLocale('en'); useRecordingStore.getState().reset(); useSessionsStore.setState({ sessions: [session], viewing: session });
 useTemplatesStore.setState({ load: vi.fn(), templates: [{ id: 'general', name: 'General', description: '', prompt: '' }] });
 useModelsStore.setState({ load: vi.fn(), data: { models: [{ id: 'local', gpu_runtime_ok: false }], current: { id: 'local' } } as never });
});
afterEach(() => vi.unstubAllGlobals());
test('manual detail notes honor CPU selection and save revision-guarded speaker input', async () => {
 const fetchMock = vi.fn(async (url: string, init?: RequestInit) => url === '/api/summarize' ? new Response('data: {"token":"Neue Notizen"}\n\ndata: {"done":true}\n\n') : Response.json({ ...session, ...JSON.parse(String(init!.body)) }));
 vi.stubGlobal('fetch', fetchMock);
 render(<SessionDetail session={session} onBack={vi.fn()} />); fireEvent.click(screen.getByText('AI Notes'));
 fireEvent.click(screen.getByRole('button', { name: /Generate on CPU/ }));
 await waitFor(() => expect(useSessionsStore.getState().viewing?.aiNotes).toBe('Neue Notizen'));
 expect(fetchMock).toHaveBeenCalledWith('/api/summarize', expect.objectContaining({ body: JSON.stringify({ transcript: 'Anna: Hallo', language: 'de', templateId: 'general', force_cpu: true }) }));
});
