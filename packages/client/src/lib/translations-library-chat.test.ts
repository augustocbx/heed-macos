import {expect,test} from 'vitest';
import {tr} from './i18n';
import {LIBRARY_CHAT_TRANSLATIONS} from './translations-library-chat';
test('scope controls and visible limits have complete four-locale fallback',()=>{
 for(const key of Object.keys(LIBRARY_CHAT_TRANSLATIONS))for(const locale of ['pt-BR','fr','de'] as const){expect(tr(key,locale)).not.toBe(key);expect(tr(key,locale)).toBeTruthy();}
 expect(tr('{count} eligible meetings','en',{count:4})).toBe('4 eligible meetings');expect(tr('{count} eligible meetings','pt-BR',{count:4})).toBe('4 reuniões disponíveis');
});
