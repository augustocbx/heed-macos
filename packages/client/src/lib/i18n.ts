/**
 * Lightweight i18n for heed. No library, no runtime — just two string maps.
 *
 * The wizard is the only place that needs translation right now (Ollama, ffmpeg
 * and the model picker labels). Adding more strings is appending two keys.
 *
 * Locale detection: navigator.language. "es-*" → Spanish, anything else → English.
 * The user can override via localStorage("heed-locale") if they want.
 */

export type Locale = "es" | "en";

export function detectLocale(): Locale {
	if (typeof window === "undefined") return "en";
	const stored = localStorage.getItem("heed-locale");
	if (stored === "es" || stored === "en") return stored;
	const lang = (navigator.language || "en").toLowerCase();
	return lang.startsWith("es") ? "es" : "en";
}

export function setLocale(locale: Locale): void {
	localStorage.setItem("heed-locale", locale);
}

type StringMap = Record<string, { es: string; en: string }>;

const STRINGS: StringMap = {
	// --- Wizard shell ---
	"wizard.welcome": {
		es: "Bienvenido a heed",
		en: "Welcome to heed",
	},
	"wizard.subtitle": {
		es: "Vamos a configurar tu maquina en menos de un minuto.",
		en: "Let's set up your machine in under a minute.",
	},
	"wizard.step": {
		es: "Paso {current} de {total}",
		en: "Step {current} of {total}",
	},
	"wizard.skip": {
		es: "Saltar configuracion",
		en: "Skip setup",
	},
	"wizard.copyCmd": {
		es: "Copiar comando",
		en: "Copy command",
	},
	"wizard.copied": {
		es: "Copiado",
		en: "Copied",
	},
	"wizard.iHaveIt": {
		es: "Ya lo tengo instalado",
		en: "I have it already",
	},
	"wizard.runningCmd": {
		es: "Este comando se va a ejecutar:",
		en: "This command will run:",
	},
	"wizard.installing": {
		es: "Instalando...",
		en: "Installing...",
	},
	"wizard.installed": {
		es: "Instalado correctamente",
		en: "Installed successfully",
	},
	"wizard.installFailed": {
		es: "Algo fallo durante la instalacion",
		en: "Something failed during install",
	},
	"wizard.next": {
		es: "Siguiente",
		en: "Next",
	},
	"wizard.back": {
		es: "Atras",
		en: "Back",
	},
	"wizard.finish": {
		es: "Empezar a usar heed",
		en: "Start using heed",
	},
	"wizard.allReady": {
		es: "Todo listo. Tu maquina puede correr heed.",
		en: "All set. Your machine is ready to run heed.",
	},

	// --- Step 1: Ollama ---
	"setup.ollama.title": {
		es: "Ollama: el motor de IA local",
		en: "Ollama: the local AI engine",
	},
	"setup.ollama.body": {
		es: "Ollama corre los modelos de lenguaje en tu maquina, sin enviar nada a la nube. Lo necesitamos para generar las notas de tus reuniones.",
		en: "Ollama runs language models on your machine without sending anything to the cloud. We need it to generate your meeting notes.",
	},
	"setup.ollama.installBtn": {
		es: "Instalar Ollama",
		en: "Install Ollama",
	},
	"setup.ollama.detected": {
		es: "Ollama esta instalado y corriendo en tu maquina.",
		en: "Ollama is installed and running on your machine.",
	},
	"setup.ollama.notRunning": {
		es: "Ollama esta instalado pero no esta corriendo. Iniciandolo...",
		en: "Ollama is installed but not running. Starting it...",
	},

	// --- Step 2: ffmpeg ---
	"setup.ffmpeg.title": {
		es: "ffmpeg: para grabar y procesar audio",
		en: "ffmpeg: for recording and processing audio",
	},
	"setup.ffmpeg.body": {
		es: "ffmpeg captura el audio de tu microfono y de tu sistema, y lo convierte al formato que necesita el motor de transcripcion.",
		en: "ffmpeg captures audio from your microphone and system, and converts it to the format the transcription engine needs.",
	},
	"setup.ffmpeg.installBtn": {
		es: "Instalar ffmpeg",
		en: "Install ffmpeg",
	},
	"setup.ffmpeg.detected": {
		es: "ffmpeg ya esta en tu sistema.",
		en: "ffmpeg is already on your system.",
	},
	"setup.ffmpeg.unsupportedOS": {
		es: "Tu sistema operativo no permite la instalacion automatica. Copia el comando manualmente.",
		en: "Your operating system doesn't support auto-install. Copy the command manually.",
	},

	// --- Step 3: Model ---
	"setup.model.title": {
		es: "Elige tu modelo de IA",
		en: "Pick your AI model",
	},
	"setup.model.body": {
		es: "Detectamos tu hardware y solo te mostramos modelos que pueden correr en tu maquina. Recomendamos uno por defecto, pero puedes elegir otro.",
		en: "We detected your hardware and only show models that can run on your machine. We recommend one by default, but you can pick another.",
	},
	"setup.model.hardwareTitle": {
		es: "Tu hardware",
		en: "Your hardware",
	},
	"setup.model.hardwareNoGpu": {
		es: "No detectamos GPU compatible. heed correra los modelos en CPU.",
		en: "No compatible GPU detected. heed will run models on CPU.",
	},
	"setup.model.hardwareExplain": {
		es: "Solo mostramos modelos que caben en {total}GB de memoria. Los Llama 70B, Gemma 4 31B y Qwen 32B necesitan mas memoria (16GB+).",
		en: "We only show models that fit in {total}GB of memory. Llama 70B, Gemma 4 31B and Qwen 32B need more memory (16GB+).",
	},
	"setup.model.recommended": {
		es: "Recomendado para tu GPU",
		en: "Recommended for your GPU",
	},
	"setup.model.others": {
		es: "Otros que tambien caben en GPU",
		en: "Others that also fit in GPU",
	},
	"setup.model.cpuOnly": {
		es: "Solo CPU (mejor calidad, mas lentos)",
		en: "CPU only (better quality, slower)",
	},
	"setup.model.cpuHint": {
		es: "Estos modelos no caben en tu GPU pero pueden correr en CPU. Las notas tardan 3-4 veces mas, pero la calidad es mejor.",
		en: "These models don't fit your GPU but can run on CPU. Notes take 3-4x longer to generate, but the quality is better.",
	},
	"setup.model.runtimeWarn": {
		es: "Cabe en tu hardware pero ahora mismo no hay memoria libre suficiente. Cierra otras apps antes de descargarlo.",
		en: "Fits your hardware, but there's not enough free memory right now. Close other apps before downloading.",
	},
	"setup.model.downloadBtn": {
		es: "Descargar {size}",
		en: "Download {size}",
	},
	"setup.model.installed": {
		es: "Ya instalado",
		en: "Already installed",
	},
	"setup.model.downloading": {
		es: "Descargando...",
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
