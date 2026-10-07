import { expect, test } from "vitest";
import { tr } from "./i18n";
import { RETRIEVAL_TRANSLATIONS } from "./translations-retrieval";
test("all retrieval labels have three translations and preserve every placeholder", () => {
  for (const [english, row] of Object.entries(RETRIEVAL_TRANSLATIONS)) {
    expect(tr(english, "en")).toBe(english);
    for (const locale of ["pt-BR", "fr", "de"] as const) {
      expect(row[locale].trim()).not.toBe("");
      expect(tr(english, locale)).toBe(row[locale]);
      expect(row[locale].match(/\{[^}]+\}/g)?.sort() ?? []).toEqual(
        english.match(/\{[^}]+\}/g)?.sort() ?? [],
      );
    }
  }
});
