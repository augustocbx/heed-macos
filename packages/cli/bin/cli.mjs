#!/usr/bin/env node

/**
 * create-heed CLI
 *
 * Interactive installer + updater for heed.
 *
 * Usage:
 *   npx create-heed           # install heed (first time)
 *   npx create-heed update    # pull latest changes (from anywhere)
 */

import { execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { platform, homedir, cpus, totalmem } from "node:os";

// --- Colors (ANSI) ---
const C = {
	reset: "\x1b[0m",
	bold: "\x1b[1m",
	dim: "\x1b[2m",
	blue: "\x1b[34m",
	green: "\x1b[32m",
	yellow: "\x1b[33m",
	red: "\x1b[31m",
	cyan: "\x1b[36m",
};

const log = (msg) => console.log(msg);
const info = (msg) => log(`${C.blue}>${C.reset} ${msg}`);
const ok = (msg) => log(`${C.green}✓${C.reset} ${msg}`);
const warn = (msg) => log(`${C.yellow}!${C.reset} ${msg}`);
const err = (msg) => log(`${C.red}✗${C.reset} ${msg}`);
const step = (n, total, msg) => log(`\n${C.bold}[${n}/${total}]${C.reset} ${msg}`);

// --- Utils ---
function cmd(command) {
	try {
		return execSync(command, { encoding: "utf-8", stdio: "pipe" }).trim();
	} catch {
		return null;
	}
}

function hasCommand(name) {
	return cmd(`which ${name}`) !== null;
}

// Minor version of a Python command (e.g. 12 for 3.12.x), or -1 if unavailable/unparseable.
function pyMinor(command) {
	const v = cmd(`${command} -c "import sys;print(sys.version_info[1])"`);
	const n = v ? parseInt(v, 10) : NaN;
	return Number.isFinite(n) ? n : -1;
}
// heed's AI deps (torch / faster-whisper / pyannote / mlx) only ship wheels for Python 3.10–3.12.
// 3.13/3.14 are too new — pip silently can't build them and transcription dies. This gate keeps the
// .venv on a supported interpreter no matter how new the system python is.
const PY_MIN = 10, PY_MAX = 12;
function pySupported(command) {
	const m = pyMinor(command);
	return m >= PY_MIN && m <= PY_MAX;
}

// --- Flags / non-interactive install ---
// The core (record → transcribe → diarize → copy) installs with zero questions — only progress. The
// one heavy OPTIONAL piece (AI notes = Ollama + LLM) is gated behind the preset. `--yes` / no-TTY
// accept the safe defaults so `npx create-heed --yes` (or CI) runs unattended.
const ARGV = process.argv.slice(2);
const IS_TTY = Boolean(process.stdin.isTTY);
const FLAGS = {
	yes: ARGV.includes("--yes") || ARGV.includes("-y"),
	// preset: explicit flag wins; else resolved later (TTY → ask once, non-TTY → "fast").
	preset: ARGV.includes("--full") || ARGV.includes("--notes") ? "full"
		: ARGV.includes("--fast") || ARGV.includes("--no-notes") ? "fast"
		: (ARGV.find((a) => a.startsWith("--preset="))?.split("=")[1] || null),
	engine: ARGV.find((a) => a.startsWith("--engine="))?.split("=")[1] || null,
};

async function ask(question) {
	if (FLAGS.yes || !IS_TTY) return true;  // unattended → accept the safe default
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	return new Promise((resolve) => {
		rl.question(`${C.cyan}?${C.reset} ${question} ${C.dim}(Y/n)${C.reset} `, (answer) => {
			rl.close();
			resolve(!answer || answer.toLowerCase().startsWith("y"));
		});
	});
}

// Trigger the macOS Screen-Recording permission dialog by briefly running heed-syscap
// (the binary the grant must bind to). Resolves true if it reported {"ready":true} —
// i.e. capture started, so permission is already granted. Resolves false if it errored
// out quickly (dialog shown / declined) or never reported ready within the window.
function warmSystemAudioPermission(bin) {
	return new Promise((resolve) => {
		let stderr = "";
		let settled = false;
		const finish = (granted) => {
			if (settled) return;
			settled = true;
			try { child.kill(); } catch {}
			resolve(granted);
		};
		const isReady = () => stderr.split("\n").some((l) => {
			try { return JSON.parse(l).ready === true; } catch { return false; }
		});
		const child = spawn(bin, [], { stdio: ["ignore", "ignore", "pipe"] });
		child.stderr.on("data", (d) => {
			stderr += d.toString();
			if (isReady()) finish(true);
		});
		child.on("error", () => finish(false));
		child.on("exit", () => finish(isReady())); // exited fast → likely permission error
		setTimeout(() => finish(isReady()), 3000); // still running w/o "ready" → treat as not granted
	});
}

function run(command, label) {
	info(`Running: ${C.dim}${command}${C.reset}`);
	try {
		execSync(command, { stdio: "inherit" });
		ok(label || "Done");
		return true;
	} catch (e) {
		err(`Failed: ${command}`);
		return false;
	}
}

// Bring the managed install in sync with origin/main, self-healing from a diverged or REWRITTEN
// upstream history (e.g. after a maintainer force-push). A plain `git pull` fails hard on divergence
// and leaves the user on stale code — the exact way an existing clone breaks after history is rewritten.
// The install dir holds heed's OWN code (user data lives in ~/.heed-app), so realigning it to the
// remote is safe: fast-forward when we cleanly can, otherwise hard-reset to origin/main.
function syncRepoToMain(dir) {
	if (!cmd(`cd "${dir}" && git fetch origin main 2>&1`)) cmd(`cd "${dir}" && git fetch origin 2>&1`);
	// HEAD is an ancestor of origin/main → a clean fast-forward is possible (prudent: no reset needed).
	const canFF = cmd(`cd "${dir}" && git merge-base --is-ancestor HEAD origin/main && echo ok`) === "ok";
	if (canFF && run(`cd "${dir}" && git merge --ff-only origin/main`, "Updated")) return;
	if (!canFF) warn("Local copy diverged from upstream (history was rewritten) — realigning to latest.");
	run(`cd "${dir}" && git reset --hard origin/main`, "Realigned to latest");
}

// Poll the transcription server's /health until it reports ready (models loaded), or time out. Used
// to open the UI exactly when heed is usable — no arbitrary sleep that opens a dead page or waits too long.
async function waitForHealth(timeoutMs = 90000) {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		try {
			const h = await fetch("http://localhost:5002/health", { signal: AbortSignal.timeout(1500) });
			if (h.ok && (await h.json()).ready) return true;
		} catch {}
		await new Promise((r) => setTimeout(r, 1500));
	}
	return false;
}

