import type { HealthResponse } from "@heed/shared";
import { apiClient } from "./client.ts";

export const healthApi = {
	check: () => apiClient.get<HealthResponse>("/api/health"),
};
