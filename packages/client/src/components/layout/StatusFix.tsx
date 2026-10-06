import { tr, useLocale } from "@/lib/i18n.ts";
import { useState, type ReactNode } from "react";
import type { SetupCheckResult, InstallProgress } from "@heed/shared";
import { setupApi } from "@/api/setup.ts";
import { useUIStore } from "@/stores/ui.ts";
import { Dialog } from "./Dialog.tsx";
import styles from "./StatusFix.module.css";
import {useHealthStore} from '@/stores/health';
import {ServiceNotice,ServiceDiagnosisUnavailable} from './ServiceNotices';

export type FixTarget = "ollama" | "engine" | "diar";

interface Props {
	target: FixTarget;
	setup: SetupCheckResult | null;
	onClose: () => void;
	onFixed: () => void;
}

function CopyCmd({ command }: { command: string }) {
	useLocale();
	const [copied, setCopied] = useState(false);
	const copy = async () => {
		try {
			await navigator.clipboard.writeText(command);
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		} catch {}
	};
	return (
		<div className={styles.cmdBox}>
			<code className={styles.cmdText}>{command}</code>
			<button className={styles.cmdCopy} onClick={copy}>{copied ? tr("Copied") : tr("Copy")}</button>
		</div>
	);
}

// Ollama is the only badge we can fully repair in-app: install it (SSE stream of the official
// script) or, if it's installed but down, just start `ollama serve`. No terminal required.
function OllamaFix({ setup, onClose, onFixed }: Props) {
	useLocale();
	const showToast = useUIStore((s) => s.showToast);
	const [busy, setBusy] = useState(false);
	const [progress, setProgress] = useState<InstallProgress[]>([]);
	const [error, setError] = useState<string | null>(null);
	const reportError = (message: string) => { setError(message); showToast(message); };
	const installed = setup?.ollama.installed ?? false;

	const start = async () => {
		if (busy) return;
		setBusy(true);
		setError(null);
		try {
			const r = await setupApi.startOllama();
			if (r.running) {
				showToast(tr("Ollama started"));
				onFixed();
				onClose();
			} else {
				reportError(r.error || tr("Could not start Ollama"));
			}
		} catch (e) {
			reportError((e as Error).message);
		} finally {
			setBusy(false);
		}
	};

	const install = () => {
		if (busy) return;
		setBusy(true);
		setError(null);
		setProgress([]);
		setupApi.installOllama((evt) => {
			setProgress((p) => [...p, evt]);
			if (evt.status === "done") {
				setBusy(false);
				if (evt.code === 0) {
					showToast(tr("Ollama installed"));
					onFixed();
				} else {
					reportError(tr("Install failed"));
				}
			}
			if (evt.status === "error") {
				setBusy(false);
				reportError(`${tr("Install failed")}: ${evt.error}`);
			}
		});
	};

	return (
		<>
			{error && <p role="alert" className={styles.error}>{error}</p>}
			<p className={styles.body}>
				{installed
					? tr("Ollama is installed but not running. It's the local engine that writes your AI notes.")
					: tr("Ollama isn't installed yet. It's the local engine that writes your AI notes — audio never leaves your machine.")}
			</p>
			<div className={styles.actions}>
				{installed ? (
					<button className={styles.btnPrimary} onClick={start} disabled={busy}>
						{busy ? tr("Starting…") : tr("Start Ollama")}
					</button>
				) : (
					<button className={styles.btnPrimary} onClick={install} disabled={busy}>
						{busy ? tr("Installing…") : tr("Install Ollama")}
					</button>
				)}
			</div>
			{!installed && <CopyCmd command="curl -fsSL https://ollama.com/install.sh | sh" />}
			{progress.length > 0 && (
				<div className={styles.stream} role="log" aria-live="polite">
					{progress.slice(-10).map((p, i) => (
						<div key={i} className={`${styles.streamLine} ${p.source === "stderr" ? styles.streamErr : ""}`}>
							{p.line || p.status || ""}
						</div>
					))}
				</div>
			)}
		</>
	);
}

// The transcription/diarization engines are native (Swift sidecar / CoreML) — they can't be rebuilt
// from the browser, so we hand the user the exact one-liner instead of a cryptic error.
function CommandFix({ body, command }: { body: string; command: string }) {
	useLocale();
	return (
		<>
			<p className={styles.body}>{body}</p>
			<CopyCmd command={command} />
		</>
	);
}

export function StatusFix({ target, setup, onClose, onFixed }: Props) {
	useLocale();
 const serviceNotice=useHealthStore(state=>state.health.services?.find(item=>item.service==='transcription'&&item.state!=='ready'));
 const diagnosticsUnavailable=useHealthStore(state=>state.diagnosticsUnavailable);
	let title = "";
	let content: ReactNode = null;
	if (target === "ollama") {
		title = tr("AI notes engine");
		content = <OllamaFix target={target} setup={setup} onClose={onClose} onFixed={onFixed} />;
 } else if(diagnosticsUnavailable){title=tr(target==='engine'?'Transcription engine':'Speaker diarization');content=<ServiceDiagnosisUnavailable/>;
 } else if(serviceNotice){title=tr(target==='engine'?'Transcription engine':'Speaker diarization');content=<ServiceNotice notice={serviceNotice}/>;
	} else if (target === "engine") {
		title = tr("Transcription engine");
		content = (
			<CommandFix
				body={tr("The transcription engine didn't build or start. Install the fallback engine from a terminal, then reload heed:")}
				command="npx create-heed fallback"
			/>
		);
	} else {
		title = tr("Speaker diarization");
		content = (
			<CommandFix
				body={tr("The diarizer isn't ready. Re-run the setup doctor to repair it, then reload heed:")}
				command="npx create-heed doctor"
			/>
		);
	}

	return (
		<Dialog label={title} onClose={onClose} className={styles.popover}>
			<div className={styles.head}>
				<span className={styles.title}>{title}</span>
				<button className={styles.close} onClick={onClose} aria-label={tr("Close")}>×</button>
			</div>
			{content}
		</Dialog>
	);
}
