import { apiClient } from "./client";
export const MEETING_APPS = ["slack", "zoom", "teams", "meet"] as const;
export type MeetingApp = typeof MEETING_APPS[number];
export type DetectionSnapshot = { reconnectSeconds?: number | null; enabled: Record<MeetingApp, boolean>; ownerMeetingId: string | null; error: string | null; sources: { app: MeetingApp; detectorId: string; state: "active" | "inactive" | "unknown"; capability: "ready" | "permission-required" | "unsupported" | "degraded"; suppressed: boolean; receivedAt: number }[] };
function validated(value: DetectionSnapshot): DetectionSnapshot {
 if (!value || typeof value.enabled !== "object" || MEETING_APPS.some(app => typeof value.enabled[app] !== "boolean") || !Array.isArray(value.sources)) throw new Error("Invalid meeting detection status.");
 return value;
}
export const meetingDetectionApi = {
 status: async () => validated(await apiClient.get<DetectionSnapshot>("/api/meeting-detection/status")),
 configure: async (patch: Partial<Record<MeetingApp, boolean>>) => validated(await apiClient.post<DetectionSnapshot>("/api/meeting-detection/settings", patch)),
};
