import { applySpeakerNames, reconcileSpeakerNames } from "@/lib/speakerNames";
import { tr, useLocale } from "@/lib/i18n.ts";
import { useEffect, useState } from "react";
import { recoveryApi, type OrphanedRecording } from "@/api/recovery.ts";
import type { TranscribeResult } from "@heed/shared";
import { transcribe } from "@/api/transcribe.ts";
import { sessionsApi } from "@/api/sessions.ts";
import { useSessionsStore } from "@/stores/sessions.ts";
import { useRecordingStore } from "@/stores/recording.ts";
import { useUIStore } from "@/stores/ui.ts";
import { fmtDate } from "@/lib/format.ts";
import styles from "./RecoveryBanner.module.css";

function fmtDurationShort(s: number): string {
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	const sec = s % 60;
	return sec > 0 ? `${m}m ${sec}s` : `${m}m`;
}

export function RecoveryBanner() {
	useLocale();
	const [orphans, setOrphans] = useState<OrphanedRecording[]>([]);
	const [recovering, setRecovering] = useState<string | null>(null);
	const [dismissed, setDismissed] = useState(false);
	const showToast = useUIStore((s) => s.showToast);
	const reloadSessions = useSessionsStore((s) => s.load);

 useEffect(() => {
  let disposed=false;
  const refresh=()=>{void recoveryApi.list().then(data=>{if(!disposed)setOrphans(data.recordings);}).catch(()=>{});};
  const released=()=>{setDismissed(false);refresh();};
  refresh();window.addEventListener("heed:recovery-refresh",released);
  return()=>{disposed=true;window.removeEventListener("heed:recovery-refresh",released);};
 }, []);

	if (dismissed || orphans.length === 0) return null;

	const handleRecover = async (rec: OrphanedRecording) => {
		setRecovering(rec.path);
		showToast(tr("Recovering recording..."));
		try {
   let completed: TranscribeResult | null = null;
   await transcribe(
    { url: rec.path, language: "auto", diarize: rec.is_dual, recording_finalize: true },
    { onResult: result => { completed = result; } },
   );
   const result = completed as TranscribeResult | null;
   if (!result?.success || result.finalized === false || !result.text?.trim() || !Array.isArray(result.segments)
    || !["en", "pt"].includes(result.metadata?.language)) {
    throw new Error(tr("Recovery ended without a final transcript. The audio remains available."));
   }
   const names=reconcileSpeakerNames(rec.segments || [],result.segments,rec.speakerNames || {});
   const restored=applySpeakerNames(result.segments,result.speakers || [],result.embeddings || {},names);
   await sessionsApi.create({
    ...(rec.recoveryMeetingId ? {id:rec.recoveryMeetingId} : {}),
    title: `Recovered ${fmtDate(rec.created)}`, createdAt: rec.created,
    duration: result.duration ?? rec.duration_estimate_s, language: result.metadata.language,
    transcriptionModel: result.metadata.model, transcriptFinalized: true, transcriptionDiagnostics: result.transcriptionDiagnostics,
    transcript: result.text,...restored,
    files: { wav: rec.path, srt: result.files?.srt || "", txt: result.files?.txt || "" },
    aiNotes: "", summary: "", tags: [], pinned: false,
   });
   await reloadSessions();
   setOrphans(prev => prev.filter(o => o.path !== rec.path));
   setRecovering(null);
   showToast(tr("Recording recovered"));
		} catch (e) {
			showToast(tr("Error: {message}", undefined, {message:tr((e as Error).message)}));
			setRecovering(null);
		}
	};

	const handleDiscard = async (rec: OrphanedRecording) => {
		try {
			await recoveryApi.discard(rec.path);
			setOrphans((prev) => prev.filter((o) => o.path !== rec.path));
			showToast(tr("Recording discarded"));
		} catch (e) {
			showToast(tr("Error: {message}", undefined, {message:tr((e as Error).message)}));
		}
	};

	return (
		<div className={styles.banner}>
			<div className={styles.header}>
				<span className={styles.title}>
					{tr("{count} unprocessed recording(s) found", undefined, {count:orphans.length})}
				</span>
				<button className={styles.dismissBtn} onClick={() => setDismissed(true)}>×</button>
			</div>
			<p className={styles.subtitle}>
				{tr("These recordings weren't processed (the app may have crashed). You can recover or discard them.")}
			</p>
			<div className={styles.list}>
				{orphans.map((rec) => (
					<div key={rec.path} className={styles.item}>
						<div className={styles.itemInfo}>
							<span className={styles.itemDate}>{fmtDate(rec.created)}</span>
							<span className={styles.itemMeta}>
								~{fmtDurationShort(rec.duration_estimate_s)} · {rec.size_mb} MB
								{rec.is_dual ? " " + tr("· stereo") : ""}
							</span>
						</div>
						<div className={styles.itemActions}>
							<button
								className={styles.recoverBtn}
								onClick={() => handleRecover(rec)}
								disabled={!!recovering}
							>
								{recovering === rec.path
									? (tr("Processing..."))
									: (tr("Recover"))}
							</button>
							<button
								className={styles.discardBtn}
								onClick={() => handleDiscard(rec)}
								disabled={!!recovering}
							>
								{tr("Discard")}
							</button>
						</div>
					</div>
				))}
			</div>
		</div>
	);
}
