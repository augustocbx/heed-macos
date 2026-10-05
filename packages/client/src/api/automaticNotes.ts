import type { AutomaticNotesSettings, Session } from '@heed/shared';
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
 control: (control: NotesJobControl) => apiClient.post<Session>('/api/notes/jobs', control),
};
