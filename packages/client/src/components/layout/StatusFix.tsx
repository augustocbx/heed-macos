import { useState, type ReactNode } from "react";
import type { SetupCheckResult, InstallProgress } from "@heed/shared";
import { setupApi } from "@/api/setup.ts";
import { useUIStore } from "@/stores/ui.ts";
import styles from "./StatusFix.module.css";

export type FixTarget = "ollama" | "engine" | "diar";

interface Props {
	target: FixTarget;
	setup: SetupCheckResult | null;
	onClose: () => void;
	onFixed: () => void;
}

function CopyCmd({ command }: { command: string }) {
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
			<button className={styles.cmdCopy} onClick={copy}>{copied ? "Copied" : "Copy"}</button>
		</div>
	);
}

// Ollama is the only badge we can fully repair in-app: install it (SSE stream of the official
// script) or, if it's installed but down, just start `ollama serve`. No terminal required.
function OllamaFix({ setup, onClose, onFixed }: Props) {
	const showToast = useUIStore((s) => s.showToast);
	const [busy, setBusy] = useState(false);
	const [progress, setProgress] = useState<InstallProgress[]>([]);
	const installed = setup?.ollama.installed ?? false;

	const start = async () => {
		if (busy) return;
		setBusy(true);
		try {
			const r = await setupApi.startOllama();
			if (r.running) {
				showToast("Ollama started");
				onFixed();
				onClose();
			} else {
				showToast(r.error || "Could not start Ollama");
			}
		} catch (e) {
			showToast((e as Error).message);
		} finally {
			setBusy(false);
		}
	};

	const install = () => {
		if (busy) return;
		setBusy(true);
		setProgress([]);
		setupApi.installOllama((evt) => {
			setProgress((p) => [...p, evt]);
			if (evt.status === "done") {
				setBusy(false);
				if (evt.code === 0) {
					showToast("Ollama installed");
					onFixed();
				} else {
					showToast("Install failed");
				}
			}
			if (evt.status === "error") {
				setBusy(false);
				showToast(`Install failed: ${evt.error}`);
			}
		});
	};

	return (
		<>
			<p className={styles.body}>
				{installed
					? "Ollama is installed but not running. It's the local engine that writes your AI notes."
					: "Ollama isn't installed yet. It's the local engine that writes your AI notes — audio never leaves your machine."}
			</p>
			<div className={styles.actions}>
				{installed ? (
					<button className={styles.btnPrimary} onClick={start} disabled={busy}>
						{busy ? "Starting…" : "Start Ollama"}
					</button>
				) : (
					<button className={styles.btnPrimary} onClick={install} disabled={busy}>
						{busy ? "Installing…" : "Install Ollama"}
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
	return (
		<>
			<p className={styles.body}>{body}</p>
			<CopyCmd command={command} />
		</>
	);
}

export function StatusFix({ target, setup, onClose, onFixed }: Props) {
	let title = "";
	let content: ReactNode = null;
	if (target === "ollama") {
		title = "AI notes engine";
		content = <OllamaFix target={target} setup={setup} onClose={onClose} onFixed={onFixed} />;
	} else if (target === "engine") {
		title = "Transcription engine";
		content = (
			<CommandFix
				body="The transcription engine didn't build or start. Install the fallback engine from a terminal, then reload heed:"
				command="npx create-heed fallback"
			/>
		);
	} else {
		title = "Speaker diarization";
		content = (
			<CommandFix
				body="The diarizer isn't ready. Re-run the setup doctor to repair it, then reload heed:"
				command="npx create-heed doctor"
			/>
		);
	}

	return (
		<>
			<div className={styles.backdrop} onClick={onClose} />
			<div className={styles.popover} role="dialog" aria-label={title}>
				<div className={styles.head}>
					<span className={styles.title}>{title}</span>
					<button className={styles.close} onClick={onClose} aria-label="Close">×</button>
				</div>
				{content}
			</div>
		</>
	);
}
