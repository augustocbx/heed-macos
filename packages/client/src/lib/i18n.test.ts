import { afterEach, expect, it } from 'vitest';
import { detectLocale, t, tr, setLocale } from './i18n.ts';
import { normalizeLocale } from './locale.ts';
afterEach(() => {setLocale('en');localStorage.removeItem('heed-locale');});
it('uses English for unsupported legacy preferences and missing translations', () => {
 localStorage.setItem('heed-locale', 'es');expect(detectLocale()).toBe('en');
 expect(tr('A new untranslated label','fr')).toBe('A new untranslated label');
 expect(t('wizard.welcome','en')).toBe('Welcome to heed');
});
it('normalizes regional locales and localizes shell text in all supported languages',()=>{
 for(const [value,expected] of [['pt','pt-BR'],['pt-PT','pt-BR'],['fr-CA','fr'],['de-DE','de'],['en-US','en'],['zh-CN','en']])expect(normalizeLocale(value)).toBe(expected);
 expect(tr('Settings','pt-BR')).toBe('Configurações');expect(tr('Settings','fr')).toBe('Paramètres');expect(tr('Settings','de')).toBe('Einstellungen');
});
it('preserves original names and interpolation when translating',()=>{
 expect(tr('Based on Heed by Junior Rodriguez','de')).toContain('Junior Rodriguez');
 expect(tr('Unknown {value}','fr',{value:2})).toBe('Unknown 2');
});
