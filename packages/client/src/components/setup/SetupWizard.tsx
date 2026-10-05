import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { CatalogModel, InstallProgress, PullProgress, SetupCheckResult } from "@heed/shared";
import { setupApi } from "@/api/setup.ts";
import { modelsApi } from "@/api/models.ts";
import { memoryWord } from "@/lib/format.ts";
import { useModelsStore } from "@/stores/models.ts";
import { useSetup } from "@/hooks/useSetup.ts";
import { useUIStore } from "@/stores/ui.ts";
import { detectLocale, setLocale, t, type Locale } from "@/lib/i18n.ts";
import styles from "./SetupWizard.module.css";

type StepId = "ollama" | "ffmpeg" | "model";

const STEP_ORDER: StepId[] = ["ollama", "ffmpeg", "model"];

function fmtMb(mb: number) {
	if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
	return `${mb} MB`;
}

interface CommandBoxProps {
	command: string;
	locale: Locale;
}

function CommandBox({ command, locale }: CommandBoxProps) {
	const [copied, setCopied] = useState(false);
	const handleCopy = async () => {
		try {
			await navigator.clipboard.writeText(command);
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		} catch {}
	};
	return (
		<div className={styles.cmdBox}>
			<code className={styles.cmdText}>{command}</code>
			<button className={styles.cmdCopy} onClick={handleCopy}>
				{copied ? t("wizard.copied", locale) : t("wizard.copyCmd", locale)}
			</button>
		</div>
	);
}

interface InstallStreamProps {
	progress: InstallProgress[];
}

function InstallStream({ progress }: InstallStreamProps) {
	if (progress.length === 0) return null;
	return (
		<div className={styles.streamBox}>
			{progress.slice(-12).map((p, i) => (
				<div
					key={i}
					className={`${styles.streamLine} ${p.source === "stderr" ? styles.streamErr : ""}`}
				>
					{p.line || p.status || ""}
				</div>
			))}
		</div>
	);
}

// --- Step 1: Ollama ---
interface StepOllamaProps {
	check: SetupCheckResult;
	locale: Locale;
	onComplete: () => void;
	forced?: boolean;
}

function StepOllama({ check, locale, onComplete, forced }: StepOllamaProps) {
	const showToast = useUIStore((s) => s.showToast);
	const [installing, setInstalling] = useState(false);
	const [progress, setProgress] = useState<InstallProgress[]>([]);
	const isReady = check.ollama.installed && check.ollama.running;
	const cmd = "curl -fsSL https://ollama.com/install.sh | sh";

	useEffect(() => {
		if (isReady && !forced) {
			// Auto-advance after a short beat so the user sees the green check
			const id = setTimeout(onComplete, 800);
			return () => clearTimeout(id);
		}
	}, [isReady, onComplete, forced]);

	const handleInstall = () => {
		if (installing) return;
		setInstalling(true);
		setProgress([]);
		setupApi.installOllama((evt) => {
			setProgress((prev) => [...prev, evt]);
			if (evt.status === "done") {
				setInstalling(false);
				if (evt.code === 0) {
					showToast(t("wizard.installed", locale));
					onComplete();
				} else {
					showToast(t("wizard.installFailed", locale));
				}
			}
			if (evt.status === "error") {
				setInstalling(false);
				showToast(`${t("wizard.installFailed", locale)}: ${evt.error}`);
			}
		});
	};

	return (
		<div className={styles.step}>
			<h3 className={styles.stepTitle}>{t("setup.ollama.title", locale)}</h3>
			<p className={styles.stepBody}>{t("setup.ollama.body", locale)}</p>

			{isReady ? (
				<div className={styles.statusOk}>✓ {t("setup.ollama.detected", locale)}</div>
			) : (
				<>
					<div className={styles.cmdLabel}>{t("wizard.runningCmd", locale)}</div>
					<CommandBox command={cmd} locale={locale} />
					<div className={styles.actions}>
						<button
							className={styles.btnPrimary}
							onClick={handleInstall}
							disabled={installing}
						>
							{installing ? t("wizard.installing", locale) : t("setup.ollama.installBtn", locale)}
						</button>
						<button className={styles.btnGhost} onClick={onComplete}>
							{t("wizard.iHaveIt", locale)}
						</button>
					</div>
					<InstallStream progress={progress} />
				</>
			)}
		</div>
	);
}

// --- Step 2: ffmpeg ---
interface StepFfmpegProps {
	check: SetupCheckResult;
	locale: Locale;
	onComplete: () => void;
	forced?: boolean;
}

