import { afterEach, expect, test, vi } from 'vitest';
import type { Session } from '@heed/shared';
import { useSessionsStore } from './sessions';
const session = { id: 's', aiNotes: 'Old notes' } as unknown as Session;
afterEach(() => vi.unstubAllGlobals());
test('does not regress a saved edit when an older poll finishes afterward', async () => {
 let resolve!: (response: Response) => void;
 vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(done => { resolve = done; })));
 useSessionsStore.setState({ sessions: [session], viewing: session });
 const polling = useSessionsStore.getState().load(true);
 useSessionsStore.getState().accept({ ...session, aiNotes: 'Saved edit' });
 resolve(Response.json([session])); await polling;
 expect(useSessionsStore.getState().sessions[0].aiNotes).toBe('Saved edit');
 expect(useSessionsStore.getState().viewing?.aiNotes).toBe('Saved edit');
});
