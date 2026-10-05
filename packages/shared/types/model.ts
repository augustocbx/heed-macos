/**
 * Ollama model catalog types — shared between client and server.
 * The catalog itself lives in Python (transcription_server.py) and is
 * exposed via /api/models. The Bun server merges in install state + current selection.
 */
export type ModelQuality = "good" | "very_good" | "excellent" | "best";
export type ModelSpeed = "slow" | "medium" | "fast" | "very_fast";

export interface CatalogModel {
	id: string;
	name: string;
	vendor: string;
	size_mb: number; // download size
	vram_mb: number; // GPU footprint when loaded
	quality: ModelQuality;
	speed: ModelSpeed;
	description?: string;
	new?: boolean;
	/** True if the model fits in TOTAL VRAM of this GPU (stable, hardware-bound). */
	gpu_compatible: boolean;
	/** True if the model fits in CURRENTLY FREE VRAM (transient, depends on Chrome/Steam/etc). */
	gpu_runtime_ok?: boolean;
	recommended_runtime: "gpu" | "cpu";
	installed: boolean;
}

export interface CurrentModel {
	id?: string;
	num_gpu?: number; // 0 = CPU forced, undefined = Ollama auto
}

export interface ModelsResponse {
	gpu_available: boolean;
	gpu_name: string | null;
	total_vram_mb: number;
	free_vram_mb: number;
	pyannote_reserve_mb: number;
	safety_margin_mb: number;
	tier: "ultra" | "high" | "mid" | "low" | "cpu_only";
	default_model: string | null;
	models: CatalogModel[];
	current: CurrentModel;
}

/** Streamed event from /api/models/pull (mirrors Ollama's /api/pull stream). */
export interface PullProgress {
	status?: string;
	digest?: string;
	total?: number;
	completed?: number;
	error?: string;
	done?: boolean;
}

// --- First-launch setup wizard ----------------------------------------------
export type DetectedOS =
	| "linux-debian"
	| "linux-fedora"
	| "linux-arch"
	| "linux-other"
	| "macos"
	| "windows"
	| "unknown";

export interface SetupCheckResult {
	os: DetectedOS;
	ollama: { installed: boolean; running: boolean };
	ffmpeg: { installed: boolean; path: string | null };
	model: { default_id: string | null; installed: boolean };
	all_ready: boolean;
}

/** Streamed event from /api/setup/install-{ollama,ffmpeg}. */
export interface InstallProgress {
	status?: "started" | "done" | "error";
	cmd?: string;
	source?: "stdout" | "stderr";
	line?: string;
	code?: number;
	error?: string;
}
