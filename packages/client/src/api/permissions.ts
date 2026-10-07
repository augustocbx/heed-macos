import { apiClient } from './client.ts';

export interface PermissionSnapshot {
 controllerConnected: boolean;
 updatedAt: number | null;
 permissions: { microphone: 'authorized' | 'denied' | 'restricted' | 'notDetermined' | 'unknown'; screenCapture: boolean | null; slackLogs: boolean | null; slackAutoRecord: boolean | null } | null;
 error: string | null;
 pending: boolean;
 recoveryAvailable?: boolean;
 recoveryBlockedReason?: string;
}
export type PermissionAction = 'microphone' | 'screenCapture' | 'slackLogs' | 'accessibility' | 'recoverScreenCapture';
export const permissionsApi = {
 status: () => apiClient.get<PermissionSnapshot>('/api/desktop/permissions'),
 authorize: (action: PermissionAction) => apiClient.post<{ ok: true; id: string }>('/api/desktop/permissions', { action }),
};
