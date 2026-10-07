import { expect, test } from 'vitest';
import { EXPORT_TRANSLATIONS } from './translations-exports';
import { tr } from './i18n';
test('all export messages preserve variables across the four supported locales', () => {
 for (const [english, locales] of Object.entries(EXPORT_TRANSLATIONS)) {
  const expected = english.match(/\{[^}]+\}/g) ?? [];
  expect(tr(english, 'en')).toBe(english);
  for (const locale of ['pt-BR', 'fr', 'de'] as const) {
   expect(locales[locale]?.trim()).toBeTruthy(); expect(locales[locale]?.match(/\{[^}]+\}/g) ?? []).toEqual(expected);
   expect(tr(english, locale)).toBe(locales[locale]);
  }
 }
});
