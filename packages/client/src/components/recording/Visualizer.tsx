import { forwardRef, useMemo } from "react";
import styles from "./Visualizer.module.css";

interface VisualizerProps {
	barCount?: number;
	variant?: "mic" | "system";
	label?: string;
}

/**
 * Single bar visualizer that exposes its bar refs via forwardRef so the parent
 * can mutate heights at 60fps without re-rendering React.
 */
export const Visualizer = forwardRef<HTMLDivElement[], VisualizerProps>(
	({ barCount = 24, variant = "mic", label }, ref) => {
		const bars = useMemo(() => Array.from({ length: barCount }, (_, i) => i), [barCount]);

		return (
			<div className={styles.group}>
				<div className={styles.visualizer}>
					{bars.map((i) => (
						<div
							key={i}
							className={`${styles.bar} ${variant === "system" ? styles.barSystem : ""}`}
							ref={(el) => {
								if (!el) return;
								if (typeof ref === "function") {
									// Not used here
								} else if (ref && "current" in ref) {
									if (!ref.current) ref.current = [];
									ref.current[i] = el;
								}
							}}
						/>
					))}
				</div>
				{label && (
					<div
						className={`${styles.label} ${variant === "system" ? styles.labelSystem : styles.labelMic}`}
					>
						{label}
					</div>
				)}
			</div>
		);
	},
);

Visualizer.displayName = "Visualizer";
