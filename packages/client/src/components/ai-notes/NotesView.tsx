import { mdToHtml } from "@/lib/markdown.ts";
import styles from "./NotesView.module.css";

interface Props {
	notes: string;
	streaming?: boolean;
	placeholder?: string;
}

export function NotesView({ notes, streaming = false, placeholder = "No AI notes generated" }: Props) {
	if (!notes) {
		return <div className={styles.notes}><span className={styles.placeholder}>{placeholder}</span></div>;
	}
	if (streaming) {
		return <div className={styles.notes}><pre className={styles.streaming}>{notes}</pre></div>;
	}
	return <div className={styles.notes} dangerouslySetInnerHTML={{ __html: mdToHtml(notes) }} />;
}
