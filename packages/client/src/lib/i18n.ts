import {VOCABULARY_TRANSLATIONS} from './translations-vocabulary';
import {IMPORT_TRANSLATIONS} from './translations-import';
import {RETRIEVAL_TRANSLATIONS} from './translations-retrieval';
import {LIVE_LANGUAGE_TRANSLATIONS} from "./translations-live-language";
import {RECORDING_TRANSLATIONS} from './translations-recording';
import {EXPORT_TRANSLATIONS} from './translations-exports';
import {TRANSCRIPT_TRANSLATIONS} from './translations-transcript';
import {SERVICE_TRANSLATIONS} from './translations-services';
import {DELETION_TRANSLATIONS} from './translations-deletion';
import {GOOGLE_DRIVE_TRANSLATIONS} from './translations-google-drive';
import {ONEDRIVE_TRANSLATIONS} from "./translations-onedrive";
import {ICLOUD_TRANSLATIONS} from "./translations-icloud";
import {LIBRARY_CHAT_TRANSLATIONS} from "./translations-library-chat";
import { CHAT_TRANSLATIONS } from "./translations-chat";
/** Interface language is independent of transcription language. Missing translations use English. */
import { useLocaleStore } from "@/stores/locale.ts";
import { normalizeLocale, storedLocale, type Locale } from "./locale.ts";
import { LIBRARY_TRANSLATIONS } from "./translations-library";
import { SHELL_TRANSLATIONS } from "./translations-shell.ts";
import { TASKS_TRANSLATIONS } from "./translations-tasks.ts";
import { NOTES_TRANSLATIONS } from "./translations-notes.ts";
import { CONTENT_TRANSLATIONS } from "./translations-content.ts";
import { DETECTION_TRANSLATIONS } from "./translations-detection";
import { SMB_TRANSLATIONS } from "./translations-smb";
export type { Locale } from "./locale.ts";
export function detectLocale(): Locale {return storedLocale();}
export function setLocale(locale: Locale): void {useLocaleStore.getState().sync(locale);}
export function useLocale() {
 const locale=useLocaleStore(s=>s.locale);
 return {locale,tr:(text:string,vars?:Record<string,string|number>)=>tr(text,locale,vars)};
}
import {STORAGE_TRANSLATIONS} from "./translations-storage";
import {AI_TRANSLATIONS} from './translations-ai';
const TRANSLATIONS={...VOCABULARY_TRANSLATIONS,...IMPORT_TRANSLATIONS,...LIVE_LANGUAGE_TRANSLATIONS,...RECORDING_TRANSLATIONS,...SERVICE_TRANSLATIONS,...DELETION_TRANSLATIONS,...SHELL_TRANSLATIONS,...CONTENT_TRANSLATIONS,...NOTES_TRANSLATIONS,...TASKS_TRANSLATIONS,...CHAT_TRANSLATIONS,...DETECTION_TRANSLATIONS,...LIBRARY_CHAT_TRANSLATIONS,...STORAGE_TRANSLATIONS,...LIBRARY_TRANSLATIONS,...SMB_TRANSLATIONS,...GOOGLE_DRIVE_TRANSLATIONS,...ONEDRIVE_TRANSLATIONS,...ICLOUD_TRANSLATIONS,...RETRIEVAL_TRANSLATIONS, ...TRANSCRIPT_TRANSLATIONS,...EXPORT_TRANSLATIONS,...AI_TRANSLATIONS};
export function tr(text:string,locale:Locale=useLocaleStore.getState().locale,vars?:Record<string,string|number>):string {
 const chosen=normalizeLocale(locale);
 const key=text.trim();
 const translated=chosen === "en" ? undefined : TRANSLATIONS[key]?.[chosen];
 let result=translated ? text.slice(0,text.indexOf(key))+translated+text.slice(text.indexOf(key)+key.length) : text;
 if(vars) result=result.replace(/\{([^{}]+)\}/g,(placeholder,key:string)=>Object.hasOwn(vars,key) ? String(vars[key]) : placeholder);
 return result;
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
 return tr(STRINGS[key]?.en || key,locale,vars);
}