function ffmpegCommandFor(os: SetupCheckResult["os"]): string {
	switch (os) {
		case "linux-debian":
			return "sudo apt-get install -y ffmpeg";
		case "linux-fedora":
			return "sudo dnf install -y ffmpeg";
		case "linux-arch":
			return "sudo pacman -S --noconfirm ffmpeg";
		case "macos":
			return "brew install ffmpeg";
		case "windows":
			return "winget install ffmpeg";
		default:
			return "# Install ffmpeg from your package manager";
	}
}

function StepFfmpeg({ check, locale, onComplete, forced }: StepFfmpegProps) {
	const showToast = useUIStore((s) => s.showToast);
	const [installing, setInstalling] = useState(false);
	const [progress, setProgress] = useState<InstallProgress[]>([]);
	const isReady = check.ffmpeg.installed;
	const cmd = ffmpegCommandFor(check.os);
	const supported = ["linux-debian", "linux-fedora", "linux-arch", "macos"].includes(check.os);

	useEffect(() => {
		if (isReady && !forced) {
			const id = setTimeout(onComplete, 800);
			return () => clearTimeout(id);
		}
	}, [isReady, onComplete, forced]);

	const handleInstall = () => {
		if (installing) return;
		setInstalling(true);
		setProgress([]);
		setupApi.installFfmpeg((evt) => {
			setProgress((prev) => [...prev, evt]);
			if (evt.status === "done") {
				setInstalling(false);
				if (evt.code === 0) {
					showToast(t("wizard.installed", locale));
					onComplete();
				} else {
					showToast(t("wizard.installFailed", locale));
				}
			}
			if (evt.status === "error") {
				setInstalling(false);
				showToast(`${t("wizard.installFailed", locale)}: ${evt.error}`);
			}
		});
	};

	return (
		<div className={styles.step}>
			<h3 className={styles.stepTitle}>{t("setup.ffmpeg.title", locale)}</h3>
			<p className={styles.stepBody}>{t("setup.ffmpeg.body", locale)}</p>

			{isReady ? (
				<div className={styles.statusOk}>✓ {t("setup.ffmpeg.detected", locale)}</div>
			) : (
				<>
					<div className={styles.cmdLabel}>{t("wizard.runningCmd", locale)}</div>
					<CommandBox command={cmd} locale={locale} />
					{!supported && (
						<div className={styles.warnBox}>{t("setup.ffmpeg.unsupportedOS", locale)}</div>
					)}
					<div className={styles.actions}>
						{supported && (
							<button
								className={styles.btnPrimary}
								onClick={handleInstall}
								disabled={installing}
							>
								{installing ? t("wizard.installing", locale) : t("setup.ffmpeg.installBtn", locale)}
							</button>
						)}
						<button className={styles.btnGhost} onClick={onComplete}>
							{t("wizard.iHaveIt", locale)}
						</button>
					</div>
					<InstallStream progress={progress} />
				</>
			)}
		</div>
	);
}

// --- Step 3: Model ---
interface StepModelProps {
	check: SetupCheckResult;
	locale: Locale;
	onComplete: () => void;
	forced?: boolean;
}

