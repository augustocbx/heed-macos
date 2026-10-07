import {render,screen,fireEvent,waitFor} from '@testing-library/react';
import {beforeEach,expect,it,vi} from 'vitest';
import {VocabularySettings} from './VocabularySettings';
import {VocabularySelection} from '../recording/VocabularySelection';
import {vocabularyApi} from '@/api/vocabulary';
import {setLocale,tr} from '@/lib/i18n';
import {VOCABULARY_TRANSLATIONS} from '@/lib/translations-vocabulary';
vi.mock('@/api/vocabulary',()=>({vocabularyApi:{read:vi.fn(),save:vi.fn(),import:vi.fn(),exportUrl:()=>'/api/vocabulary/export'}}));
const library={schemaVersion:1 as const,version:3,defaultGlossaryId:'work',glossaries:[{id:'work',name:'Work',version:2,entries:[{term:'João',hint:'John'},{term:'API'}]}]};
beforeEach(()=>{vi.clearAllMocks();setLocale('en');vi.mocked(vocabularyApi.read).mockResolvedValue(structuredClone(library));vi.mocked(vocabularyApi.save).mockImplementation(async value=>({...value,version:value.version+1}));});
it('searches, edits and removes Unicode terms using the versioned local library',async()=>{
 render(<VocabularySettings/>);await screen.findByText('João (John)');fireEvent.change(screen.getByLabelText('Search vocabulary'),{target:{value:'JOÃO'}});expect(screen.queryByText('API')).toBeNull();
 fireEvent.click(screen.getByText('Edit term'));fireEvent.change(screen.getByLabelText('Term'),{target:{value:'João São José'}});fireEvent.click(screen.getByText('Save term'));
 await waitFor(()=>expect(vocabularyApi.save).toHaveBeenCalledWith(expect.objectContaining({version:3,glossaries:[expect.objectContaining({entries:[{term:'João São José',hint:'John'},{term:'API'}]})]})));
 await screen.findByText('João São José (John)');fireEvent.click(screen.getByText('Remove term'));await waitFor(()=>expect(vocabularyApi.save).toHaveBeenCalledTimes(2));
});
it('keeps failed saves visible and allows explicit reload after a conflict',async()=>{
 vi.mocked(vocabularyApi.save).mockRejectedValue(Error('conflict'));render(<VocabularySettings/>);await screen.findByText('João (John)');fireEvent.change(screen.getByLabelText('Term'),{target:{value:'New'}});fireEvent.click(screen.getByText('Add term'));await screen.findByRole('alert');expect(screen.getByLabelText('Term')).toHaveValue('New');fireEvent.click(screen.getByText('Reload'));await waitFor(()=>expect(vocabularyApi.read).toHaveBeenCalledTimes(2));
});
it('uses explicit glossary and additions with malformed input blocking admission',async()=>{
 const onChange=vi.fn(),valid=vi.fn();render(<VocabularySelection value={{}} onChange={onChange} onValidityChange={valid}/>);await screen.findByText('Work');fireEvent.change(screen.getByLabelText('Glossary'),{target:{value:'none'}});expect(onChange).toHaveBeenCalledWith({glossaryId:null});
 fireEvent.change(screen.getByLabelText('Meeting additions'),{target:{value:'João | John | pt\nTypeScript'}});expect(onChange).toHaveBeenLastCalledWith({additions:[{term:'João',hint:'John',language:'pt'},{term:'TypeScript'}]});
 fireEvent.change(screen.getByLabelText('Meeting additions'),{target:{value:'API\napi'}});expect(valid).toHaveBeenLastCalledWith(false);expect(screen.getByRole('alert')).toBeVisible();
});
it('has complete vocabulary translations for every supported locale',()=>{
 for(const locale of ['pt-BR','fr','de'] as const)for(const key of Object.keys(VOCABULARY_TRANSLATIONS)){expect(tr(key,locale)).not.toBe(key);}
});

it('hydrates meeting additions after remount and reflects consumed additions',async()=>{
 const value={additions:[{term:'João',hint:'John',language:'pt' as const},{term:'API'}]};
 const first=render(<VocabularySelection value={value} onChange={vi.fn()}/>);expect(screen.getByLabelText('Meeting additions')).toHaveValue('João | John | pt\nAPI');first.unmount();
 const second=render(<VocabularySelection value={value} onChange={vi.fn()}/>);expect(screen.getByLabelText('Meeting additions')).toHaveValue('João | John | pt\nAPI');
 second.rerender(<VocabularySelection value={{}} onChange={vi.fn()}/>);expect(screen.getByLabelText('Meeting additions')).toHaveValue('');
});
