import type { Segment } from "@heed/shared";
import { apiClient } from "./client.ts";

export interface OrphanedRecording {
	path: string;
	filename: string;
	size_mb: number;
	created: string;
	duration_estimate_s: number;
	is_dual: boolean;
 recoveryMeetingId?:string;
 speakerNames?:Record<string,string>;
 segments?:Segment[];
}

export const recoveryApi = {
	list: () =>
		apiClient.get<{ recordings: OrphanedRecording[] }>("/api/recovery/list"),
	discard: (path: string) =>
		apiClient.delete<{ ok: boolean }>(
			`/api/recovery/discard?path=${encodeURIComponent(path)}`,
		),
};
