import { fmtTime } from "@/lib/format.ts";
import styles from "./Timer.module.css";

interface Props {
	seconds: number;
}

export function Timer({ seconds }: Props) {
	return <div className={styles.timer}>{fmtTime(seconds)}</div>;
}
