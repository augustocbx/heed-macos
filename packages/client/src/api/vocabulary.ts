import {apiClient,buildUrl} from './client';
import {validateVocabularyEntries,vocabularyText} from '../../../shared/lib/vocabulary';
import type {VocabularyLibrary,VocabularySelection,VocabularySnapshot} from '@heed/shared';
export const vocabularyApi={
 read:async()=>{const library=await apiClient.get<VocabularyLibrary>('/api/vocabulary');if(!library||library.schemaVersion!==1||!Number.isSafeInteger(library.version)||library.version<0||!Array.isArray(library.glossaries))throw Error('Invalid vocabulary library');for(const glossary of library.glossaries){vocabularyText(glossary.name,100);validateVocabularyEntries(glossary.entries);}return library;},
 save:(library:VocabularyLibrary)=>apiClient.post<VocabularyLibrary>('/api/vocabulary',{library,expectedVersion:library.version}),
 import:(importText:string,expectedVersion:number)=>apiClient.post<VocabularyLibrary>('/api/vocabulary',{importText,expectedVersion}),
 snapshot:(selection:VocabularySelection)=>apiClient.post<VocabularySnapshot>('/api/vocabulary/snapshot',selection),
 exportUrl:()=>buildUrl('/api/vocabulary/export'),
};
