import { apiClient } from "./client.ts";

export const desktopApi = {
	/** Open the floating desktop panel (Chrome/Chromium --app window over Zoom/Meet). Mac + Linux. */
	float: () => apiClient.post<{ ok: boolean; error?: string }>("/api/desktop/float"),
};
