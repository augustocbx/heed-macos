import { useUIStore } from "@/stores/ui.ts";
import styles from "./Toast.module.css";

export function Toast() {
	const toast = useUIStore((s) => s.toast);
	return <div className={`${styles.toast} ${toast ? styles.show : ""}`}>{toast}</div>;
}