// --- OS Detection ---
const OS = platform();
const IS_MAC = OS === "darwin";
const IS_LINUX = OS === "linux";

function getLinuxDistro() {
	const release = cmd("cat /etc/os-release 2>/dev/null") || "";
	const id = (release.match(/^ID=(.+)$/m)?.[1] || "").replace(/"/g, "").toLowerCase();
	const idLike = (release.match(/^ID_LIKE=(.+)$/m)?.[1] || "").replace(/"/g, "").toLowerCase();
	const all = `${id} ${idLike}`;
	if (/debian|ubuntu|mint|pop/.test(all)) return "debian";
	if (/fedora|rhel|centos/.test(all)) return "fedora";
	if (/arch|manjaro|endeavour/.test(all)) return "arch";
	return "other";
}

// --- Main ---
async function main() {
	log("");
	log(`${C.bold}  heed${C.reset} — local-first meeting transcription`);
	log(`${C.dim}  every voice, even when they speak at once.${C.reset}`);
	log(`${C.dim}  Local. Open. Yours.${C.reset}`);
	log("");

	if (!IS_MAC && !IS_LINUX) {
		err("heed currently supports Linux and macOS only.");
		err("Windows support is coming soon.");
		process.exit(1);
	}

	const IS_APPLE_SILICON = IS_MAC && process.arch === "arm64";
	const ramGB = Math.round(totalmem() / 1024 / 1024 / 1024);
	info(`Detected: ${C.bold}${IS_MAC ? "macOS" : "Linux"}${C.reset} · ${cpus().length} cores · ${ramGB}GB RAM`);
	info(`  ${cpus()[0]?.model || "unknown CPU"}`);
	if (IS_APPLE_SILICON) {
		ok(`Engine: ${C.bold}Parakeet on the Apple Neural Engine${C.reset} — fastest, 100% local`);
	}
	log("");

	// --- Preset: keep the core zero-friction; gate only the heavy OPTIONAL piece (AI notes). ---
	let preset = (FLAGS.preset === "fast" || FLAGS.preset === "full") ? FLAGS.preset : null;
	if (!preset) {
		if (IS_TTY && !FLAGS.yes) {
			log(`  ${C.bold}Fast${C.reset}     ${C.dim}record + transcribe + diarize + copy (lightweight)${C.reset}`);
			log(`  ${C.bold}Complete${C.reset} ${C.dim}+ AI notes (Ollama + LLM, ~2-5GB — you can enable it later)${C.reset}`);
			preset = (await ask("Add AI notes now (Complete)?  No = Fast")) ? "full" : "fast";
		} else {
			preset = "fast";  // unattended default: the lightweight core
		}
	}
	ok(`Preset: ${C.bold}${preset === "full" ? "Complete (+ AI notes)" : "Fast"}${C.reset}`);

	// Engine override (--engine=parakeet|mlx|ctranslate2) → HEED_ENGINE, inherited by the `bun run dev`
	// spawn below (and read by engines.py/capability.py). Used by the fallback flow.
	if (FLAGS.engine) process.env.HEED_ENGINE = FLAGS.engine;

	// Dynamic step count: base + AI-notes (Ollama) if full + Parakeet/permission if Apple Silicon.
	const TOTAL = 6 + (preset === "full" ? 1 : 0) + (IS_APPLE_SILICON ? 2 : 0);
	let stepN = 0;

	// --- Step 1: Bun ---
	step(++stepN, TOTAL, "Bun runtime");
	if (hasCommand("bun")) {
		const ver = cmd("bun --version");
		ok(`Bun ${ver} already installed`);
	} else {
		warn("Bun is not installed. It's the JavaScript runtime heed uses.");
		if (await ask("Install Bun?")) {
			run("curl -fsSL https://bun.sh/install | bash", "Bun installed");
			// Add to PATH for this session
			process.env.PATH = `${homedir()}/.bun/bin:${process.env.PATH}`;
		} else {
			err("Bun is required. Install it manually: https://bun.sh");
			process.exit(1);
		}
	}

	// --- Step 2: Python ---
	step(++stepN, TOTAL, "Python 3.10+");
	const pyCmd = hasCommand("python3") ? "python3" : hasCommand("python") ? "python" : null;
	if (pyCmd) {
		const pyVer = cmd(`${pyCmd} --version`);
		ok(`${pyVer} found`);
	} else {
		warn("Python 3.10+ is not installed.");
		if (IS_MAC) {
			if (await ask("Install Python via Homebrew?")) {
				if (!hasCommand("brew")) run('/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"', "Homebrew installed");
				run("brew install python@3.12", "Python installed");
			}
		} else {
			const distro = getLinuxDistro();
			const cmds = { debian: "sudo apt install -y python3 python3-pip", fedora: "sudo dnf install -y python3 python3-pip", arch: "sudo pacman -S --noconfirm python python-pip" };
			if (await ask(`Install Python? (${cmds[distro] || "manual"})`)) {
				run(cmds[distro] || cmds.debian, "Python installed");
			}
		}
	}

	// --- Step 3: ffmpeg ---
	step(++stepN, TOTAL, "ffmpeg (audio capture)");
	if (hasCommand("ffmpeg")) {
		ok("ffmpeg already installed");
	} else {
		warn("ffmpeg is needed to capture and process audio.");
		if (await ask("Install ffmpeg?")) {
			if (IS_MAC) {
				run("brew install ffmpeg", "ffmpeg installed");
			} else {
				const distro = getLinuxDistro();
				const cmds = { debian: "sudo apt install -y ffmpeg", fedora: "sudo dnf install -y ffmpeg", arch: "sudo pacman -S --noconfirm ffmpeg" };
				run(cmds[distro] || cmds.debian, "ffmpeg installed");
			}
		}
	}

	// --- Step 4: Ollama (local notes engine) — ONLY in the "Complete" preset ---
	// AI notes are the one heavy, optional piece. In "Fast" we skip Ollama entirely (the LLM model is
	// downloaded in-app later anyway) so the core stays light and zero-friction. Re-runnable: choosing
	// Complete later installs it.
	if (preset === "full") {
		step(++stepN, TOTAL, "Ollama (local AI notes engine)");
		if (hasCommand("ollama")) {
			const ollamaVer = cmd("ollama --version");
			ok(`Ollama ${ollamaVer || ""} already installed`);
		} else {
			warn("Ollama runs AI models locally for generating meeting notes (~2-5GB with the model).");
			if (await ask("Install Ollama?")) {
				if (IS_MAC) {
					// macOS: the official app bundles the llama-server runner. The Homebrew
					// *formula* (`brew install ollama`) ships WITHOUT that runner and cannot
					// generate — so we install the cask (Ollama.app) instead.
					if (!hasCommand("brew")) run('/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"', "Homebrew installed");
					run("brew install --cask ollama-app", "Ollama installed");
				} else {
					// Linux: official install script (ships the runner correctly).
					run("curl -fsSL https://ollama.com/install.sh | sh", "Ollama installed");
				}
			}
		}
	}

	// --- Step 5: Download heed --- (must happen BEFORE the Python venv so we have
	// requirements.txt and a folder for .venv)
	step(++stepN, TOTAL, "Download heed");
	const targetDir = join(process.cwd(), "heed");
	if (existsSync(targetDir)) {
		ok(`heed already exists at ${targetDir}`);
		info("Pulling latest changes...");
		syncRepoToMain(targetDir);
	} else {
		info("Cloning from GitHub...");
		run(`git clone https://github.com/isjunrod/heed.git "${targetDir}"`, "Downloaded");
	}
	info("Installing JavaScript dependencies...");
	run(`cd "${targetDir}" && bun install`, "Dependencies installed");

	// --- Step 6: Python runtime (isolated in a project-local .venv) ---
	// Mac (Apple Silicon): the ENGINE is Parakeet on the Swift sidecar → Python only needs a TINY core
	// (livekit + numpy), NOT the ~1.6GB torch/pyannote/whisper stack (that's the on-demand fallback).
	// Linux / Intel Mac: unchanged — install the full requirements.txt (their engine IS whisper/torch).
	step(++stepN, TOTAL, IS_APPLE_SILICON ? "Python runtime (lightweight core)" : "AI models (faster-whisper + pyannote + torch)");
	// torch needs Python 3.10–3.12; a system python3 can be too new (e.g. 3.14 has no
	// torch wheels yet). Prefer an explicit 3.12/3.11/3.10, and on macOS install
	// python@3.12 if none is present. We ALWAYS install into `<heed>/.venv` so the
	// system Python stays untouched and `bun run dev` (dev:python → .venv/bin/python3)
	// works identically on macOS and Linux.
	// Pick a SUPPORTED interpreter (3.10–3.12). Never fall back to a too-new system python3 (3.13/3.14):
	// its deps won't build and the transcription server dies at load — the exact failure a fresh user hit.
	let venvPy = hasCommand("python3.12") && pySupported("python3.12") ? "python3.12"
		: hasCommand("python3.11") && pySupported("python3.11") ? "python3.11"
		: hasCommand("python3.10") && pySupported("python3.10") ? "python3.10"
		: (pyCmd && pySupported(pyCmd)) ? pyCmd
		: null;
	if (!venvPy) {
		if (IS_MAC) {
			warn("No supported Python (3.10–3.12) found — installing python@3.12 via Homebrew.");
			if (!hasCommand("brew")) run('/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"', "Homebrew installed");
			run("brew install python@3.12", "Python 3.12 installed");
			venvPy = hasCommand("python3.12") && pySupported("python3.12") ? "python3.12" : null;
		}
		if (!venvPy) {
			err("heed needs Python 3.10–3.12. Your Python is too new for the AI deps (3.13/3.14 have no wheels yet).");
			err(IS_MAC ? "Install it with:  brew install python@3.12" : "Install python3.12 from your package manager, then re-run.");
			process.exit(1);
		}
	}
	const venvDir = join(targetDir, ".venv");
	const venvPython = join(venvDir, "bin", "python3");
	// Rebuild a stale/incompatible .venv — one left by an OLDER installer on the wrong Python (e.g. 3.14),
	// or a half-finished run. Reusing it is exactly how a returning user stays broken after we ship a fix.
	if (existsSync(venvDir) && !pySupported(venvPython)) {
		warn("Existing .venv uses an unsupported/broken Python — rebuilding it.");
		run(`rm -rf "${venvDir}"`, "Removed stale .venv");
	}
	if (!existsSync(venvDir)) {
		run(`${venvPy} -m venv "${venvDir}"`, "Virtualenv created (.venv)");
	}
	const reqFile = IS_APPLE_SILICON ? "requirements-core.txt" : "requirements.txt";
	const reqPath = join(targetDir, "packages", "transcription", reqFile);
	const marker = IS_APPLE_SILICON ? "livekit" : "faster_whisper";
	const already = cmd(`"${venvPython}" -c "import ${marker}; print('ok')" 2>/dev/null`) === "ok";
	if (already) {
		ok(IS_APPLE_SILICON ? "Python core already installed in .venv" : "AI packages already installed in .venv");
	} else if (IS_APPLE_SILICON) {
		// Core = no questions, just progress (it's tiny and required for record→transcribe→copy).
		info("Installing lightweight Python core (livekit + numpy, no torch)...");
		run(`"${venvPython}" -m pip install --upgrade pip`, "pip upgraded");
		run(`"${venvPython}" -m pip install -r "${reqPath}"`, "Python core installed");
	} else {
		warn("Installing AI packages (~3GB download first time). This powers the transcription.");
		if (await ask("Install faster-whisper + pyannote + torch into .venv?")) {
			run(`"${venvPython}" -m pip install --upgrade pip`, "pip upgraded");
			run(`"${venvPython}" -m pip install -r "${reqPath}"`, "AI packages installed");
		}
	}

	// --- Step 7 (Apple Silicon only): Parakeet speed engine ---
	// Builds the Swift sidecar that runs Parakeet ASR + FluidAudio diarization on the Apple
	// Neural Engine — the fastest path on Mac AND the one that needs NO gated pyannote token.
	// GRACEFUL: if the Swift toolchain isn't present we skip and heed falls back to MLX-Whisper
	// (still GPU-accelerated) + pyannote. heed must never hard-fail at install.
	if (IS_APPLE_SILICON) {
		step(++stepN, TOTAL, "Parakeet speed engine (Apple Neural Engine)");
		const sidecarDir = join(targetDir, "packages", "transcription", "native", "heed-parakeet");
		const sidecarBin = join(sidecarDir, ".build", "release", "heed-parakeet");
		let sidecarOk = false;
		if (existsSync(sidecarBin)) {
			ok("Parakeet sidecar already built");
			sidecarOk = true;
		} else if (!hasCommand("swift")) {
			info("Swift toolchain not found — Parakeet needs it for the fastest engine.");
			info(`For Parakeet later: ${C.cyan}xcode-select --install${C.reset} then re-run ${C.bold}npx create-heed${C.reset}.`);
		} else if (existsSync(sidecarDir)) {
			info("Building Parakeet sidecar (first build downloads CoreML deps, ~1-2 min)...");
			sidecarOk = run(`cd "${sidecarDir}" && swift build -c release`, "Parakeet sidecar built (Apple Neural Engine)");
			if (!sidecarOk) warn("Parakeet build failed — falling back to the MLX-Whisper engine.");
		}

		// GUARANTEE a working engine. On Apple Silicon the .venv is the lightweight core (livekit + numpy,
		// NO whisper) because the engine is normally the Parakeet sidecar. If that sidecar isn't available,
		// the server has nothing to transcribe with and dies at load (dead :5002 → "can't start
		// transcription"). So install the fallback engine (MLX-Whisper on Metal) and pin it — "press
		// record" must always work, even without Xcode/Swift.
		// Parakeet is available now → clear any stale fallback pin from an earlier engine-less run,
		// so the server actually uses the ANE instead of staying on MLX.
		if (sidecarOk) {
			try {
				const ov = join(homedir(), ".heed-app", "overrides.json");
				if (existsSync(ov)) {
					const pinned = JSON.parse(readFileSync(ov, "utf-8"))?.engine;
					if (pinned && pinned !== "parakeet") { unlinkSync(ov); info("Cleared stale fallback engine pin — using Parakeet."); }
				}
			} catch { /* non-fatal */ }
		}
		if (!sidecarOk) {
			warn("Installing the fallback engine so heed still transcribes without Parakeet (~1.6GB, one time)...");
			const fbReq = join(targetDir, "packages", "transcription", "requirements-fallback.txt");
			if (run(`"${venvPython}" -m pip install -r "${fbReq}"`, "Fallback engine installed")) {
				try {
					mkdirSync(join(homedir(), ".heed-app"), { recursive: true });
					writeFileSync(join(homedir(), ".heed-app", "overrides.json"), JSON.stringify({ engine: "mlx" }, null, 2));
					ok("Engine set to MLX-Whisper (Metal)");
				} catch (e) { warn(`Could not pin fallback engine: ${e.message}`); }
			} else {
				err("Fallback engine install failed — transcription may not work. Retry: npx create-heed fallback");
			}
		}

		// --- Step 8 (Apple Silicon): System-audio permission (pre-armed, one time) ---
		// macOS protects system audio: capturing it ALWAYS needs the user's Screen Recording
		// permission (true of every method — SCK, Core Audio taps, etc.). We ask for it HERE, once,
		// at peak setup-intent, so pressing "record" later is friction-free. The dialog must be
		// triggered by heed-syscap itself (TCC binds the grant to the calling binary), so we run
		// the real binary briefly. If the toolchain was missing, this step is a no-op (mic still works).
		step(++stepN, TOTAL, "System audio permission (one-time)");
		const syscapBin = join(sidecarDir, ".build", "release", "heed-syscap");
		if (!existsSync(syscapBin)) {
			info("System-audio helper not built — heed will record your microphone only.");
		} else {
			info("heed needs permission to capture your meetings' system audio.");
			info("A macOS dialog will appear — approve it. (Mic-only recording works without this.)");
			const granted = await warmSystemAudioPermission(syscapBin);
			if (granted) {
				ok("System audio permission granted — press record and you're done");
			} else {
				// Open the exact Settings pane so the user can flip the toggle in one move.
				try { execSync(`open "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"`, { stdio: "ignore" }); } catch {}
				info("Enable heed (heed-syscap) under Screen Recording, then heed uses it automatically.");
				info("Until then heed records your microphone only.");
			}
		}
	}

	// --- Step: Launch ---
	step(++stepN, TOTAL, "Launch heed");
	// Doctor-first: seal the install by confirming the whole chain works on THIS machine (non-fatal).
	const doctorPy = join(targetDir, "packages", "transcription", "doctor.py");
	if (existsSync(doctorPy) && existsSync(venvPython)) {
		info("Health check (confirming transcription + diarization work here)...");
		if (!run(`"${venvPython}" "${doctorPy}"`, "Health check passed")) {
			warn("A check failed above. If transcription failed, install the fallback engine:");
			log(`  ${C.bold}npx create-heed fallback${C.reset}`);
		}
	}
	log("");
	log(`${C.bold}${C.green}  All set!${C.reset}`);
	log("");

	const useDesktop = await ask("Open as floating desktop panel? (recommended)");

	if (useDesktop) {
		log(`  ${C.dim}Starting services + floating panel...${C.reset}`);
		log("");

		// Start dev server in background
		const devChild = spawn("bun", ["run", "dev"], {
			cwd: targetDir,
			stdio: "ignore",
			shell: true,
			detached: true,
		});
		devChild.unref();

		// Wait until heed is actually ready (models loaded), not an arbitrary sleep.
		info("Starting services (loading models)...");
		await waitForHealth();

		// Launch desktop panel
		const panelChild = spawn("python3", ["packages/desktop/main.py"], {
			cwd: targetDir,
			stdio: "inherit",
			shell: true,
		});

		panelChild.on("exit", (code) => {
			if (code !== 0) err(`Desktop panel exited with code ${code}`);
			process.exit(0);
		});

		process.on("SIGINT", () => {
			panelChild.kill("SIGINT");
			process.exit(0);
		});
	} else {
		log(`  ${C.dim}Starting heed...${C.reset}`);
		log(`  ${C.dim}Open ${C.cyan}http://localhost:5170${C.dim} in your browser${C.reset}`);
		log("");

		const child = spawn("bun", ["run", "dev"], {
			cwd: targetDir,
			stdio: "inherit",
			shell: true,
		});

		// Auto-open the browser once heed is ready (Mac only — `open`; Linux users open it themselves).
		if (IS_MAC) {
			waitForHealth().then((ready) => {
				if (ready) { try { execSync("open http://localhost:5170", { stdio: "ignore" }); } catch {} }
			});
		}

		child.on("exit", (code) => {
			if (code !== 0) err(`heed exited with code ${code}`);
		});

		process.on("SIGINT", () => {
			child.kill("SIGINT");
			process.exit(0);
		});
	}
}

// --- Update subcommand ---
async function update() {
	log("");
	log(`${C.bold}  heed update${C.reset}`);
	log("");

	// Find heed installation
	const candidates = [
		join(process.cwd(), "heed"),
		process.cwd(), // maybe already inside heed dir
		join(homedir(), "heed"),
		join(homedir(), "Desktop", "heed"),
		join(homedir(), "Projects", "heed"),
	];

	let heedDir = null;
	for (const dir of candidates) {
		if (existsSync(join(dir, "package.json")) && existsSync(join(dir, "packages", "server"))) {
			heedDir = dir;
			break;
		}
	}

	if (!heedDir) {
		err("heed installation not found.");
		info("Run `npx create-heed` first to install.");
		process.exit(1);
	}

	info(`Found heed at ${C.dim}${heedDir}${C.reset}`);

	const currentHash = cmd(`cd "${heedDir}" && git rev-parse --short HEAD`);
	info(`Current: ${C.dim}${currentHash}${C.reset}`);

	info("Checking for updates...");
	if (!cmd(`cd "${heedDir}" && git fetch origin main 2>&1`)) {
		// Try without auth (public repo)
		if (!cmd(`cd "${heedDir}" && git fetch origin 2>&1`)) {
			err("Failed to fetch. Check your internet connection.");
			process.exit(1);
		}
	}

	// Compare by hash — works even if upstream history was REWRITTEN (where HEAD..origin/main is meaningless).
	const localFull = cmd(`cd "${heedDir}" && git rev-parse HEAD`);
	const remoteFull = cmd(`cd "${heedDir}" && git rev-parse origin/main`);
	if (localFull && remoteFull && localFull === remoteFull) {
		ok("Already up to date!");
		process.exit(0);
	}

	// Show a changelog only for a clean fast-forward (a rewritten/diverged history has no linear log to show).
	const changelog = cmd(`cd "${heedDir}" && git merge-base --is-ancestor HEAD origin/main && git log --oneline HEAD..origin/main`);
	if (changelog) {
		log("");
		changelog.split("\n").forEach((line) => log(`  ${C.dim}${line}${C.reset}`));
		log("");
	}

	// Sync — fast-forward when possible, else self-heal a diverged/rewritten history (no confusing pull error).
	info("Downloading updates...");
	syncRepoToMain(heedDir);

	// Check what changed (diff the pre-update commit against the new HEAD — safe across a history rewrite).
	const diffFiles = cmd(`cd "${heedDir}" && git diff --name-only ${currentHash} HEAD`) || "";

	if (diffFiles.includes("package.json") || diffFiles.includes("bun.lock")) {
		info("Dependencies changed, installing...");
		run(`cd "${heedDir}" && bun install`, "Dependencies updated");
	}

	if (diffFiles.includes("packages/client/")) {
		info("Frontend changed, rebuilding...");
		run(`cd "${heedDir}" && bun run build`, "Frontend rebuilt");
	}

	// Sync Python deps when EITHER requirements file changed. On Apple Silicon the live file is
	// requirements-core.txt (ignoring it left updated users on stale deps → broken transcription).
	const venvPy = join(heedDir, ".venv", "bin", "python3");
	const reqChanged = ["requirements.txt", "requirements-core.txt", "requirements-fallback.txt"]
		.filter((f) => diffFiles.includes(f));
	if (reqChanged.length) {
		if (existsSync(venvPy)) {
			for (const f of reqChanged) {
				info(`Python dependencies changed (${f}), updating .venv...`);
				run(`"${venvPy}" -m pip install -r "${heedDir}/packages/transcription/${f}"`, `${f} synced`);
			}
		} else {
			warn(`Python dependencies changed. Run: ${heedDir}/.venv/bin/python3 -m pip install -r ${heedDir}/packages/transcription/${reqChanged[0]}`);
		}
	}

	// Native Parakeet sidecar changed → rebuild it (Apple Silicon). Skips cleanly without Swift.
	if (IS_MAC && process.arch === "arm64" && diffFiles.includes("native/heed-parakeet/")) {
		const sidecarDir = join(heedDir, "packages", "transcription", "native", "heed-parakeet");
		if (hasCommand("swift") && existsSync(sidecarDir)) {
			info("Parakeet sidecar changed, rebuilding...");
			run(`cd "${sidecarDir}" && swift build -c release`, "Sidecar rebuilt");
		}
	}

	const newHash = cmd(`cd "${heedDir}" && git rev-parse --short HEAD`);
	log("");
	ok(`Updated! ${C.dim}${currentHash}${C.reset} → ${C.bold}${newHash}${C.reset}`);
	log(`  ${C.dim}Restart heed to apply: ${C.reset}${C.bold}cd "${heedDir}" && bun run dev${C.reset}`);
	log("");
}

// --- Find an existing heed install (shared by update/fallback/doctor) ---
function findHeedDir() {
	const candidates = [
		join(process.cwd(), "heed"),
		process.cwd(),
		join(homedir(), "heed"),
		join(homedir(), "Desktop", "heed"),
		join(homedir(), "Projects", "heed"),
	];
	for (const dir of candidates) {
		if (existsSync(join(dir, "package.json")) && existsSync(join(dir, "packages", "server"))) return dir;
	}
	return null;
}

// --- Fallback subcommand: install the heavy engine ON-DEMAND (Parakeet unavailable/broken) ---
async function fallback() {
	log("");
	log(`${C.bold}  heed fallback${C.reset} — install the fallback transcription engine`);
	log("");
	const heedDir = findHeedDir();
	if (!heedDir) { err("heed installation not found. Run `npx create-heed` first."); process.exit(1); }
	const venvPy = join(heedDir, ".venv", "bin", "python3");
	if (!existsSync(venvPy)) { err("No .venv found. Run `npx create-heed` first."); process.exit(1); }
	info(`Found heed at ${C.dim}${heedDir}${C.reset}`);
	const reqPath = join(heedDir, "packages", "transcription", "requirements-fallback.txt");
	warn("Installing fallback engine (~1.6GB: torch + pyannote + faster-whisper + mlx). One time.");
	if (!run(`"${venvPy}" -m pip install --upgrade pip`, "pip upgraded")) { /* non-fatal */ }
	if (!run(`"${venvPy}" -m pip install -r "${reqPath}"`, "Fallback engine installed")) {
		err("Fallback install failed."); process.exit(1);
	}
	// Persist the engine so the server stops trying the (missing/broken) Parakeet sidecar.
	const engine = IS_MAC ? "mlx" : "ctranslate2";
	try {
		mkdirSync(join(homedir(), ".heed-app"), { recursive: true });
		writeFileSync(join(homedir(), ".heed-app", "overrides.json"), JSON.stringify({ engine }, null, 2));
		ok(`Engine set to ${C.bold}${engine}${C.reset}`);
	} catch (e) { warn(`Could not write overrides.json: ${e.message}`); }
	log("");
	ok(`Fallback ready. Restart heed:  ${C.bold}cd "${heedDir}" && bun run dev${C.reset}`);
}

// --- Doctor subcommand: run the health check against an existing install ---
async function doctor() {
	log("");
	log(`${C.bold}  heed doctor${C.reset} — checking your install`);
	log("");
	const heedDir = findHeedDir();
	if (!heedDir) { err("heed installation not found. Run `npx create-heed` first."); process.exit(1); }
	const venvPy = join(heedDir, ".venv", "bin", "python3");
	if (!existsSync(venvPy)) { err("No .venv found. Run `npx create-heed` first."); process.exit(1); }
	const doctorPy = join(heedDir, "packages", "transcription", "doctor.py");
	const okDoc = run(`"${venvPy}" "${doctorPy}"`, "Doctor finished");
	if (!okDoc) {
		warn("Some checks failed. If transcription failed, install the fallback engine:");
		log(`  ${C.bold}npx create-heed fallback${C.reset}`);
	}
}

// --- Route subcommand ---
const subcommand = process.argv[2];
if (subcommand === "update") {
	update().catch((e) => { err(e.message); process.exit(1); });
} else if (subcommand === "fallback") {
	fallback().catch((e) => { err(e.message); process.exit(1); });
} else if (subcommand === "doctor") {
	doctor().catch((e) => { err(e.message); process.exit(1); });
} else {
	main().catch((e) => {
		err(e.message);
		process.exit(1);
	});
}
