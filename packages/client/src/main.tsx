import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./styles/globals.css";

const root = document.getElementById("root");
if (!root) throw new Error("Root element not found");

// React 19: surface render errors through one sink (free, no library). Caught errors (handled by an
// ErrorBoundary) log quietly; uncaught ones are the ones worth shouting about.
createRoot(root, {
	onCaughtError: (error) => console.warn(`[heed] caught render error: ${(error as Error)?.message ?? error}`),
	onUncaughtError: (error) => console.error(`[heed] UNCAUGHT render error: ${(error as Error)?.message ?? error}`),
}).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
