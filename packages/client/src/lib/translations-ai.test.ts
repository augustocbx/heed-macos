import { expect, test } from 'vitest';
import { AI_TRANSLATIONS } from './translations-ai';
import { tr } from './i18n';
test('integrates every AI string with complete translations and identical placeholders', () => {
 expect(Object.keys(AI_TRANSLATIONS).length).toBeGreaterThan(40);
 for (const [key, values] of Object.entries(AI_TRANSLATIONS)) for (const locale of ['pt-BR', 'fr', 'de'] as const) {
  expect(tr(key, 'en')).toBe(key); expect(values[locale].trim()).not.toBe(''); expect(tr(key, locale)).toBe(values[locale]);
  expect((values[locale].match(/\{[^}]+\}/g) || []).sort()).toEqual((key.match(/\{[^}]+\}/g) || []).sort());
 }
});