function StepModel({ check, locale, onComplete, forced, onFinish }: StepModelProps & { onFinish: () => void }) {
	const showToast = useUIStore((s) => s.showToast);
	const modelsData = useModelsStore((s) => s.data);
	const loadModels = useModelsStore((s) => s.load);
	const selectModel = useModelsStore((s) => s.select);
	const [pullingId, setPullingId] = useState<string | null>(null);
	const [pullProgress, setPullProgress] = useState<PullProgress | null>(null);
	const [showCpuModels, setShowCpuModels] = useState(false);

	useEffect(() => {
		loadModels();
	}, [loadModels]);

	// If the default model is already pulled, close the wizard — setup is done.
	useEffect(() => {
		if (check.model.installed && check.model.default_id && !forced) {
			const id = setTimeout(onFinish, 800);
			return () => clearTimeout(id);
		}
	}, [check, onFinish, forced]);

	// Three groups:
	//   1. recommended  → the suggested default for this hardware
	//   2. otherGpu     → other models that fit the GPU
	//   3. cpuOnly      → models that don't fit the GPU but can run on CPU (slower, often higher quality)
	const gpuCompatible = useMemo<CatalogModel[]>(() => {
		if (!modelsData) return [];
		return modelsData.models.filter((m) => m.gpu_compatible);
	}, [modelsData]);

	const cpuOnly = useMemo<CatalogModel[]>(() => {
		if (!modelsData) return [];
		return modelsData.models.filter((m) => !m.gpu_compatible);
	}, [modelsData]);

	const recommended = useMemo<CatalogModel | null>(() => {
		if (!modelsData?.default_model) return null;
		return gpuCompatible.find((m) => m.id === modelsData.default_model) || gpuCompatible[0] || null;
	}, [gpuCompatible, modelsData]);

	const otherGpu = useMemo<CatalogModel[]>(
		() => gpuCompatible.filter((m) => m.id !== recommended?.id),
		[gpuCompatible, recommended],
	);

	const handleDownload = (m: CatalogModel) => {
		if (pullingId) return;
		setPullingId(m.id);
		setPullProgress({ status: "starting" });
		modelsApi.pullStream(m.id, async (evt) => {
			setPullProgress(evt);
			if (evt.error) {
				showToast(`${t("wizard.installFailed", locale)}: ${evt.error}`);
				setPullingId(null);
				setPullProgress(null);
				return;
			}
			if (evt.done) {
				try {
					await selectModel(m.id);
					showToast(t("wizard.installed", locale));
					setPullingId(null);
					setPullProgress(null);
					onFinish();
				} catch (err) {
					showToast(`${t("wizard.installFailed", locale)}: ${(err as Error).message}`);
					setPullingId(null);
					setPullProgress(null);
				}
			}
		});
	};

	const renderCard = (m: CatalogModel, isRecommended = false) => {
		const isPulling = pullingId === m.id;
		const pct = pullProgress?.total
			? Math.min(100, Math.round(((pullProgress.completed || 0) / pullProgress.total) * 100))
			: 0;
		// Models that fit the hardware but not the current free VRAM get a soft warning.
		const showRuntimeWarn = m.gpu_compatible && m.gpu_runtime_ok === false;
		return (
			<div
				key={m.id}
				className={`${styles.modelCard} ${isRecommended ? styles.modelCardRec : ""} ${!m.gpu_compatible ? styles.modelCardCpu : ""}`}
			>
				<div className={styles.modelHead}>
					<span className={styles.modelName}>{m.name}</span>
					{isRecommended && <span className={styles.modelRecBadge}>★</span>}
					{m.new && <span className={styles.modelNewBadge}>NEW</span>}
					{!m.gpu_compatible && <span className={styles.modelCpuBadge}>CPU</span>}
				</div>
				<div className={styles.modelMeta}>
					{m.vendor} · {fmtMb(m.size_mb)} · {m.gpu_compatible ? `${fmtMb(m.vram_mb)} ${memoryWord(modelsData?.gpu_name)}` : "CPU"}
				</div>
				{m.description && <div className={styles.modelDesc}>{m.description}</div>}
				{showRuntimeWarn && (
					<div className={styles.runtimeWarn}>{t("setup.model.runtimeWarn", locale)}</div>
				)}
				{isPulling ? (
					<div className={styles.pullBar}>
						<div className={styles.pullBarFill} style={{ width: `${pct}%` }} />
						<span className={styles.pullStatus}>
							{pullProgress?.status || t("setup.model.downloading", locale)} · {pct}%
						</span>
					</div>
				) : m.installed ? (
					<button
						className={styles.btnPrimary}
						onClick={() => {
							selectModel(m.id).then(() => {
								onFinish();
							});
						}}
					>
						{t("setup.model.installed", locale)} →
					</button>
				) : (
					<button
						className={styles.btnPrimary}
						onClick={() => handleDownload(m)}
						disabled={!!pullingId}
					>
						{t("setup.model.downloadBtn", locale, { size: fmtMb(m.size_mb) })}
					</button>
				)}
			</div>
		);
	};

	const totalGb = modelsData ? (modelsData.total_vram_mb / 1024).toFixed(1) : "?";
	const freeGb = modelsData ? (modelsData.free_vram_mb / 1024).toFixed(1) : "?";

	return (
		<div className={styles.step}>
			<h3 className={styles.stepTitle}>{t("setup.model.title", locale)}</h3>
			<p className={styles.stepBody}>{t("setup.model.body", locale)}</p>

			{!modelsData && <div className={styles.loading}>...</div>}

			{modelsData && (
				<div className={styles.hardwareBox}>
					<div className={styles.hardwareLabel}>{t("setup.model.hardwareTitle", locale)}</div>
					{modelsData.gpu_available ? (
						<>
							<div className={styles.hardwareName}>
								{modelsData.gpu_name} · {totalGb} GB {memoryWord(modelsData.gpu_name)}
								<span className={styles.hardwareFree}> ({freeGb} GB free now)</span>
							</div>
							<div className={styles.hardwareExplain}>
								{t("setup.model.hardwareExplain", locale, { total: totalGb })}
							</div>
						</>
					) : (
						<div className={styles.hardwareExplain}>{t("setup.model.hardwareNoGpu", locale)}</div>
					)}
				</div>
			)}

			{recommended && (
				<>
					<div className={styles.sectionLabel}>{t("setup.model.recommended", locale)}</div>
					<div className={styles.modelGrid}>{renderCard(recommended, true)}</div>
				</>
			)}

			{otherGpu.length > 0 && (
				<>
					<div className={styles.sectionLabel}>{t("setup.model.others", locale)}</div>
					<div className={styles.modelGrid}>{otherGpu.map((m) => renderCard(m))}</div>
				</>
			)}

			{cpuOnly.length > 0 && (
				<>
					<div className={styles.sectionLabel}>
						<button className={styles.expandBtn} onClick={() => setShowCpuModels((v) => !v)}>
							{showCpuModels ? "▾" : "▸"} {t("setup.model.cpuOnly", locale)} ({cpuOnly.length})
						</button>
					</div>
					{showCpuModels && (
						<>
							<div className={styles.cpuHint}>{t("setup.model.cpuHint", locale)}</div>
							<div className={styles.modelGrid}>{cpuOnly.map((m) => renderCard(m))}</div>
						</>
					)}
				</>
			)}
		</div>
	);
}

