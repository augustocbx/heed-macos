import type { SystemRecordStartResponse, RecordingSnapshot } from "@heed/shared";
import { apiClient } from "./client.ts";

export const recordingApi = {
	start: (mode: "mic" | "system" | "both" = "both", language?:string, requestId=crypto.randomUUID()) =>
		apiClient.post<SystemRecordStartResponse & {snapshot?:RecordingSnapshot}>("/api/sysrecord/start", { mode, language, requestId }),
	stop: (meetingId:string,requestId=crypto.randomUUID()) => apiClient.post<{
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
  snapshot?:RecordingSnapshot;
	}>("/api/sysrecord/stop", {meetingId,requestId}),
 status:()=>apiClient.get<RecordingSnapshot>("/api/recording/status"),
 abandon:(meetingId:string,requestId=crypto.randomUUID())=>apiClient.post<RecordingSnapshot>("/api/recording/abandon",{meetingId,requestId}),
 rename:(meetingId:string,expectedRevision:number,speakerNames:Record<string,string>)=>apiClient.post<RecordingSnapshot>("/api/recording/speakers",{meetingId,expectedRevision,speakerNames}),
 retry:(meetingId:string,requestId=crypto.randomUUID())=>apiClient.post<RecordingSnapshot>("/api/recording/retry",{meetingId,requestId}),
	levelsUrl: () => "/api/sysrecord/levels",
};
