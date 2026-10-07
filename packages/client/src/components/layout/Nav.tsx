import { useLocale } from "@/lib/i18n.ts";
import { useEffect, useState, useCallback, useRef } from "react";
import type { SetupCheckResult } from "@heed/shared";
import { useUIStore, type Page } from "@/stores/ui.ts";
import { useHealthStore } from "@/stores/health.ts";
import { useModelsStore } from "@/stores/models.ts";
import { setupApi } from "@/api/setup.ts";
import { desktopApi } from "@/api/desktop.ts";
import { ModelPicker } from "@/components/models/ModelPicker.tsx";
import { StatusFix, type FixTarget } from "./StatusFix.tsx";
import { Dialog } from "./Dialog.tsx";
import styles from "./Nav.module.css";

const TABS: Array<{ id: Page; label: string }> = [
	{ id: "record", label: "Record" },
	{ id: "sessions", label: "Meetings" },
	{ id: "tasks", label: "Tasks" },
	{ id: "chat", label: "Meeting chat" },
	{ id: "settings", label: "Settings" },
];
const QUALITY: Record<string, string> = { very_good: "very good", excellent: "high", best: "max" };
const SPEED: Record<string, string> = { fast: "fast", medium: "medium", slower: "slower" };

export function Nav() {
	const { tr } = useLocale();
	const buildVersion = import.meta.env.VITE_HEED_VERSION;
	const version = typeof buildVersion === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(buildVersion) ? buildVersion : null;
	const developmentLabel = import.meta.env.DEV ? ` · ${tr("Development build")}` : "";
	const versionLabel = version ? `v${version}${developmentLabel}` : tr("Version unavailable");
	const currentPage = useUIStore((s) => s.currentPage);
	const setPage = useUIStore((s) => s.setPage);
	const showToast = useUIStore((s) => s.showToast);
	const health = useHealthStore((s) => s.health);
	const diagnosticsUnavailable = useHealthStore((s) => s.diagnosticsUnavailable);
	const apiUnknown = diagnosticsUnavailable || health.services?.find((item) => item.service === "api")?.state === "unavailable";
	const transcriptionUnknown = apiUnknown || health.services?.find((item) => item.service === "transcription")?.state === "unavailable";
	const checkHealth = useHealthStore((s) => s.check);
	const modelsData = useModelsStore((s) => s.data);
	const modelsLoading = useModelsStore((s) => s.loading);
	const modelsError = useModelsStore((s) => s.error);
	const loadModels = useModelsStore((s) => s.load);
	const pickerOpen = useModelsStore((s) => s.pickerOpen);
	const openPicker = useModelsStore((s) => s.openPicker);
	const closePicker = useModelsStore((s) => s.closePicker);
	const [setup, setSetup] = useState<SetupCheckResult | null>(null);
	const [fixOpen, setFixOpen] = useState<FixTarget | null>(null);
	const [healthLoaded, setHealthLoaded] = useState(false);
	const [systemOpen, setSystemOpen] = useState(false);
	const [toolError, setToolError] = useState<string | null>(null);
	const [pagesOpen, setPagesOpen] = useState(false);
	const pagesButton = useRef<HTMLButtonElement>(null);
	const pagesRegion = useRef<HTMLDivElement>(null);

	const refreshSetup = useCallback(async () => {
		try { setSetup(await setupApi.check()); }
		catch { /* Keep the last known setup while the server reconnects. */ }
	}, []);
	const onFixed = useCallback(() => {
		void checkHealth();
		void refreshSetup();
	}, [checkHealth, refreshSetup]);
	const openFloat = async () => {
		setToolError(null);
		showToast(tr("Opening floating panel…"));
		try {
			const result = await desktopApi.float();
			if (!result.ok) setToolError(result.error || tr("Could not open floating panel"));
		} catch { setToolError(tr("Could not open floating panel")); }
	};

	useEffect(() => {
		let mounted = true;
		void checkHealth().then(() => { if (mounted) setHealthLoaded(true); });
		void loadModels();
		void refreshSetup();
		const id = setInterval(() => { void checkHealth(); void refreshSetup(); }, 60000);
		return () => { mounted = false; clearInterval(id); };
	}, [checkHealth, loadModels, refreshSetup]);

	const closePages = () => {
		setPagesOpen(false);
		if (pagesButton.current && getComputedStyle(pagesButton.current).display !== "none") pagesButton.current.focus();
	};
	// The disclosure is non-modal: Tab can leave it; outside clicks dismiss it without stealing focus.
	useEffect(() => {
		if (!pagesOpen) return;
		const outside = (event: PointerEvent) => {
			if (!pagesRegion.current?.contains(event.target as Node)) setPagesOpen(false);
		};
		document.addEventListener("pointerdown", outside);
		return () => document.removeEventListener("pointerdown", outside);
	}, [pagesOpen]);

	const currentModel = modelsData?.models.find((m) => m.id === modelsData.current?.id);
	const modelName = currentModel?.name || modelsData?.current?.id || tr("no model");
	const whisperInfo = health.whisper_info;
	const pyannoteInfo = health.pyannote_info;
	const engine = health.languages?.engine;
	const engineLabel = !whisperInfo ? tr("detecting") : engine === "parakeet" ? "Parakeet v3"
		: engine === "mlx" ? `MLX ${whisperInfo.final_model}` : `Whisper ${whisperInfo.final_model}`;
	const diarLabel = !pyannoteInfo ? tr("detecting") : pyannoteInfo.model?.toLowerCase().includes("fluidaudio") ? "FluidAudio" : "pyannote";
	const needsAttention = healthLoaded && (!health.ollama || !health.whisper || !health.pyannote || !!modelsError);
	const summary = needsAttention ? tr("Needs attention") : !healthLoaded || modelsLoading ? tr("Checking…")
		: !modelsData?.current?.id ? tr("Choose a model") : tr("Ready");
	const readiness = (ready: boolean, unknown: boolean) => !healthLoaded ? tr("Checking…") : unknown ? tr("Not checked") : ready ? tr("Ready") : tr("Unavailable");
	const status = (ready: boolean, unknown = false) => (
		<span className={`${styles.readiness} ${healthLoaded && !ready && !unknown ? styles.unavailable : ""}`}>
			<span className={`${styles.dot} ${!healthLoaded || unknown ? "" : ready ? styles.dotOk : styles.dotErr}`} aria-hidden="true" />
			{readiness(ready, unknown)}
		</span>
	);
	const fixButton = (target: FixTarget, title: string, ready: boolean) => healthLoaded && !ready && (
		<button className={styles.action} aria-label={`${tr("Troubleshoot")}: ${tr(title)}`} onClick={() => setFixOpen(target)}>{tr("Troubleshoot")}</button>
	);

	return (
		<>
			<header className={styles.nav}>
				<div className={styles.inner}>
					<div className={styles.brandGroup}>
						<a href="/" className={styles.brand}>{tr("heed")}</a>
						<span role="note" className={styles.version} aria-label={version ? `${tr("Installed version: {version}", { version })}${developmentLabel}` : undefined}>{versionLabel}</span>
					</div>
					<nav className={styles.navigation} aria-label={tr("Main navigation")} ref={pagesRegion}
						onKeyDown={(event) => { if (event.key === "Escape" && pagesOpen) { event.preventDefault(); closePages(); } }}>
						<button ref={pagesButton} className={styles.pagesButton} aria-expanded={pagesOpen} aria-controls="heed-pages"
							onClick={() => setPagesOpen((open) => !open)}>
							<span>{tr("Pages")}: <strong>{tr(TABS.find((tab) => tab.id === currentPage)!.label)}</strong></span>
							<span aria-hidden="true">{pagesOpen ? "⌃" : "⌄"}</span>
						</button>
						<div id="heed-pages" className={`${styles.tabs} ${pagesOpen ? styles.tabsOpen : ""}`}>
							{TABS.map((tab) => (
								<button key={tab.id} className={`${styles.tab} ${currentPage === tab.id ? styles.tabActive : ""}`}
									aria-current={currentPage === tab.id ? "page" : undefined}
									onClick={() => { setPage(tab.id); if (pagesOpen) closePages(); }}
									data-tour={tab.id === "sessions" ? "sessions-tab" : undefined}>
									{tr(tab.label)}
								</button>
							))}
						</div>
					</nav>
					<button className={`${styles.systemButton} ${needsAttention ? styles.systemError : ""}`}
						aria-haspopup="dialog" aria-expanded={systemOpen} onClick={() => { setToolError(null); setSystemOpen(true); }} data-tour="model-chip">
						<span>{tr("System")}</span>
						<span className={styles.summary}>{summary}</span>
						<span aria-hidden="true">⌄</span>
					</button>
				</div>
			</header>
			{systemOpen && (
				<Dialog label={tr("System details")} onClose={() => setSystemOpen(false)}>
					<div className={styles.dialogHead}>
						<h2>{tr("System details")}</h2>
						<button className={styles.action} onClick={() => setSystemOpen(false)}>{tr("Close")}</button>
					</div>
					<div className={styles.tools}>
						<button className={styles.action} onClick={openFloat} aria-label={tr("Open floating panel")}>
							<span aria-hidden="true">⧉ </span>{tr("Float")}
						</button>
						<button className={styles.action} onClick={openPicker}>{tr("Change model")}</button>
					</div>
					{toolError && <p role="alert" className={styles.unavailable}>{toolError}</p>}
					{modelsError && <p role="alert" className={styles.unavailable}>{tr("Could not load models")}: {modelsError}</p>}
					<section className={styles.section} aria-label={tr("AI notes engine")}>
						<div className={styles.sectionHead}><h3>{tr("AI notes engine")}</h3>{status(health.ollama, apiUnknown)}</div>
						<p><strong>Ollama</strong> · {tr("Local LLM that writes the meeting notes from the transcript.")}</p>
						<p><strong>{tr("Model:")}</strong> {modelName}</p>
						<div className={styles.badges}>
							{modelsData?.current?.num_gpu === 0 && <span>{tr("CPU")}</span>}
							{currentModel?.new && <span>{tr("NEW")}</span>}
						</div>
						<p className={styles.reason}>{tr("Separate from transcription — heed transcribes locally, then Ollama summarizes.")}</p>
						{fixButton("ollama", "AI notes engine", health.ollama)}
					</section>
					<section className={styles.section} aria-label={tr("Transcription engine")}>
						<div className={styles.sectionHead}><h3>{tr("Transcription engine")}</h3>{status(health.whisper, transcriptionUnknown)}</div>
						<p><strong>{engineLabel}</strong></p>
						{!whisperInfo ? <p>{tr("No verified transcription profile.")}</p> : engine === "parakeet" ? <>
							<p><strong>{tr("Model:")}</strong> parakeet-tdt-v3</p>
							<p><strong>{tr("Runs on:")}</strong> Apple Neural Engine</p>
							<p><strong>{tr("Languages:")}</strong> {tr("28 European")}</p>
						</> : <>
							<p><strong>{tr("Final:")}</strong> {whisperInfo?.final_model || tr("detecting")}</p>
							<p><strong>{tr("Live:")}</strong> {whisperInfo?.live_model || tr("detecting")}</p>
							<p><strong>{tr("Power:")}</strong> {whisperInfo ? `${tr(QUALITY[whisperInfo.quality])} / ${tr(SPEED[whisperInfo.speed])}` : tr("detecting")}</p>
							<p><strong>{tr("Device:")}</strong> {whisperInfo?.device || tr("detecting")}</p>
						</>}
						<p className={styles.reason}>{tr(whisperInfo?.reason || "Detecting hardware and choosing the best engine.")}</p>
						{fixButton("engine", "Transcription engine", health.whisper)}
					</section>
					<section className={styles.section} aria-label={tr("Speaker diarization")}>
						<div className={styles.sectionHead}><h3>{tr("Speaker diarization")}</h3>{status(health.pyannote, transcriptionUnknown)}</div>
						<p><strong>{diarLabel}</strong> · {tr("who said what")}</p>
						{!pyannoteInfo ? <p>{tr("No verified diarization profile.")}</p> : diarLabel === "FluidAudio" ? <>
							<p><strong>{tr("Model:")}</strong> FluidAudio CoreML</p>
							<p><strong>{tr("Runs on:")}</strong> Apple Neural Engine</p>
							<p><strong>{tr("Token:")}</strong> {tr("none needed")}</p>
						</> : <>
							<p><strong>{tr("Model:")}</strong> {pyannoteInfo?.model || tr("detecting")}</p>
							<p><strong>{tr("Device:")}</strong> {pyannoteInfo?.device || tr("detecting")}</p>
							<p><strong>{tr("Profile:")}</strong> {pyannoteInfo?.profile || tr("detecting")}</p>
							<p><strong>{tr("Batch:")}</strong> {pyannoteInfo?.batch_size ?? tr("detecting")}</p>
							{pyannoteInfo?.cpu_threads ? <p><strong>{tr("CPU threads:")}</strong> {pyannoteInfo.cpu_threads}</p> : null}
						</>}
						<p className={styles.reason}>{tr(pyannoteInfo?.reason || "Tuning based on available hardware.")}</p>
						{fixButton("diar", "Speaker diarization", health.pyannote)}
					</section>
					{fixOpen && <StatusFix target={fixOpen} setup={setup} onClose={() => setFixOpen(null)} onFixed={onFixed} />}
				</Dialog>
			)}
			<ModelPicker open={pickerOpen} onClose={closePicker} />
		</>
	);
}
