import { create } from "zustand";
import type { Template } from "@heed/shared";
import { templatesApi } from "@/api/templates.ts";

interface TemplatesState {
	templates: Template[];
	loaded: boolean;
	load: () => Promise<void>;
}

export const useTemplatesStore = create<TemplatesState>((set, get) => ({
	templates: [],
	loaded: false,
	load: async () => {
		if (get().loaded) return;
		try {
			const templates = await templatesApi.list();
			set({ templates, loaded: true });
		} catch {}
	},
}));
