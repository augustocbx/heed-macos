import { useLocale } from "@/lib/i18n.ts";
import styles from "./Footer.module.css";

export function Footer() {
 const {tr}=useLocale();
	const replayTour = () => {
		localStorage.removeItem("heed-tour-done");
		window.location.reload();
	};

	return (
		<footer className={styles.footer}>
			<div className={styles.text}>
				{tr("heed · local-first meeting notes · MIT")}
			</div>
			<a className={styles.credit} href="https://github.com/isjunrod/heed" target="_blank" rel="noreferrer">{tr("Based on Heed by Junior Rodriguez")}</a>
			<button className={styles.tourLink} onClick={replayTour}>
				{tr("replay tour")}
			</button>
		</footer>
	);
}
