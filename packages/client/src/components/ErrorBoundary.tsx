import { Component, type ReactNode, type ErrorInfo } from "react";

interface Props {
	children: ReactNode;
	/** Rendered when a child throws. Receives the error + a reset fn. */
	fallback?: (error: Error, reset: () => void) => ReactNode;
	/** When any value here changes, the boundary auto-resets (e.g. a new sessionId). */
	resetKeys?: unknown[];
	/** Side-effect hook (logging/telemetry). */
	onError?: (error: Error, info: ErrorInfo) => void;
}

interface State {
	error: Error | null;
}

/**
 * Minimal error boundary (dependency-free — no need to pull react-error-boundary for a local app).
 * React 19 STILL has no function-component error boundary, so this stays a class.
 *
 * Used to wrap the TRANSCRIPT view only, with the recording controls kept OUTSIDE it (per the
 * streaming/React research): a render crash in the transcript must NEVER take down the page or
 * lose access to Stop/Save — never lose a recording. `resetKeys` lets it recover on a new session.
 */
export class ErrorBoundary extends Component<Props, State> {
	state: State = { error: null };

	static getDerivedStateFromError(error: Error): State {
		return { error };
	}

	componentDidCatch(error: Error, info: ErrorInfo) {
		this.props.onError?.(error, info);
		console.error(`[heed] transcript view crashed: ${error.message}`, info.componentStack);
	}

	componentDidUpdate(prev: Props) {
		// Auto-reset when any reset key changes (shallow compare).
		if (this.state.error && prev.resetKeys && this.props.resetKeys) {
			const changed = this.props.resetKeys.some((k, i) => !Object.is(k, prev.resetKeys![i]));
			if (changed) this.reset();
		}
	}

	reset = () => this.setState({ error: null });

	render() {
		if (this.state.error) {
			if (this.props.fallback) return this.props.fallback(this.state.error, this.reset);
			return (
				<div role="alert" style={{ padding: 16, textAlign: "center", color: "var(--text-muted, #94a3b8)" }}>
					<p>Algo falló al mostrar el transcript. Tu grabación está a salvo.</p>
					<button onClick={this.reset} style={{ marginTop: 8 }}>Reintentar</button>
				</div>
			);
		}
		return this.props.children;
	}
}
