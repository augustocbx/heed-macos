#!/usr/bin/env node

/**
 * heed update
 *
 * Pulls the latest changes, installs new dependencies if needed,
 * and rebuilds. One command, always up to date.
 *
 * Usage: bun run update
 */

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const C = {
	reset: "\x1b[0m",
	bold: "\x1b[1m",
	dim: "\x1b[2m",
	blue: "\x1b[34m",
	green: "\x1b[32m",
	yellow: "\x1b[33m",
	red: "\x1b[31m",
};

const ok = (msg) => console.log(`${C.green}✓${C.reset} ${msg}`);
const info = (msg) => console.log(`${C.blue}>${C.reset} ${msg}`);
const warn = (msg) => console.log(`${C.yellow}!${C.reset} ${msg}`);
const err = (msg) => console.log(`${C.red}✗${C.reset} ${msg}`);

function run(cmd) {
	try {
		return execSync(cmd, { encoding: "utf-8", stdio: "pipe" }).trim();
	} catch (e) {
		return null;
	}
}

console.log("");
console.log(`${C.bold}  heed update${C.reset}`);
console.log("");

// 1. Check current version
const currentHash = run("git rev-parse --short HEAD");
info(`Current: ${C.dim}${currentHash}${C.reset}`);

// 2. Fetch latest
info("Checking for updates...");
const fetchResult = run("git fetch origin main");
if (fetchResult === null) {
	err("Failed to fetch. Check your internet connection.");
	process.exit(1);
}

// 3. Check if there are new commits
const behind = run("git rev-list --count HEAD..origin/main");
if (behind === "0") {
	ok("Already up to date!");
	process.exit(0);
}

info(`${C.bold}${behind}${C.reset} new commit(s) available`);

// 4. Show what changed (short summary)
const log = run("git log --oneline HEAD..origin/main");
if (log) {
	console.log("");
	log.split("\n").forEach((line) => {
		console.log(`  ${C.dim}${line}${C.reset}`);
	});
	console.log("");
}

// 5. Pull
info("Downloading updates...");
const pullResult = run("git pull origin main");
if (pullResult === null) {
	err("Pull failed. You may have local changes.");
	warn("Run: git stash && bun run update && git stash pop");
	process.exit(1);
}

// 6. Check if package.json changed (need bun install)
const diffFiles = run("git diff --name-only HEAD~" + behind + " HEAD") || "";
const needsInstall = diffFiles.includes("package.json") || diffFiles.includes("bun.lock");
const needsBuild = diffFiles.includes("packages/client/");
const needsPip = diffFiles.includes("requirements.txt") || diffFiles.includes("transcription_server.py");

if (needsInstall) {
	info("Dependencies changed, installing...");
	run("bun install");
	ok("Dependencies updated");
}

if (needsBuild) {
	info("Frontend changed, rebuilding...");
	run("cd packages/client && bun run build");
	ok("Frontend rebuilt");
}

if (needsPip) {
	info("Python dependencies may have changed");
	warn("Run: pip install -r packages/transcription/requirements.txt");
}

// 7. Done
const newHash = run("git rev-parse --short HEAD");
console.log("");
ok(`Updated! ${C.dim}${currentHash}${C.reset} → ${C.bold}${newHash}${C.reset} (${behind} commits)`);
console.log(`  ${C.dim}Restart heed to apply: ${C.reset}${C.bold}bun run dev${C.reset}`);
console.log("");
