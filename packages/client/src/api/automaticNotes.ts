import type { AutomaticNotesSettings, Session } from '@heed/shared';
import { beginSessionRequest, useSessionsStore } from '@/stores/sessions';
import { apiClient } from './client';
export interface NotesJobControl {
 sessionId: string;
 jobId: string;
 action: 'cancel' | 'retry';
 replaceExisting?: true;
 expectedNotes?: string;
}
export const automaticNotesApi = {
 settings: () => apiClient.get<AutomaticNotesSettings>('/api/notes/settings'),
 saveSettings: (settings: AutomaticNotesSettings) => apiClient.patch<AutomaticNotesSettings>('/api/notes/settings', settings),
 models: () => apiClient.get<{ models: string[] }>('/api/notes/models'),
 control: async (control: NotesJobControl) => {
  const order = beginSessionRequest(control.sessionId);
  const saved = await apiClient.post<Session>('/api/notes/jobs', control);
  return useSessionsStore.getState().accept(saved, order);
 },
};
