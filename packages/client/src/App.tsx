import { useUIStore } from "@/stores/ui.ts";
import { Nav } from "@/components/layout/Nav.tsx";
import { Toast } from "@/components/layout/Toast.tsx";
import { Footer } from "@/components/layout/Footer.tsx";
import { RecordPage } from "@/components/recording/RecordPage.tsx";
import { SessionsPage } from "@/components/sessions/SessionsPage.tsx";
import { RecoveryBanner } from "@/components/recovery/RecoveryBanner.tsx";
import { SetupWizard } from "@/components/setup/SetupWizard.tsx";
import { AppTour } from "@/components/tour/AppTour.tsx";
import styles from "./App.module.css";

export function App() {
	const currentPage = useUIStore((s) => s.currentPage);

	return (
		<>
			<Nav />
			<main className={styles.main}>
				<RecoveryBanner />
				<div hidden={currentPage !== "record"}><RecordPage /></div>
				{currentPage === "sessions" && <SessionsPage />}
			</main>
			<Footer />
			<Toast />
			<SetupWizard />
			<AppTour />
		</>
	);
}
