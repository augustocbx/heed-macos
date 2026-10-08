import { expect, test } from 'vitest';
import { AI_TRANSLATIONS } from './translations-ai';
import { tr } from './i18n';
import { CHAT_TRANSLATIONS } from './translations-chat';
import { SHELL_TRANSLATIONS } from './translations-shell';

test.each(['en', 'pt-BR', 'fr', 'de'] as const)(
 'preserves the established Meeting chat label in %s', (locale) => {
  expect(tr('Meeting chat', locale)).toBe(locale === 'en' ? 'Meeting chat' : CHAT_TRANSLATIONS['Meeting chat'][locale]);
 });

test.each(['en', 'pt-BR', 'fr', 'de'] as const)(
 'preserves the established Saving… label in %s', (locale) => {
  expect(tr('Saving…', locale)).toBe(locale === 'en' ? 'Saving…' : SHELL_TRANSLATIONS['Saving…'][locale]);
 });

test('integrates every AI string with complete translations and identical placeholders', () => {
 expect(Object.keys(AI_TRANSLATIONS).length).toBeGreaterThan(40);
 for (const [key, values] of Object.entries(AI_TRANSLATIONS)) for (const locale of ['pt-BR', 'fr', 'de'] as const) {
  expect(tr(key, 'en')).toBe(key); expect(values[locale].trim()).not.toBe(''); expect(tr(key, locale)).toBe(values[locale]);
  expect((values[locale].match(/\{[^}]+\}/g) || []).sort()).toEqual((key.match(/\{[^}]+\}/g) || []).sort());
 }
});
