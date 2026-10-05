/** English interface strings. Meeting language selection is independent. */

export type Locale = "en";

export function detectLocale(): Locale {
	return "en";
}

export function setLocale(locale: Locale): void {
	localStorage.setItem("heed-locale", locale);
}

type StringMap = Record<string, { en: string }>;

const STRINGS: StringMap = {
	// --- Wizard shell ---
	"wizard.welcome": {
		en: "Welcome to heed",
	},
	"wizard.subtitle": {
		en: "Let's set up your machine in under a minute.",
	},
	"wizard.step": {
		en: "Step {current} of {total}",
	},
	"wizard.skip": {
		en: "Skip setup",
	},
	"wizard.copyCmd": {
		en: "Copy command",
	},
	"wizard.copied": {
		en: "Copied",
	},
	"wizard.iHaveIt": {
		en: "I have it already",
	},
	"wizard.runningCmd": {
		en: "This command will run:",
	},
	"wizard.installing": {
		en: "Installing...",
	},
	"wizard.installed": {
		en: "Installed successfully",
	},
	"wizard.installFailed": {
		en: "Something failed during install",
	},
	"wizard.next": {
		en: "Next",
	},
	"wizard.back": {
		en: "Back",
	},
	"wizard.finish": {
		en: "Start using heed",
	},
	"wizard.allReady": {
		en: "All set. Your machine is ready to run heed.",
	},

	// --- Step 1: Ollama ---
	"setup.ollama.title": {
		en: "Ollama: the local AI engine",
	},
	"setup.ollama.body": {
		en: "Ollama runs language models on your machine without sending anything to the cloud. We need it to generate your meeting notes.",
	},
	"setup.ollama.installBtn": {
		en: "Install Ollama",
	},
	"setup.ollama.detected": {
		en: "Ollama is installed and running on your machine.",
	},
	"setup.ollama.notRunning": {
		en: "Ollama is installed but not running. Starting it...",
	},

	// --- Step 2: ffmpeg ---
	"setup.ffmpeg.title": {
		en: "ffmpeg: for recording and processing audio",
	},
	"setup.ffmpeg.body": {
		en: "ffmpeg captures audio from your microphone and system, and converts it to the format the transcription engine needs.",
	},
	"setup.ffmpeg.installBtn": {
		en: "Install ffmpeg",
	},
	"setup.ffmpeg.detected": {
		en: "ffmpeg is already on your system.",
	},
	"setup.ffmpeg.unsupportedOS": {
		en: "Your operating system doesn't support auto-install. Copy the command manually.",
	},

	// --- Step 3: Model ---
	"setup.model.title": {
		en: "Pick your AI model",
	},
	"setup.model.body": {
		en: "We detected your hardware and only show models that can run on your machine. We recommend one by default, but you can pick another.",
	},
	"setup.model.hardwareTitle": {
		en: "Your hardware",
	},
	"setup.model.hardwareNoGpu": {
		en: "No compatible GPU detected. heed will run models on CPU.",
	},
	"setup.model.hardwareExplain": {
		en: "We only show models that fit in {total}GB of memory. Llama 70B, Gemma 4 31B and Qwen 32B need more memory (16GB+).",
	},
	"setup.model.recommended": {
		en: "Recommended for your GPU",
	},
	"setup.model.others": {
		en: "Others that also fit in GPU",
	},
	"setup.model.cpuOnly": {
		en: "CPU only (better quality, slower)",
	},
	"setup.model.cpuHint": {
		en: "These models don't fit your GPU but can run on CPU. Notes take 3-4x longer to generate, but the quality is better.",
	},
	"setup.model.runtimeWarn": {
		en: "Fits your hardware, but there's not enough free memory right now. Close other apps before downloading.",
	},
	"setup.model.downloadBtn": {
		en: "Download {size}",
	},
	"setup.model.installed": {
		en: "Already installed",
	},
	"setup.model.downloading": {
		en: "Downloading...",
	},
};

export function t(key: string, locale: Locale, vars?: Record<string, string | number>): string {
	const entry = STRINGS[key];
	if (!entry) return key;
	let str = entry[locale] || entry.en || key;
	if (vars) {
		for (const [k, v] of Object.entries(vars)) {
			str = str.replace(`{${k}}`, String(v));
		}
	}
	return str;
}
