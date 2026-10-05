import { tr, useLocale } from "@/lib/i18n.ts";
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { CatalogModel, PullProgress } from "@heed/shared";
import { useModelsStore } from "@/stores/models.ts";
import { useUIStore } from "@/stores/ui.ts";
import { modelsApi } from "@/api/models.ts";
import { memoryWord } from "@/lib/format.ts";
import styles from "./ModelPicker.module.css";

interface Props {
	open: boolean;
	onClose: () => void;
}

const QUALITY_LABEL: Record<string, string> = {
	good: "Good",
	very_good: "Very Good",
	excellent: "Excellent",
	best: "Best",
};

const SPEED_LABEL: Record<string, string> = {
	very_fast: "Very fast",
	fast: "Fast",
	medium: "Medium",
	slow: "Slow",
};

function fmtMb(mb: number) {
	if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
	return `${mb} MB`;
}

export function ModelPicker({ open, onClose }: Props) {
	useLocale();
	const data = useModelsStore((s) => s.data);
	const load = useModelsStore((s) => s.load);
	const select = useModelsStore((s) => s.select);
	const showToast = useUIStore((s) => s.showToast);

	const [pullingId, setPullingId] = useState<string | null>(null);
	const [pullProgress, setPullProgress] = useState<PullProgress | null>(null);

	useEffect(() => {
		if (open) load();
	}, [open, load]);

	const grouped = useMemo(() => {
		if (!data) return { gpu: [], cpu: [] };
		const gpu: CatalogModel[] = [];
		const cpu: CatalogModel[] = [];
		for (const m of data.models) {
			if (m.gpu_compatible) gpu.push(m);
			else cpu.push(m);
		}
		return { gpu, cpu };
	}, [data]);

	if (!open) return null;

	const handleSelectInstalled = async (m: CatalogModel) => {
		try {
			await select(m.id);
			showToast(tr("Switched to {model}", undefined, {model:m.name}));
			onClose();
		} catch (e) {
			showToast(tr("Switch failed: {message}", undefined, {message:tr((e as Error).message)}));
		}
	};

	const handleDownload = (m: CatalogModel, e: React.MouseEvent) => {
		e.stopPropagation();
		if (pullingId) return; // one pull at a time
		setPullingId(m.id);
		setPullProgress({ status: "starting" });
		modelsApi.pullStream(m.id, async (evt) => {
			setPullProgress(evt);
			if (evt.error) {
				showToast(tr("Pull failed: {message}", undefined, {message:tr(evt.error || "")}));
				setPullingId(null);
				setPullProgress(null);
				return;
			}
			if (evt.done) {
				try {
					await select(m.id);
					showToast(tr("Downloaded and switched to {model}", undefined, {model:m.name}));
				} catch (err) {
					showToast(tr("Switch failed: {message}", undefined, {message:tr((err as Error).message)}));
				}
				setPullingId(null);
				setPullProgress(null);
			}
		});
	};

	const renderModel = (m: CatalogModel) => {
		const isCurrent = data?.current?.id === m.id;
		const isPulling = pullingId === m.id;
		const pct = pullProgress?.total
			? Math.min(100, Math.round(((pullProgress.completed || 0) / pullProgress.total) * 100))
			: 0;
		// Cards are only clickable when the model is installed AND not the current one.
		// Non-installed cards do nothing on click — the user must press the Download button explicitly.
		const cardClickable = m.installed && !isCurrent && !pullingId;
		return (
			<div
				key={m.id}
				className={`${styles.card} ${isCurrent ? styles.cardCurrent : ""} ${cardClickable ? styles.cardClickable : ""}`}
				onClick={() => cardClickable && handleSelectInstalled(m)}
			>
				<div className={styles.cardHead}>
					<span className={styles.name}>{m.name}</span>
					{m.new && <span className={styles.badgeNew}>{tr("NEW")}</span>}
					{isCurrent && <span className={styles.badgeCurrent}>{tr("ACTIVE")}</span>}
					{m.installed && !isCurrent && <span className={styles.badgeInstalled}>{tr("installed")}</span>}
				</div>
				<div className={styles.meta}>
					<span>{m.vendor}</span>
					<span>·</span>
					<span title={tr("Download size")}>{fmtMb(m.size_mb)} {tr("download")}</span>
					<span>·</span>
					<span title={tr("{memory} when loaded", undefined, {memory:memoryWord(data?.gpu_name)})}>{m.vram_mb === 0 ? tr("CPU only") : `${fmtMb(m.vram_mb)} ${memoryWord(data?.gpu_name)}`}</span>
				</div>
				<div className={styles.tags}>
					<span className={`${styles.tag} ${styles[`q_${m.quality}`]}`}>{tr(QUALITY_LABEL[m.quality])}</span>
					<span className={styles.tag}>{tr(SPEED_LABEL[m.speed])}</span>
					<span className={`${styles.tag} ${m.gpu_compatible ? styles.gpuOk : styles.gpuOff}`}>
						{m.gpu_compatible ? tr("fits GPU") : tr("CPU only on your hardware")}
					</span>
				</div>
				{m.description && <div className={styles.desc}>{m.description}</div>}

				{isPulling ? (
					<div className={styles.pullBar}>
						<div className={styles.pullBarFill} style={{ width: `${pct}%` }} />
						<span className={styles.pullStatus}>
							{pullProgress?.status || "downloading"} · {pct}%
						</span>
					</div>
				) : !m.installed ? (
					<button
						className={styles.downloadBtn}
						onClick={(e) => handleDownload(m, e)}
						disabled={!!pullingId}
					>
						{tr("Download")} {fmtMb(m.size_mb)}
					</button>
				) : null}
			</div>
		);
	};

	return createPortal(
		<div className={styles.backdrop} onClick={onClose}>
			<div className={styles.modal} onClick={(e) => e.stopPropagation()}>
				<div className={styles.head}>
					<div>
						<h2 className={styles.title}>{tr("Pick your AI model")}</h2>
						<p className={styles.subtitle}>
							{data?.gpu_name
								? tr("{gpu} · {total} {memory} · {free} free · tier {tier}", undefined, {gpu:data.gpu_name,total:fmtMb(data.total_vram_mb),memory:memoryWord(data.gpu_name),free:fmtMb(data.free_vram_mb),tier:data.tier})
								: tr("Detecting hardware...")}
						</p>
					</div>
					<button className={styles.closeBtn} onClick={onClose}>×</button>
				</div>

				{!data && <div className={styles.loading}>{tr("Loading catalog...")}</div>}

				{data && grouped.gpu.length > 0 && (
					<>
						<div className={styles.section}>{tr("Recommended for your GPU")}</div>
						<div className={styles.grid}>{grouped.gpu.map(renderModel)}</div>
					</>
				)}

				{data && grouped.cpu.length > 0 && (
					<>
						<div className={styles.section}>
							{tr("CPU only on your hardware")}<span className={styles.sectionHint}>
								{data.pyannote_reserve_mb > 0
									? tr("(slower, but won't crash diarization — keeps {memory} VRAM free for speaker diarization)", undefined, {memory:fmtMb(data.pyannote_reserve_mb)})
									: `(slower — these models are larger than your ${data.gpu_name || tr("hardware")} runs comfortably)`}
							</span>
						</div>
						<div className={styles.grid}>{grouped.cpu.map(renderModel)}</div>
					</>
				)}
			</div>
		</div>,
		document.body,
	);
}
