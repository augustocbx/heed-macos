import { useEffect, useState } from "react";
import { recoveryApi, type OrphanedRecording } from "@/api/recovery.ts";
import { transcribe } from "@/api/transcribe.ts";
import { sessionsApi } from "@/api/sessions.ts";
import { useSessionsStore } from "@/stores/sessions.ts";
import { useRecordingStore } from "@/stores/recording.ts";
import { useUIStore } from "@/stores/ui.ts";
import { fmtDate } from "@/lib/format.ts";
import { detectLocale, t } from "@/lib/i18n.ts";
import styles from "./RecoveryBanner.module.css";

function fmtDurationShort(s: number): string {
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	const sec = s % 60;
	return sec > 0 ? `${m}m ${sec}s` : `${m}m`;
}

export function RecoveryBanner() {
	const [orphans, setOrphans] = useState<OrphanedRecording[]>([]);
	const [recovering, setRecovering] = useState<string | null>(null);
	const [dismissed, setDismissed] = useState(false);
	const showToast = useUIStore((s) => s.showToast);
	const reloadSessions = useSessionsStore((s) => s.load);
	const locale = detectLocale();

	useEffect(() => {
		recoveryApi.list().then((d) => setOrphans(d.recordings)).catch(() => {});
	}, []);

	if (dismissed || orphans.length === 0) return null;

	const handleRecover = async (rec: OrphanedRecording) => {
		setRecovering(rec.path);
		showToast(locale === "es" ? "Recuperando grabacion..." : "Recovering recording...");
		try {
			await transcribe(
				{ url: rec.path, language: "auto", diarize: rec.is_dual },
				{
					onStep: () => {},
					onProgress: () => {},
					onResult: async (result) => {
						await sessionsApi.create({
							title: `Recovered ${fmtDate(rec.created)}`,
							createdAt: rec.created,
							duration: rec.duration_estimate_s,
							language: result.metadata?.language || "auto",
							transcript: result.text,
							speakers: result.speakers || [],
							segments: result.segments || [],
							embeddings: result.embeddings || {},
							files: { wav: rec.path, srt: result.files?.srt || "", txt: result.files?.txt || "" },
							aiNotes: "",
							summary: "",
							tags: [],
							pinned: false,
						});
						reloadSessions();
						setOrphans((prev) => prev.filter((o) => o.path !== rec.path));
						setRecovering(null);
						showToast(locale === "es" ? "Grabacion recuperada" : "Recording recovered");
					},
					onError: (msg) => {
						showToast(`Error: ${msg}`);
						setRecovering(null);
					},
				},
			);
		} catch (e) {
			showToast(`Error: ${(e as Error).message}`);
			setRecovering(null);
		}
	};

	const handleDiscard = async (rec: OrphanedRecording) => {
		try {
			await recoveryApi.discard(rec.path);
			setOrphans((prev) => prev.filter((o) => o.path !== rec.path));
			showToast(locale === "es" ? "Grabacion descartada" : "Recording discarded");
		} catch (e) {
			showToast(`Error: ${(e as Error).message}`);
		}
	};

	return (
		<div className={styles.banner}>
			<div className={styles.header}>
				<span className={styles.title}>
					{locale === "es"
						? `${orphans.length} grabacion(es) sin procesar encontrada(s)`
						: `${orphans.length} unprocessed recording(s) found`}
				</span>
				<button className={styles.dismissBtn} onClick={() => setDismissed(true)}>×</button>
			</div>
			<p className={styles.subtitle}>
				{locale === "es"
					? "Estas grabaciones no se procesaron (la app pudo haberse cerrado). Puedes recuperarlas o descartarlas."
					: "These recordings weren't processed (the app may have crashed). You can recover or discard them."}
			</p>
			<div className={styles.list}>
				{orphans.map((rec) => (
					<div key={rec.path} className={styles.item}>
						<div className={styles.itemInfo}>
							<span className={styles.itemDate}>{fmtDate(rec.created)}</span>
							<span className={styles.itemMeta}>
								~{fmtDurationShort(rec.duration_estimate_s)} · {rec.size_mb} MB
								{rec.is_dual ? " · stereo" : ""}
							</span>
						</div>
						<div className={styles.itemActions}>
							<button
								className={styles.recoverBtn}
								onClick={() => handleRecover(rec)}
								disabled={!!recovering}
							>
								{recovering === rec.path
									? (locale === "es" ? "Procesando..." : "Processing...")
									: (locale === "es" ? "Recuperar" : "Recover")}
							</button>
							<button
								className={styles.discardBtn}
								onClick={() => handleDiscard(rec)}
								disabled={!!recovering}
							>
								{locale === "es" ? "Descartar" : "Discard"}
							</button>
						</div>
					</div>
				))}
			</div>
		</div>
	);
}
