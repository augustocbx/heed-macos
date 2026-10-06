import { describe, expect, it } from 'vitest';
import { DIRECT_SMB_TRANSLATIONS } from './translations-smb-direct';
import { tr } from './i18n';
describe('direct SMB translations',()=>{
 it('covers each English fallback key in Brazilian Portuguese, French and German',()=>{
  expect(Object.keys(DIRECT_SMB_TRANSLATIONS).length).toBeGreaterThan(35);
  for(const [english,values]of Object.entries(DIRECT_SMB_TRANSLATIONS)){
   expect(Object.keys(values).sort()).toEqual(['de','fr','pt-BR']); expect(tr(english,'en')).toBe(english);
   for(const locale of ['pt-BR','fr','de'] as const){expect(values[locale]).toBeTruthy();expect(values[locale]).not.toBe(english);expect(tr(english,locale)).toBe(values[locale]);}
  }
 });
 it('renders distinctive translated authentication, creation and recovery instructions',()=>{
  expect(tr('Authentication verified','pt-BR')).toBe('Autenticação verificada');
  expect(tr('Create a Heed Library in this verified empty folder','fr')).toBe('Créer une bibliothèque Heed dans ce dossier vide vérifié');
  expect(tr('Recover original direct operation','de')).toBe('Ursprünglichen direkten Vorgang wiederherstellen');
 });
});
