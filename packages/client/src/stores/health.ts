import { create } from "zustand";
import type { HealthResponse } from "@heed/shared";
import { healthApi } from "@/api/health.ts";

interface HealthState {
	health: HealthResponse;
	check: () => Promise<void>;
}

export const useHealthStore = create<HealthState>((set) => ({
	health: { ollama: false, whisper: false, pyannote: false },
	check: async () => {
		try {
			const health = await healthApi.check();
			set({ health });
		} catch {
			set({ health: { ollama: false, whisper: false, pyannote: false } });
		}
	},
}));
