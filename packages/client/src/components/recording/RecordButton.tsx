import { tr, useLocale } from "@/lib/i18n.ts";
import styles from "./RecordButton.module.css";

interface Props {
	recording: boolean;
	onClick: () => void;
	disabled?: boolean;
}

export function RecordButton({ recording, onClick, disabled }: Props) {
	useLocale();
	return (
		<button
			className={`${styles.btn} ${recording ? styles.recording : ""}`}
			onClick={onClick}
			disabled={disabled}
			aria-label={recording ? tr("Stop recording") : tr("Start recording")}
			data-tour="record"
		>
			<div className={styles.icon} />
		</button>
	);
}
