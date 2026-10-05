import type { SystemRecordStartResponse } from "@heed/shared";
import { apiClient } from "./client.ts";

export const recordingApi = {
	start: (mode: "mic" | "system" | "both" = "both", language?:string) =>
		apiClient.post<SystemRecordStartResponse>("/api/sysrecord/start", { mode, language }),
	stop: (language?: string) => apiClient.post<{
		path: string;
  finalized: boolean;
  duration?: number;
  liveModel?: string;
  language?: "en" | "pt";
  model?: string;
		streaming?: boolean;
		streamText?: string;
		turns?: Array<{ id: number; speaker: string; channel: "mic" | "sys"; text: string; start?: number; end?: number; auto?: boolean }>;
		embeddings?: Record<string, number[]>;
		autoNamed?: Record<string, { name: string; score: number }>;
	}>("/api/sysrecord/stop", language ? { language } : undefined),
	levelsUrl: () => "/api/sysrecord/levels",
};
