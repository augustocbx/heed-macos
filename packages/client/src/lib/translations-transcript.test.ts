import { expect, test } from "vitest";
import { tr } from "./i18n";
import { TRANSCRIPT_TRANSLATIONS } from "./translations-transcript";
test("every correction message preserves placeholders in all four locales", () => {
  for (const [english, translations] of Object.entries(
    TRANSCRIPT_TRANSLATIONS,
  )) {
    expect(tr(english, "en")).toBe(english);
    for (const locale of ["pt-BR", "fr", "de"] as const) {
      const translated = translations[locale];
      expect(translated.trim()).not.toBe("");
      expect(tr(english, locale)).toBe(translated);
      expect(translated.match(/\{[^}]+\}/g)?.sort() ?? []).toEqual(
        english.match(/\{[^}]+\}/g)?.sort() ?? [],
      );
    }
  }
});
