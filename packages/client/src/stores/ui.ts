import { tr } from "@/lib/i18n.ts";
import { create } from "zustand";

export type Page = "record" | "sessions" | "settings";

interface UIState {
	currentPage: Page;
	toast: string | null;
	setPage: (page: Page) => void;
	showToast: (message: string) => void;
}

export const useUIStore = create<UIState>((set) => ({
	currentPage: typeof window !== "undefined" && window.location.hash === "#settings" ? "settings" : "record",
	toast: null,
	setPage: (page) => set({ currentPage: page }),
	showToast: (message) => {
		set({ toast: tr(message) });
		setTimeout(() => set({ toast: null }), 2500);
	},
}));