// --- Wizard shell ---
export function SetupWizard() {
	const { check, needsWizard, refresh, skip } = useSetup();
	const [locale, setLocaleState] = useState<Locale>(detectLocale);
	const [activeStep, setActiveStep] = useState<StepId>("ollama");
	const [dismissed, setDismissed] = useState(false);
	const forced = typeof window !== "undefined" && window.location.search.includes("wizard=force");

	// When the user finishes setup (picks a model), close the wizard.
	// In forced mode skip() alone won't work because `forced || ...` is always true.
	// So we track a local `dismissed` state that overrides everything.
	const finishWizard = useCallback(() => {
		skip(); // persist to localStorage so it never auto-shows again
		setDismissed(true); // close immediately, even in forced mode
	}, [skip]);

	const handleLocaleSwitch = () => {
		const next: Locale = locale === "es" ? "en" : "es";
		setLocaleState(next);
		setLocale(next);
	};

	// When a step finishes, refresh the check and advance.
	const advance = async () => {
		await refresh();
		const idx = STEP_ORDER.indexOf(activeStep);
		if (idx < STEP_ORDER.length - 1) setActiveStep(STEP_ORDER[idx + 1]);
	};

	// Auto-skip steps that are already complete on mount.
	// Skipped when forced via ?wizard=force so dev/QA can see every screen.
	useEffect(() => {
		if (!check || forced) return;
		if (activeStep === "ollama" && check.ollama.installed && check.ollama.running) {
			setActiveStep("ffmpeg");
			return;
		}
		if (activeStep === "ffmpeg" && check.ffmpeg.installed) {
			setActiveStep("model");
			return;
		}
	}, [check, activeStep, forced]);

	if (dismissed || !needsWizard || !check) return null;

	const stepIndex = STEP_ORDER.indexOf(activeStep);

	return createPortal(
		<div className={styles.backdrop}>
			<div className={styles.modal}>
				<div className={styles.head}>
					<div>
						<h2 className={styles.title}>{t("wizard.welcome", locale)}</h2>
						<p className={styles.subtitle}>{t("wizard.subtitle", locale)}</p>
					</div>
					<div className={styles.headRight}>
						<button className={styles.localeBtn} onClick={handleLocaleSwitch} title="Switch language">
							{locale === "es" ? "EN" : "ES"}
						</button>
						<button className={styles.skipBtn} onClick={skip}>
							{t("wizard.skip", locale)}
						</button>
					</div>
				</div>

				<div className={styles.progressTrack}>
					{STEP_ORDER.map((s, i) => (
						<div
							key={s}
							className={`${styles.progressDot} ${i <= stepIndex ? styles.progressDotActive : ""}`}
						/>
					))}
				</div>
				<div className={styles.progressLabel}>
					{t("wizard.step", locale, { current: stepIndex + 1, total: STEP_ORDER.length })}
				</div>

				<div className={styles.body}>
					{activeStep === "ollama" && <StepOllama check={check} locale={locale} onComplete={advance} forced={forced} />}
					{activeStep === "ffmpeg" && <StepFfmpeg check={check} locale={locale} onComplete={advance} forced={forced} />}
					{activeStep === "model" && <StepModel check={check} locale={locale} onComplete={advance} forced={forced} onFinish={finishWizard} />}
				</div>

				{forced && (
					<div className={styles.devNav}>
						{stepIndex > 0 && (
							<button
								className={styles.btnGhost}
								onClick={() => setActiveStep(STEP_ORDER[stepIndex - 1])}
							>
								← {t("wizard.back", locale)}
							</button>
						)}
						<span />
						{stepIndex < STEP_ORDER.length - 1 && (
							<button
								className={styles.btnGhost}
								onClick={() => setActiveStep(STEP_ORDER[stepIndex + 1])}
							>
								{t("wizard.next", locale)} →
							</button>
						)}
					</div>
				)}
			</div>
		</div>,
		document.body,
	);
}
