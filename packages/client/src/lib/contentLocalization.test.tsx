import {act,cleanup,render,screen} from '@testing-library/react';
import {afterEach,expect,test,vi} from 'vitest';
import type {Session} from '@heed/shared';
import {useLocaleStore} from '@/stores/locale';
import {RecordButton} from '@/components/recording/RecordButton';
import {SessionItem} from '@/components/sessions/SessionItem';
import {RetranscribeDialog} from '@/components/sessions/RetranscribeDialog';
import {CONTENT_TRANSLATIONS} from './translations-content';
const session={id:'s',title:'My unchanged meeting',createdAt:'2026-10-05T12:00:00Z',duration:3,language:'pt',speakers:['Augusto'],tags:[],transcript:'Original Portuguese speech',segments:[],aiNotes:'',summary:'',pinned:false,files:{wav:'sample.wav'},liveModel:'base',transcriptionModel:'parakeet-v3'} as Session;
afterEach(()=>{cleanup();useLocaleStore.setState({locale:'en'});});
for(const [locale,start,language,heading] of [
 ['pt-BR','Iniciar gravação','Português (Brasil)','Transcrever áudio salvo'],
 ['fr','Démarrer l’enregistrement','Portugais (Brésil)','Transcrire l’audio enregistré'],
 ['de','Aufnahme starten','Portugiesisch (Brasilien)','Gespeichertes Audio transkribieren'],
] as const) {
 test(`${locale} localizes recording, session metadata and transcription settings without changing user data`,()=>{
  useLocaleStore.setState({locale});
  render(<><RecordButton recording={false} onClick={vi.fn()}/><SessionItem session={session} onOpen={vi.fn()} onMenu={vi.fn()} onTagClick={vi.fn()} onDelete={vi.fn()}/><RetranscribeDialog session={session} onClose={vi.fn()} onBusy={vi.fn()}/></>);
  expect(screen.getByRole('button',{name:start})).toBeInTheDocument();
  expect(screen.getByRole('heading',{name:heading})).toBeInTheDocument();
  expect(screen.getAllByText(new RegExp(language.replace(/[()]/g,'\\$&'))).length).toBeGreaterThan(0);
  expect(screen.getByText('My unchanged meeting')).toBeInTheDocument();
  expect(screen.getByRole('option',{name:'Whisper small'})).toBeInTheDocument();
 });
}
test('recording controls follow an interface locale change while mounted',()=>{
 render(<RecordButton recording={false} onClick={vi.fn()}/>);
 expect(screen.getByRole('button',{name:'Start recording'})).toBeInTheDocument();
 act(()=>useLocaleStore.setState({locale:'fr'}));
 expect(screen.getByRole('button',{name:'Démarrer l’enregistrement'})).toBeInTheDocument();
});
test('translations retain every English placeholder',()=>{
 for(const [english,translations] of Object.entries(CONTENT_TRANSLATIONS)) {
  const tokens=[...english.matchAll(/\{(\w+)\}/g)].map(match=>match[0]).sort();
  for(const translation of Object.values(translations))expect([...translation.matchAll(/\{(\w+)\}/g)].map(match=>match[0]).sort()).toEqual(tokens);
 }
});
