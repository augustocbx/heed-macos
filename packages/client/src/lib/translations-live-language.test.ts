import {expect,it} from 'vitest';
import {LIVE_LANGUAGE_TRANSLATIONS} from './translations-live-language';
import {tr} from './i18n';
it('preserves placeholders and translates every speech-control message in all supported locales',()=>{
 for(const [key,translations] of Object.entries(LIVE_LANGUAGE_TRANSLATIONS))for(const locale of ['pt-BR','fr','de'] as const){
  expect(tr(key,'en')).toBe(key);expect(translations[locale].trim()).not.toBe('');expect(tr(key,locale)).toBe(translations[locale]);
  expect((translations[locale].match(/\{[^}]+\}/g)||[]).sort()).toEqual((key.match(/\{[^}]+\}/g)||[]).sort());
 }
});
