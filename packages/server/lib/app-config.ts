/**
 * Single source of truth for app paths + persistent config (~/.heed-app/config.json).
 *
 * Previously the config read/write lived inline in the 2200-line server.ts AND a stale, unused
 * duplicate sat in lib/config.ts (different shape) — exactly the kind of drift the audit flagged.
 * This module owns it; the dead duplicate was deleted.
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const APP_DIR = join(homedir(), ".heed-app");
export const CONFIG_PATH = join(APP_DIR, "config.json");
export const SESSIONS_DIR = join(APP_DIR, "sessions");
export const TEMPLATES_DIR = join(APP_DIR, "templates");

/**
 * Persistent config. May also contain legacy CLI fields (language, modelSize, ...); we preserve
 * unknown keys on write so the old CLI tool keeps working.
 */
export interface TrxConfig {
	ollama_model?: string;
	ollama_num_gpu?: number; // 0 = CPU-only, undefined = let Ollama decide, 999 = all layers on GPU
	user_name?: string; // label for the user's own (mic) channel; defaults to "Me"
	[k: string]: unknown; // forward-compat for legacy keys
}

/** Ensure ~/.heed-app and its subdirs exist (plus any extra dirs the caller passes). */
export function ensureAppDirs(extra: string[] = []): void {
	for (const dir of [APP_DIR, SESSIONS_DIR, TEMPLATES_DIR, ...extra]) {
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	}
}

export function loadConfig(): TrxConfig {
	if (existsSync(CONFIG_PATH)) {
		try {
			return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
		} catch {}
	}
	return {};
}

export function saveConfig(patch: Partial<TrxConfig>): void {
	const merged = { ...loadConfig(), ...patch };
	writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2));
}

/** The mic channel is always the user; let them put their real name on it instead of "Me". */
export function micLabel(): string {
	const n = (loadConfig().user_name || "").trim();
	return n || "Me";
}
