import { useLocaleStore } from "@/stores/locale.ts";
import { useEffect } from "react";
import { useAutomaticNotesPolling } from "@/hooks/useAutomaticNotesPolling";
import { PermissionsPage } from "@/components/settings/PermissionsPage.tsx";
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
 useAutomaticNotesPolling();
 const refreshLocale = useLocaleStore(s=>s.refresh);
 const syncLocale = useLocaleStore(s=>s.sync);
 useEffect(() => {
  void refreshLocale();
  const interval=window.setInterval(()=>void refreshLocale(),3000);
  const focus=()=>void refreshLocale();
  const storage=(event:StorageEvent)=>{if(event.key === "heed-locale") syncLocale(event.newValue);};
  window.addEventListener("focus",focus);window.addEventListener("storage",storage);
  return()=>{window.clearInterval(interval);window.removeEventListener("focus",focus);window.removeEventListener("storage",storage);};
 },[refreshLocale,syncLocale]);
	const currentPage = useUIStore((s) => s.currentPage);
	useEffect(() => {
		const onHash = () => { if (window.location.hash === "#settings") useUIStore.getState().setPage("settings"); };
		window.addEventListener("hashchange", onHash);
		return () => window.removeEventListener("hashchange", onHash);
	}, []);

	return (
		<>
			<Nav />
			<main className={styles.main}>
				<RecoveryBanner />
				<div hidden={currentPage !== "record"}><RecordPage /></div>
				{currentPage === "sessions" && <SessionsPage />}
				{currentPage === "settings" && <PermissionsPage />}
			</main>
			<Footer />
			<Toast />
			<SetupWizard />
			<AppTour />
		</>
	);
}
