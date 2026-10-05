import { create } from "zustand";

export type Page = "record" | "sessions";

interface UIState {
	currentPage: Page;
	toast: string | null;
	setPage: (page: Page) => void;
	showToast: (message: string) => void;
}

export const useUIStore = create<UIState>((set) => ({
	currentPage: "record",
	toast: null,
	setPage: (page) => set({ currentPage: page }),
	showToast: (message) => {
		set({ toast: message });
		setTimeout(() => set({ toast: null }), 2500);
	},
}));
