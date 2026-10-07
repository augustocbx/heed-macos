/** Device-local recognition assistance; never implicitly included in provider records. */
export interface VocabularyEntry {term:string;hint?:string;language?:'en'|'pt'}
export interface VocabularyGlossary {id:string;name:string;version:number;entries:VocabularyEntry[]}
export interface VocabularyLibrary {schemaVersion:1;version:number;defaultGlossaryId:string|null;glossaries:VocabularyGlossary[]}
export interface VocabularySelection {glossaryId?:string|null;additions?:VocabularyEntry[]}
export interface VocabularySnapshot {schemaVersion:1;libraryVersion:number;glossaryId:string|null;glossaryVersion:number|null;entries:VocabularyEntry[];additions:VocabularyEntry[]}
export interface VocabularyPathConfiguration {engine:string;model:string;language:string;status:'recognition-context'|'unsupported'|'empty';interface:'initial_prompt'|null;prompt:string|null;usedEntries:VocabularyEntry[];excludedEntries:VocabularyEntry[]}
export interface VocabularyRun {schemaVersion:1;snapshot:VocabularySnapshot;configuration:VocabularyPathConfiguration}
