import type { MeetingExportPreview, MeetingExportPreviewInput, MeetingExportValidateInput } from '@heed/shared';
import { apiClient } from './client';
export const meetingExportApi = {
 preview: (id: string, input: MeetingExportPreviewInput) => apiClient.post<MeetingExportPreview>(`/api/sessions/${encodeURIComponent(id)}/export-preview`, input),
 validate: (id: string, input: MeetingExportValidateInput) => apiClient.post<{ valid: true; snapshotKey: string }>(`/api/sessions/${encodeURIComponent(id)}/export-validate`, input),
};
