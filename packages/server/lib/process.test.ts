import { test, expect } from "bun:test";
import { track, untrack, killTree, gracefulStop, reapAll } from "./process.ts";

// Characterization tests for the process supervisor — the anti-orphan reliability core.
// These run headless (no mic/ffmpeg needed): they spawn `sleep` children and assert the
// supervisor actually reaps them.

test("gracefulStop terminates a tracked child", async () => {
	const proc = Bun.spawn(["sleep", "120"]);
	track(proc);
	expect(proc.killed).toBe(false);
	await gracefulStop(proc, 500);
	await proc.exited;
	expect(proc.killed).toBe(true);
});

test("killTree on a non-detached child falls back to a direct kill (no throw)", async () => {
	const proc = Bun.spawn(["sleep", "120"]);
	killTree(proc, "SIGKILL"); // negative-PID group kill will ESRCH → direct kill fallback
	await proc.exited;
	expect(proc.killed).toBe(true);
});

test("reapAll kills every tracked child and empties the registry", async () => {
	const a = Bun.spawn(["sleep", "120"]);
	const b = Bun.spawn(["sleep", "120"]);
	track(a);
	track(b);
	await reapAll(500);
	await Promise.all([a.exited, b.exited]);
	expect(a.killed).toBe(true);
	expect(b.killed).toBe(true);
});

test("untrack removes a child so reapAll leaves it alone", async () => {
	const keep = Bun.spawn(["sleep", "1"]); // short-lived; we won't reap it
	track(keep);
	untrack(keep);
	await reapAll(200); // should not touch `keep`
	expect(keep.killed).toBe(false);
	await keep.exited; // let it finish on its own
});
