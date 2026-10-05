/**
 * Child-process supervision helpers. server.ts spawns ffmpeg, the Swift sidecars, and pactl/level
 * meters; the #1 "app feels broken" bug is an ORPHANED ffmpeg still holding the mic after the
 * server exits or a recording is force-stopped. These helpers encode the supervision discipline
 * from the streaming research (OTP-style): spawn `detached` so the child leads its own process
 * group, then kill the whole GROUP (negative PID) so ffmpeg's own grandchildren die too; graceful
 * SIGTERM/SIGINT → timeout → SIGKILL; and a process registry so a single shutdown hook reaps
 * everything. Concrete for our 3-4 known children — NOT a generic supervision framework (a trap).
 */
import { logger } from "./logger.ts";

const log = logger("process");

type Spawned = { pid?: number; kill: (sig?: number | NodeJS.Signals) => void; exited?: Promise<unknown> };

const registry = new Set<Spawned>();

/** Track a spawned child so the shutdown hook can reap it. Returns the same proc for chaining. */
export function track<T extends Spawned>(proc: T): T {
	registry.add(proc);
	// Best-effort auto-untrack on natural exit.
	proc.exited?.then(() => registry.delete(proc)).catch(() => registry.delete(proc));
	return proc;
}

export function untrack(proc: Spawned): void {
	registry.delete(proc);
}

/**
 * Kill a child and its whole process group (so ffmpeg's children/grandchildren die too). Tries the
 * group via negative PID first (works when the child was spawned `detached`), then falls back to a
 * direct kill. Swallows ESRCH (already gone).
 */
export function killTree(proc: Spawned | null, signal: NodeJS.Signals = "SIGTERM"): void {
	if (!proc) return;
	const pid = proc.pid;
	if (pid && pid > 1) {
		try {
			process.kill(-pid, signal); // negative pid = process GROUP
			return;
		} catch {
			/* not a group leader (not detached) — fall back to direct kill */
		}
	}
	try {
		proc.kill(signal as unknown as number);
	} catch {
		/* already exited */
	}
}

/**
 * Graceful stop: SIGTERM (or SIGINT for ffmpeg, which flushes its output cleanly on INT), wait up
 * to `timeoutMs` for exit, then SIGKILL the group. Resolves when the child is gone.
 */
export async function gracefulStop(proc: Spawned | null, timeoutMs = 1500, term: NodeJS.Signals = "SIGTERM"): Promise<void> {
	if (!proc) return;
	killTree(proc, term);
	const exited = proc.exited ?? Promise.resolve();
	const timed = await Promise.race([
		exited.then(() => "exited" as const),
		new Promise<"timeout">((r) => setTimeout(() => r("timeout"), timeoutMs)),
	]);
	if (timed === "timeout") {
		log.warn(`pid ${proc.pid} did not exit in ${timeoutMs}ms — SIGKILL`);
		killTree(proc, "SIGKILL");
		await exited.catch(() => {});
	}
	untrack(proc);
}

/** Reap every tracked child (called from the shutdown hook). */
export async function reapAll(timeoutMs = 1500): Promise<void> {
	const procs = [...registry];
	if (procs.length) log.info(`shutting down — reaping ${procs.length} child process(es)`);
	await Promise.all(procs.map((p) => gracefulStop(p, timeoutMs)));
	registry.clear();
}

let installed = false;
/**
 * Install one-time shutdown hooks so the process never leaves orphaned children. Idempotent.
 * Covers SIGINT/SIGTERM (Ctrl-C, `kill`) and `beforeExit`. The caller may pass extra cleanup.
 */
export function installShutdownHooks(extraCleanup?: () => void | Promise<void>): void {
	if (installed) return;
	installed = true;
	let shuttingDown = false;
	const handler = async (sig: string) => {
		if (shuttingDown) return;
		shuttingDown = true;
		log.info(`received ${sig} — graceful shutdown`);
		try {
			if (extraCleanup) await extraCleanup();
		} catch {}
		await reapAll();
		process.exit(0);
	};
	process.on("SIGINT", () => handler("SIGINT"));
	process.on("SIGTERM", () => handler("SIGTERM"));
	process.on("beforeExit", () => reapAll());
}
