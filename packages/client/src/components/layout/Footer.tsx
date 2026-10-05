import styles from "./Footer.module.css";

export function Footer() {
	const replayTour = () => {
		localStorage.removeItem("heed-tour-done");
		window.location.reload();
	};

	return (
		<footer className={styles.footer}>
			<div className={styles.text}>
				heed · local-first meeting notes · MIT
			</div>
			<button className={styles.tourLink} onClick={replayTour}>
				replay tour
			</button>
		</footer>
	);
}
