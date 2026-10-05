export function fmtTime(seconds: number): string {
	const m = Math.floor(seconds / 60);
	const s = seconds % 60;
	return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function fmtDuration(seconds: number): string {
	if (seconds < 60) return `${seconds}s`;
	const m = Math.floor(seconds / 60);
	const s = seconds % 60;
	return s ? `${m}m ${s}s` : `${m}m`;
}

export function fmtDate(iso: string): string {
	const d = new Date(iso);
	return (
		d.toLocaleDateString(undefined, { day: "numeric", month: "short" }) +
		" " +
		d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
	);
}

export function escapeHtml(s: string): string {
	return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Adaptive warning shown when the selected notes model won't fit the accelerator and must run on CPU.
 * On Apple Silicon "GPU" means Metal over unified memory, so we phrase it as the machine's memory
 * (and name the chip when known); on CUDA we keep the classic "doesn't fit in your GPU" wording.
 */
export function cpuFallbackWarning(modelName: string | undefined, gpuName: string | null | undefined): string {
	const model = modelName || "This model";
	const isApple = /apple|metal|\bM\d/i.test(gpuName || "");
	if (isApple) {
		const where = gpuName ? `your ${gpuName}'s memory` : "your Mac's memory";
		return `${model} is larger than ${where} can hold right now — it will run on CPU (slower).`;
	}
	return `${model} doesn't fit in your GPU right now. It will run on CPU (~3-4x slower).`;
}

/**
 * Rough, clearly-approximate seconds to generate one note, derived from model size + accelerator.
 * Shown with a "~" so it reads as a ballpark, not a promise. GPU is roughly an order of magnitude
 * faster than CPU for LLM decoding, which is the gap we want the user to feel.
 */
/**
 * The right noun for "GPU memory" on this machine. Apple Silicon has unified memory (no separate
 * VRAM), so calling it "VRAM" on a Mac is wrong and confusing — this returns "unified memory" there
 * and the expected "VRAM" on CUDA machines.
 */
export function memoryWord(gpuName: string | null | undefined): string {
	return /apple|metal|\bM\d/i.test(gpuName || "") ? "unified memory" : "VRAM";
}

export function estimateNotesSeconds(vramMb: number | undefined, onGpu: boolean): number {
	const sizeGb = (vramMb || 2400) / 1024;
	const perGb = onGpu ? 1.5 : 12;
	const base = onGpu ? 1 : 4;
	return Math.max(1, Math.round(base + sizeGb * perGb));
}
