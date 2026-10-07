import {create} from 'zustand';
import type {VocabularySelection} from '@heed/shared';
/** Only the upcoming meeting selection is transient; the library/default persist on the local server. */
export const useVocabularyStore=create<{selection:VocabularySelection;setSelection:(selection:VocabularySelection)=>void;consumeAdditions:(admitted:VocabularySelection)=>void}>(set=>({selection:{},setSelection:selection=>set({selection}),consumeAdditions:admitted=>set(state=>state.selection===admitted?{selection:admitted.glossaryId===undefined?{}:{glossaryId:admitted.glossaryId}}:{})}));
