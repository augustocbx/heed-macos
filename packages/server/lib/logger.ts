/**
 * Tiny structured logger. The codebase scattered ~11 bare `console.log`s with no levels, no
 * timestamps, and no way to silence debug noise in production. This gives leveled, timestamped,
 * scoped lines (`HH:MM:SS.mmm LEVEL [scope] msg`) over one sink, and a runtime level gate via
 * HEED_LOG_LEVEL (debug|info|warn|error). No dependency — keep it a leaf module so anything can
 * import it without creating cycles.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = ORDER[(process.env.HEED_LOG_LEVEL as LogLevel) ?? "info"] ?? ORDER.info;

function ts(): string {
	return new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
}

function emit(level: LogLevel, scope: string, msg: string) {
	if (ORDER[level] < threshold) return;
	const line = `${ts()} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}`;
	(level === "error" || level === "warn" ? console.error : console.log)(line);
}

/** Create a scoped logger, e.g. `const log = logger("recording")`. */
export function logger(scope: string) {
	return {
		debug: (msg: string) => emit("debug", scope, msg),
		info: (msg: string) => emit("info", scope, msg),
		warn: (msg: string) => emit("warn", scope, msg),
		error: (msg: string) => emit("error", scope, msg),
	};
}
