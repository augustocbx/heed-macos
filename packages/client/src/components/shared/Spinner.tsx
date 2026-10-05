import styles from "./Spinner.module.css";

/** Small inline spinner that inherits the current text color — drop it inside a button while it works. */
export function Spinner() {
	return <span className={styles.spinner} aria-hidden="true" />;
}
