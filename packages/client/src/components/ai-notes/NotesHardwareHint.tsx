import type { CatalogModel, ModelsResponse } from "@heed/shared";
import { estimateNotesSeconds } from "@/lib/format.ts";
import styles from "./NotesHardwareHint.module.css";

interface Props {
	model: CatalogModel | undefined;
	modelsData: ModelsResponse | null | undefined;
	fitsGpu: boolean;
}

/**
 * Confidence line shown in AI Notes when the model runs on the accelerator. Turns the old scary
 * "doesn't fit in your GPU" copy into a positive "runs on your <chip>, ~Ns per note" signal —
 * fully adaptive to the detected hardware. Renders nothing on CPU (the CPU warning covers that).
 */
export function NotesHardwareHint({ model, modelsData, fitsGpu }: Props) {
	if (!modelsData?.gpu_available || !fitsGpu) return null;
	const gpuName = modelsData.gpu_name || "your GPU";
	const isApple = /apple|metal|\bM\d/i.test(gpuName);
	const where = isApple ? `${gpuName} · Metal` : gpuName;
	const secs = estimateNotesSeconds(model?.vram_mb, true);
	return (
		<div className={styles.hint}>
			<span className={styles.bolt} aria-hidden="true">⚡</span>
			<span>Runs on <strong>{where}</strong> · notes in ~{secs}s</span>
		</div>
	);
}
