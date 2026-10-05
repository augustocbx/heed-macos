import { useEffect, useState, useCallback } from "react";
import type { SetupCheckResult } from "@heed/shared";
import { setupApi } from "@/api/setup.ts";

interface UseSetupResult {
	check: SetupCheckResult | null;
	loading: boolean;
	needsWizard: boolean;
	refresh: () => Promise<void>;
	skip: () => void;
}

const SKIP_KEY = "heed-setup-skipped";

/**
 * Detects whether the first-launch wizard needs to run.
 *
 * The wizard fires when:
 *   - the /api/setup/check endpoint reports `all_ready: false`, AND
 *   - the user has not previously chosen "skip" (persisted in localStorage)
 *
 * The skip is persistent because power users (devs) shouldn't get nagged on
 * every page refresh. They can manually re-run setup from a future menu.
 */
export function useSetup(): UseSetupResult {
	const [check, setCheck] = useState<SetupCheckResult | null>(null);
	const [loading, setLoading] = useState(true);
	const [skipped, setSkipped] = useState<boolean>(() => {
		if (typeof window === "undefined") return false;
		return localStorage.getItem(SKIP_KEY) === "1";
	});

	const refresh = useCallback(async () => {
		setLoading(true);
		try {
			const result = await setupApi.check();
			setCheck(result);
		} catch {
			// If the check itself fails (server down), assume nothing is ready.
			setCheck(null);
		} finally {
			setLoading(false);
		}
	}, []);

	const skip = useCallback(() => {
		localStorage.setItem(SKIP_KEY, "1");
		setSkipped(true);
	}, []);

	useEffect(() => {
		refresh();
	}, [refresh]);

	// Dev/QA escape hatch: append ?wizard=force to the URL to view the wizard even
	// when everything is already installed. Lets you preview the UI without
	// uninstalling ollama every time.
	const forced = typeof window !== "undefined" && window.location.search.includes("wizard=force");

	const needsWizard = forced || (!skipped && !!check && !check.all_ready);

	return { check, loading, needsWizard, refresh, skip };
}
