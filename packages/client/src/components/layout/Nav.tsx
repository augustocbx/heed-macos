import { useLocale } from "@/lib/i18n.ts";
import { useEffect, useState, useCallback } from "react";
import type { SetupCheckResult } from "@heed/shared";
import { useUIStore, type Page } from "@/stores/ui.ts";
import { useHealthStore } from "@/stores/health.ts";
import { useModelsStore } from "@/stores/models.ts";
import { setupApi } from "@/api/setup.ts";
import { desktopApi } from "@/api/desktop.ts";
import { ModelPicker } from "@/components/models/ModelPicker.tsx";
import { StatusFix, type FixTarget } from "./StatusFix.tsx";
import styles from "./Nav.module.css";

const TABS: Array<{ id: Page; label: string }> = [
	{ id: "record", label: "Record" },
	{ id: "sessions", label: "Meetings" },
	{ id: "settings", label: "Settings" },
];

const WHISPER_QUALITY_LABEL: Record<string, string> = {
	very_good: "very good",
	excellent: "high",
	best: "max",
};

const WHISPER_SPEED_LABEL: Record<string, string> = {
	fast: "fast",
	medium: "medium",
	slower: "slower",
};

export function Nav() {
 const {tr}=useLocale();
	const currentPage = useUIStore((s) => s.currentPage);
	const setPage = useUIStore((s) => s.setPage);
	const showToast = useUIStore((s) => s.showToast);
	const health = useHealthStore((s) => s.health);
	const checkHealth = useHealthStore((s) => s.check);
	const modelsData = useModelsStore((s) => s.data);
	const loadModels = useModelsStore((s) => s.load);
	const pickerOpen = useModelsStore((s) => s.pickerOpen);
	const openPicker = useModelsStore((s) => s.openPicker);
	const closePicker = useModelsStore((s) => s.closePicker);

	// Setup granularity (installed vs running) so a down badge knows whether to offer Install or Start.
	const [setup, setSetup] = useState<SetupCheckResult | null>(null);
	// Which badge's QuickFix popover is open (null = none).
	const [fixOpen, setFixOpen] = useState<FixTarget | null>(null);
	// Until the first health poll resolves, show a neutral gray dot instead of a false red.
	const [healthLoaded, setHealthLoaded] = useState(false);

	const refreshSetup = useCallback(async () => {
		try {
			setSetup(await setupApi.check());
		} catch {
			// server down / not reachable — leave last known state
		}
	}, []);

	const onFixed = useCallback(() => {
		checkHealth();
		refreshSetup();
	}, [checkHealth, refreshSetup]);

	// Open the floating desktop panel — a standalone Chrome window that floats over Zoom/Meet.
	const openFloat = useCallback(async () => {
		showToast(tr("Opening floating panel…"));
		try {
			const res = await desktopApi.float();
			if (!res.ok && res.error) showToast(res.error);
		} catch {
			showToast(tr("Could not open floating panel"));
		}
	}, [showToast]);

	useEffect(() => {
		checkHealth().then(() => setHealthLoaded(true));
		loadModels();
		refreshSetup();
		const id = setInterval(() => {
			checkHealth();
			refreshSetup();
		}, 60000);
		return () => clearInterval(id);
	}, [checkHealth, loadModels, refreshSetup]);

	// Gray while loading, then green/red. Down badges are clickable → open the QuickFix popover.
	const dotClass = (ok: boolean) => `${styles.dot} ${!healthLoaded ? "" : ok ? styles.dotOk : styles.dotErr}`;

	const currentModel = modelsData?.models.find((m) => m.id === modelsData.current?.id);
	const isCpuOnly = modelsData?.current?.num_gpu === 0;
	const whisperInfo = health.whisper_info || null;
	const pyannoteInfo = health.pyannote_info || null;
	const whisperPower = whisperInfo ? `${tr(WHISPER_QUALITY_LABEL[whisperInfo.quality] || whisperInfo.quality)} / ${tr(WHISPER_SPEED_LABEL[whisperInfo.speed] || whisperInfo.speed)}` : tr("detecting");
	// Show the REAL engine, not the nominal whisper tier. Apple Silicon runs Parakeet (Neural
	// Engine); CUDA/CPU run Whisper. Diarization is FluidAudio on Mac, pyannote elsewhere.
	const engine = health.languages?.engine;
	const engineLabel = !whisperInfo ? "..."
		: engine === "parakeet" ? "Parakeet v3"
		: engine === "mlx" ? `MLX ${whisperInfo.final_model}`
		: `whisper ${whisperInfo.final_model}`;
	const diarLabel = pyannoteInfo?.model?.toLowerCase().includes("fluidaudio") ? "FluidAudio" : "pyannote";

	return (
		<nav className={styles.nav}>
			<div className={styles.inner}>
				<div className={styles.leftBlock}>
					<a href="/" className={styles.brand}>{tr('heed')}</a>
				</div>

				<div className={styles.centerBlock}>
					<div className={styles.tabs}>
						{TABS.map((t) => (
							<button
								key={t.id}
								className={`${styles.tab} ${currentPage === t.id ? styles.tabActive : ""}`}
								onClick={() => setPage(t.id)}
								data-tour={t.id === "sessions" ? "sessions-tab" : undefined}
							>
								{tr(t.label)}
							</button>
						))}
					</div>
				</div>

				<div className={styles.rightBlock}>
					<div className={styles.status}>
						<button
							className={styles.floatChip}
							onClick={openFloat}
							title={tr('Open the floating panel — a small always-on-top window that floats over your Zoom/Meet calls')}
							aria-label={tr('Open floating panel')}
						>
							<span className={styles.floatChipIcon} aria-hidden="true">⧉</span>
							<span className={styles.floatChipLabel}>{tr('Float')}</span>
						</button>
						<button
							className={styles.modelChip}
							onClick={() => openPicker()}
							title={tr('Click to switch AI model')}
							data-tour="model-chip"
						>
							<span className={styles.modelChipDot} />
							<span className={styles.modelChipName}>
								{currentModel?.name || modelsData?.current?.id || tr("no model")}
							</span>
							{isCpuOnly && <span className={styles.modelChipBadge}>{tr('CPU')}</span>}
							{currentModel?.new && <span className={styles.modelChipNew}>{tr('NEW')}</span>}
							<span className={styles.modelChipChevron} aria-hidden="true">⌄</span>
						</button>
						<div
							className={`${styles.statusItem} ${styles.statusItemInfo} ${healthLoaded && !health.ollama ? styles.statusItemDown : ""}`}
							tabIndex={0}
							role={healthLoaded && !health.ollama ? "button" : undefined}
							aria-label={tr('Local notes engine (Ollama)')}
							onClick={healthLoaded && !health.ollama ? () => setFixOpen("ollama") : undefined}
						>
							<div className={dotClass(health.ollama)} />
							<span className={styles.label}>{tr('ollama')}</span>
							<span className={styles.statusItemChevron} aria-hidden="true">⌄</span>
							<div className={styles.infoTooltip} role="tooltip">
								<div className={styles.infoTooltipHead}>
									<div className={styles.infoTooltipTitle}>{tr('Ollama')}</div>
									<span className={styles.infoTooltipBadge}>{tr('AI notes')}</span>
								</div>
								<div className={styles.infoTooltipLine}>{tr("Local LLM that writes the meeting notes from the transcript.")}</div>
								<div className={styles.infoTooltipLine}><strong>{tr('Model:')}</strong> {currentModel?.name || modelsData?.current?.id || tr("none selected")}</div>
								<div className={styles.infoTooltipReason}>{tr('Separate from transcription — heed transcribes locally, then Ollama summarizes.')}</div>
							</div>
						</div>
						<div
							className={`${styles.statusItem} ${styles.statusItemInfo} ${healthLoaded && !health.whisper ? styles.statusItemDown : ""}`}
							tabIndex={0}
							role={healthLoaded && !health.whisper ? "button" : undefined}
							aria-label={tr('Transcription engine details')}
							onClick={healthLoaded && !health.whisper ? () => setFixOpen("engine") : undefined}
						>
							<div className={dotClass(health.whisper)} />
							<span className={styles.label}>{engineLabel}</span>
							<span className={styles.statusItemChevron} aria-hidden="true">⌄</span>
							<div className={styles.infoTooltip} role="tooltip">
								<div className={styles.infoTooltipHead}>
									<div className={styles.infoTooltipTitle}>
										{engine === "parakeet" ? "Parakeet (Apple Neural Engine)" : engine === "mlx" ? "MLX-Whisper (Apple GPU)" : tr("Whisper auto profile")}
									</div>
									<span className={styles.infoTooltipBadge}>{tr('transcription')}</span>
								</div>
								{engine === "parakeet" ? (
									<>
										<div className={styles.infoTooltipLine}><strong>{tr('Model:')}</strong>{tr(' parakeet-tdt-v3')}</div>
										<div className={styles.infoTooltipLine}><strong>{tr('Runs on:')}</strong>{tr(' Apple Neural Engine')}</div>
										<div className={styles.infoTooltipLine}><strong>{tr('Languages:')}</strong>{tr(' 28 European')}</div>
									</>
								) : (
									<>
										<div className={styles.infoTooltipLine}><strong>{tr('Final:')}</strong> {whisperInfo?.final_model || "small"}</div>
										<div className={styles.infoTooltipLine}><strong>{tr('Live:')}</strong> {whisperInfo?.live_model || "small"}</div>
										<div className={styles.infoTooltipLine}><strong>{tr('Power:')}</strong> {whisperPower}</div>
										<div className={styles.infoTooltipLine}><strong>{tr('Device:')}</strong> {whisperInfo?.device || "cpu"}</div>
									</>
								)}
								<div className={styles.infoTooltipReason}>{tr(whisperInfo?.reason || "Detecting hardware and choosing the best engine.")}</div>
							</div>
						</div>
						<div
							className={`${styles.statusItem} ${styles.statusItemInfo} ${healthLoaded && !health.pyannote ? styles.statusItemDown : ""}`}
							tabIndex={0}
							role={healthLoaded && !health.pyannote ? "button" : undefined}
							aria-label={tr('Speaker diarization details')}
							onClick={healthLoaded && !health.pyannote ? () => setFixOpen("diar") : undefined}
						>
							<div className={dotClass(health.pyannote)} />
							<span className={styles.label}>{diarLabel}</span>
							<span className={styles.statusItemChevron} aria-hidden="true">⌄</span>
							<div className={styles.infoTooltip} role="tooltip">
								<div className={styles.infoTooltipHead}>
									<div className={styles.infoTooltipTitle}>{tr(diarLabel === "FluidAudio" ? "FluidAudio diarization" : "Pyannote auto tuning")}</div>
									<span className={styles.infoTooltipBadge}>{tr('who said what')}</span>
								</div>
								{diarLabel === "FluidAudio" ? (
									<>
										<div className={styles.infoTooltipLine}><strong>{tr('Model:')}</strong>{tr(' FluidAudio CoreML')}</div>
										<div className={styles.infoTooltipLine}><strong>{tr('Runs on:')}</strong>{tr(' Apple Neural Engine')}</div>
										<div className={styles.infoTooltipLine}><strong>{tr('Token:')}</strong>{tr(' none needed')}</div>
									</>
								) : (
									<>
										<div className={styles.infoTooltipLine}><strong>{tr('Model:')}</strong> {pyannoteInfo?.model || "pyannote/speaker-diarization-3.1"}</div>
										<div className={styles.infoTooltipLine}><strong>{tr('Device:')}</strong> {pyannoteInfo?.device || "cpu"}</div>
										<div className={styles.infoTooltipLine}><strong>{tr('Profile:')}</strong> {pyannoteInfo?.profile || "balanced"}</div>
										<div className={styles.infoTooltipLine}><strong>{tr('Batch:')}</strong> {pyannoteInfo?.batch_size || 8}</div>
										{pyannoteInfo?.cpu_threads ? (
											<div className={styles.infoTooltipLine}><strong>{tr('CPU threads:')}</strong> {pyannoteInfo.cpu_threads}</div>
										) : null}
									</>
								)}
								<div className={styles.infoTooltipReason}>{tr(pyannoteInfo?.reason || "Tuning based on available hardware.")}</div>
							</div>
						</div>
						{fixOpen && (
							<StatusFix
								target={fixOpen}
								setup={setup}
								onClose={() => setFixOpen(null)}
								onFixed={onFixed}
							/>
						)}
					</div>
				</div>
			</div>
			<ModelPicker open={pickerOpen} onClose={() => closePicker()} />
		</nav>
	);
}
