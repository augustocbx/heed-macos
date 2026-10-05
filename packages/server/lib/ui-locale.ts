export const UI_LOCALES = ["en", "pt-BR", "fr", "de"] as const;
export type UiLocale = typeof UI_LOCALES[number];
export function supportedUiLocale(value:unknown): value is UiLocale {return UI_LOCALES.includes(value as UiLocale);}
export function configuredUiLocale(config:{ui_locale?:unknown}):UiLocale {
 if(typeof config.ui_locale !== "string") return "en";
 const language=config.ui_locale.trim().toLowerCase().split(/[-_]/)[0];
 return language === "pt" ? "pt-BR" : language === "fr" ? "fr" : language === "de" ? "de" : "en";
}
