/**
 * All Whisper-supported languages, ordered by popularity.
 */
export const WHISPER_LANGUAGES: Array<[code: string, name: string]> = [
	["auto", "auto-detect"],
	["en", "English"], ["es", "Spanish"], ["pt", "Portuguese"], ["fr", "French"],
	["de", "German"], ["it", "Italian"], ["ja", "Japanese"], ["ko", "Korean"],
	["zh", "Chinese"], ["ru", "Russian"], ["ar", "Arabic"], ["hi", "Hindi"],
	["nl", "Dutch"], ["pl", "Polish"], ["tr", "Turkish"], ["sv", "Swedish"],
	["da", "Danish"], ["no", "Norwegian"], ["fi", "Finnish"], ["cs", "Czech"],
	["el", "Greek"], ["he", "Hebrew"], ["id", "Indonesian"], ["ms", "Malay"],
	["th", "Thai"], ["vi", "Vietnamese"], ["uk", "Ukrainian"], ["ro", "Romanian"],
	["hu", "Hungarian"], ["bg", "Bulgarian"], ["ca", "Catalan"], ["hr", "Croatian"],
	["sk", "Slovak"], ["sl", "Slovenian"], ["et", "Estonian"], ["lv", "Latvian"],
	["lt", "Lithuanian"], ["fa", "Persian"], ["ur", "Urdu"], ["bn", "Bengali"],
	["ta", "Tamil"], ["te", "Telugu"], ["mr", "Marathi"], ["ml", "Malayalam"],
	["kn", "Kannada"], ["gu", "Gujarati"], ["pa", "Punjabi"], ["ne", "Nepali"],
	["si", "Sinhala"], ["my", "Burmese"], ["km", "Khmer"], ["lo", "Lao"],
	["ka", "Georgian"], ["hy", "Armenian"], ["az", "Azerbaijani"], ["kk", "Kazakh"],
	["uz", "Uzbek"], ["mn", "Mongolian"], ["af", "Afrikaans"], ["sw", "Swahili"],
	["am", "Amharic"], ["yo", "Yoruba"], ["ha", "Hausa"], ["so", "Somali"],
	["mt", "Maltese"], ["cy", "Welsh"], ["ga", "Irish"], ["is", "Icelandic"],
	["mk", "Macedonian"], ["sr", "Serbian"], ["bs", "Bosnian"], ["sq", "Albanian"],
	["eu", "Basque"], ["gl", "Galician"], ["be", "Belarusian"], ["lb", "Luxembourgish"],
	["fo", "Faroese"], ["oc", "Occitan"], ["br", "Breton"], ["mi", "Maori"],
	["haw", "Hawaiian"], ["mg", "Malagasy"], ["sn", "Shona"], ["ln", "Lingala"],
	["yi", "Yiddish"], ["la", "Latin"], ["sa", "Sanskrit"], ["ba", "Bashkir"],
	["tt", "Tatar"], ["tk", "Turkmen"], ["tg", "Tajik"], ["ps", "Pashto"],
	["bo", "Tibetan"], ["as", "Assamese"], ["or", "Odia"], ["nn", "Nynorsk"],
];

// Engine-aware language support, as reported by /health.languages.
export interface LanguageSupport {
	engine: string;
	codes: string[] | null; // null = all Whisper languages
	supports_auto: boolean;
}

// Pick a sensible default when no valid language is set: browser language if the engine
// supports it, else Spanish, else the first concrete (non-auto) supported code.
export function pickLanguageDefault(codes: string[] | null | undefined): string {
	const list = codes ?? WHISPER_LANGUAGES.map(([c]) => c).filter((c) => c !== "auto");
	const browser = typeof navigator !== "undefined" ? navigator.language?.slice(0, 2).toLowerCase() : undefined;
	if (browser && list.includes(browser)) return browser;
	if (list.includes("es")) return "es";
	return list.find((c) => c !== "auto") ?? "es";
}

// Resolve a requested language to one the ACTIVE engine can actually transcribe. This is the
// single source of truth used right before sending to the backend, so a stale "auto" (or an
// unsupported code) can NEVER reach Parakeet — which has no auto-detect and would otherwise
// silently transcribe in English.
export function resolveLanguage(requested: string | undefined, langs?: LanguageSupport | null): string {
	const req = requested || "auto";
	if (!langs) return req; // health not loaded yet → trust it (Whisper-safe default path)
	if (req === "auto") return langs.supports_auto ? "auto" : pickLanguageDefault(langs.codes);
	if (langs.codes && !langs.codes.includes(req)) return pickLanguageDefault(langs.codes);
	return req;
}
