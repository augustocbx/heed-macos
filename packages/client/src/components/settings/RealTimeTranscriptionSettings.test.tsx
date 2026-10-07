import {beforeEach, expect, it, vi} from 'vitest';
import {fireEvent, render, screen, waitFor} from '@testing-library/react';
import {RealTimeTranscriptionSettings} from './RealTimeTranscriptionSettings';
import {useLocaleStore} from '@/stores/locale';
import {tr} from '@/lib/i18n';

beforeEach(()=>{useLocaleStore.getState().sync('en');vi.restoreAllMocks();});
it.each([['en','Real-time transcription','Saved.'],['pt-BR','Transcrição em tempo real','Salvo.'],['fr','Transcription en temps réel','Enregistré.'],['de','Echtzeittranskription','Gespeichert.']] as const)('saves the authoritative preference and explains next-recording behavior in %s',async(locale,label,savedPrefix)=>{
 useLocaleStore.getState().sync(locale);
 const requests:RequestInit[]=[];
 vi.spyOn(globalThis,'fetch').mockImplementation(async(_url,init)=>{
  if(init?.method==='POST')requests.push(init);
  return Response.json({enabled:init?.method==='POST'?false:true,activeEnabled:true,appliesTo:'next-recording',engineState:'deferred'});
 });
 render(<RealTimeTranscriptionSettings/>);
 const checkbox=await screen.findByRole('checkbox',{name:label});
 expect(checkbox).toBeChecked();fireEvent.click(checkbox);
 await waitFor(()=>expect(checkbox).not.toBeChecked());
 expect(JSON.parse(requests[0].body as string)).toEqual({enabled:false});
 expect(screen.getByRole('status')).toHaveTextContent(savedPrefix);
 expect(screen.getByRole('status')).toHaveTextContent(tr('Saved. Changes apply to the next recording; the current recording keeps its mode.'));
 expect(screen.getByText(tr('Turning this off reduces processing during capture. RAM savings depend on shared model residency; final processing may still peak.'))).toBeVisible();
});
it('a failed save keeps the saved mode visible and permits retry',async()=>{
 vi.spyOn(globalThis,'fetch').mockImplementation(async(_url,init)=>init?.method==='POST'?Response.json({error:'disk unavailable'},{status:503}):Response.json({enabled:true,activeEnabled:null,appliesTo:'next-recording',engineState:'ready'}));
 render(<RealTimeTranscriptionSettings/>);
 const checkbox=await screen.findByRole('checkbox',{name:'Real-time transcription'});
 fireEvent.click(checkbox);expect(await screen.findByRole('alert')).toHaveTextContent('Could not save real-time transcription settings. Try again.');
 expect(checkbox).toBeChecked();expect(checkbox).toBeEnabled();
});
