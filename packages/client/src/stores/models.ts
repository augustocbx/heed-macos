import { create } from "zustand";
import type { ModelsResponse, CatalogModel } from "@heed/shared";
import { modelsApi } from "@/api/models.ts";

interface ModelsState {
	data: ModelsResponse | null;
	loading: boolean;
	error: string | null;
	pickerOpen: boolean;
	openPicker: () => void;
	closePicker: () => void;
	load: () => Promise<void>;
	currentModel: () => CatalogModel | null;
	select: (id: string) => Promise<void>;
}

export const useModelsStore = create<ModelsState>((set, get) => ({
	data: null,
	loading: false,
	error: null,
	// Global picker visibility so notes generation can open it when no model is selected.
	pickerOpen: false,
	openPicker: () => set({ pickerOpen: true }),
	closePicker: () => set({ pickerOpen: false }),
	load: async () => {
		set({ loading: true, error: null });
		try {
			const data = await modelsApi.list();
			set({ data, loading: false });
		} catch (e) {
			set({ error: (e as Error).message, loading: false });
		}
	},
	currentModel: () => {
		const d = get().data;
		if (!d) return null;
		const id = d.current?.id;
		return d.models.find((m) => m.id === id) || null;
	},
	select: async (id: string) => {
		await modelsApi.select(id);
		await get().load();
	},
}));
