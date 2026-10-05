import { afterEach, expect, it } from 'vitest';
import { detectLocale, t } from './i18n.ts';
afterEach(() => localStorage.removeItem('heed-locale'));
it('uses English interface text even when a legacy Spanish preference exists', () => {
 localStorage.setItem('heed-locale', 'es');
 expect(detectLocale()).toBe('en');
 expect(t('wizard.welcome', 'en')).toBe('Welcome to heed');
});
