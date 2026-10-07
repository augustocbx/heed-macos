import {beforeEach, expect, it, vi} from 'vitest';
import {fireEvent, render, screen, waitFor} from '@testing-library/react';
import {LiveSpeechLanguageSettings} from './LiveSpeechLanguageSettings';
import {useLocaleStore} from '@/stores/locale';
import {tr} from '@/lib/i18n';

const settings={enabled:false,liveLanguage:'en',activeLiveLanguage:'pt',activeEnabled:true,appliesTo:'next-recording',engineState:'deferred',liveLanguageState:'supported',languageCapabilities:{live:{engine:'mlx',model:'base.en',supportedLanguages:['en'],mode:'chunk'},final:{engine:'parakeet',model:'parakeet-v3',supportedLanguages:['en','pt']}}};
beforeEach(()=>{vi.restoreAllMocks();useLocaleStore.getState().sync('en');});
it.each(['en','pt-BR','fr','de'] as const)('saves speech language independently of interface locale and preview enabled in %s',async(locale)=>{
 useLocaleStore.getState().sync(locale);
 const requests:unknown[]=[];
 vi.spyOn(globalThis,'fetch').mockImplementation(async(_url,init)=>{
  if(init?.method==='POST')requests.push(JSON.parse(init.body as string));
  return Response.json({...settings,liveLanguage:init?.method==='POST'?'pt':'en',liveLanguageState:'unsupported'});
 });
 render(<LiveSpeechLanguageSettings/>);
 const select=await screen.findByRole('combobox',{name:tr('Live speech language')});
 await waitFor(()=>expect(select).toBeEnabled());fireEvent.change(select,{target:{value:'pt'}});
 await waitFor(()=>expect(select).toHaveValue('pt'));
 expect(requests).toEqual([{liveLanguage:'pt'}]);expect(useLocaleStore.getState().locale).toBe(locale);
 expect(screen.getByText(tr('Live engine: {engine} • model: {model}',locale,{engine:'mlx',model:'base.en'}))).toBeVisible();
 expect(screen.getByText(tr('Final engine: {engine} • model: {model}',locale,{engine:'parakeet',model:'parakeet-v3'}))).toBeVisible();
 expect(screen.getByText(tr('English-only models (.en) cannot preview Portuguese.'))).toBeVisible();
 expect(screen.getByText(tr('The final transcript automatically detects English or Portuguese. Mixed-language accuracy has not been verified.'))).toBeVisible();
 expect(screen.getByText(tr('Active recording: {language}. Changes apply to the next recording.',locale,{language:tr('Brazilian Portuguese')}))).toBeVisible();
 expect(screen.getAllByRole('option')).toHaveLength(2);
 expect(screen.getByRole('alert')).toHaveTextContent(tr('The live model does not support this language. Choose a compatible model or record final-only.'));
});
it('failed save preserves the authoritative language and allows retry',async()=>{
 vi.spyOn(globalThis,'fetch').mockImplementation(async(_url,init)=>init?.method==='POST'?Response.json({error:'disk unavailable'},{status:503}):Response.json({...settings,liveLanguageState:'unavailable'}));
 render(<LiveSpeechLanguageSettings/>);
 const select=await screen.findByRole('combobox');await waitFor(()=>expect(select).toBeEnabled());
 fireEvent.change(select,{target:{value:'pt'}});
 await screen.findByText('Could not save live speech language. Try again.');expect(select).toHaveValue('en');expect(select).toBeEnabled();
 expect(screen.getByText('Live language capabilities are unavailable. Retry when the service is ready or record final-only.')).toBeVisible();
});
