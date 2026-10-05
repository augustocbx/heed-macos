import styles from "./RecordButton.module.css";

interface Props {
	recording: boolean;
	onClick: () => void;
	disabled?: boolean;
}

export function RecordButton({ recording, onClick, disabled }: Props) {
	return (
		<button
			className={`${styles.btn} ${recording ? styles.recording : ""}`}
			onClick={onClick}
			disabled={disabled}
			aria-label={recording ? "Stop recording" : "Start recording"}
			data-tour="record"
		>
			<div className={styles.icon} />
		</button>
	);
}
