export const UI_LOCALES = ["en", "pt-BR", "fr", "de"] as const;
export type Locale = typeof UI_LOCALES[number];
export function normalizeLocale(value: unknown): Locale {
 if (typeof value !== "string") return "en";
 const language=value.trim().toLowerCase().split(/[-_]/)[0];
 return language === "pt" ? "pt-BR" : language === "fr" ? "fr" : language === "de" ? "de" : "en";
}
export function storedLocale(): Locale {
 try {return normalizeLocale(localStorage.getItem("heed-locale"));} catch {return "en";}
}
