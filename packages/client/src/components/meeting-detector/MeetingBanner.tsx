import { tr, useLocale } from "@/lib/i18n.ts";
import { useMeetingDetector } from "@/hooks/useMeetingDetector.ts";
import { useUIStore } from "@/stores/ui.ts";
import styles from "./MeetingBanner.module.css";

export function MeetingBanner() {
	useLocale();
	const { detected, dismiss, clear } = useMeetingDetector();
	const setPage = useUIStore((s) => s.setPage);

	const handleRecord = () => {
		clear();
		setPage("record");
		// Trigger record by dispatching a custom event the RecordPage will listen to
		window.dispatchEvent(new CustomEvent("heed:start-recording"));
	};

	return (
		<div className={`${styles.banner} ${detected ? styles.show : ""}`}>
			<div className={styles.text}>
				{detected && (
					<>
						<strong>{detected.app}</strong> {tr("is running. Start recording?")}</>
				)}
			</div>
			<div className={styles.actions}>
				<button className={`${styles.btn} ${styles.primary}`} onClick={handleRecord}>{tr("Record")}</button>
				<button className={`${styles.btn} ${styles.secondary}`} onClick={dismiss}>{tr("Dismiss")}</button>
			</div>
		</div>
	);
}
