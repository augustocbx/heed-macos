import type {VocabularyEntry,VocabularySnapshot} from '../types/vocabulary';
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
function fields(value:Record<string,unknown>,allowed:string[]){if(Object.keys(value).some(key=>!allowed.includes(key)))throw Error('Unknown vocabulary field');}
export function vocabularyText(value:unknown,max:number):string {
 if(typeof value!=='string'||!value.trim()||value.length>max||/[\u0000-\u001f\u007f]/.test(value)||/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value))throw Error('Invalid vocabulary text');return value;
}
export const vocabularyIdentity=(entry:VocabularyEntry)=>`${entry.language||'*'}:${entry.term.normalize('NFC').trim().toLowerCase()}`;
export function validateVocabularyEntries(value:unknown):VocabularyEntry[]{
 if(!Array.isArray(value)||value.length>100)throw Error('Vocabulary supports at most 100 entries');const seen=new Set<string>();
 return value.map(item=>{if(!object(item))throw Error('Invalid vocabulary entry');fields(item,['term','hint','language']);const entry:VocabularyEntry={term:vocabularyText(item.term,120)};
  if(item.hint!==undefined)entry.hint=vocabularyText(item.hint,120);if(item.language!==undefined){if(item.language!=='en'&&item.language!=='pt')throw Error('Invalid vocabulary language');entry.language=item.language;}
  const key=vocabularyIdentity(entry),termKey=entry.term.normalize('NFC').trim().toLowerCase();if([...seen].some(prior=>{const split=prior.indexOf(':');return prior.slice(split+1)===termKey&&(prior.slice(0,split)==='*'||!entry.language||prior.slice(0,split)===entry.language);}))throw Error('Duplicate vocabulary term');seen.add(key);return entry;
 });
}
export function validateVocabularySnapshot(value:unknown):VocabularySnapshot {
 if(!object(value))throw Error('Invalid vocabulary snapshot');fields(value,['schemaVersion','libraryVersion','glossaryId','glossaryVersion','entries','additions']);
 if(value.schemaVersion!==1||!Number.isSafeInteger(value.libraryVersion)||(value.libraryVersion as number)<0||!(value.glossaryId===null||typeof value.glossaryId==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(value.glossaryId))||!(value.glossaryVersion===null||Number.isSafeInteger(value.glossaryVersion)&&(value.glossaryVersion as number)>0)||((value.glossaryId===null)!==(value.glossaryVersion===null)))throw Error('Invalid vocabulary snapshot version');
 const entries=validateVocabularyEntries(value.entries),additions=validateVocabularyEntries(value.additions);validateVocabularyEntries([...entries,...additions]);
 return {schemaVersion:1,libraryVersion:value.libraryVersion as number,glossaryId:value.glossaryId as string|null,glossaryVersion:value.glossaryVersion as number|null,entries,additions};
}

export function vocabularyConfiguration(snapshot:VocabularySnapshot,engine:string,model:string,language:string):import('../types/vocabulary').VocabularyPathConfiguration {
 const usedEntries:VocabularyEntry[]=[],excludedEntries:VocabularyEntry[]=[],phrases:string[]=[];const supported=['mlx','ctranslate2'].includes(engine);
 for(const entry of [...snapshot.entries,...snapshot.additions]){const phrase=entry.term+(entry.hint?` (${entry.hint})`:''),candidate=[...phrases,phrase].join(', ');
  if(!supported||(entry.language!==undefined&&entry.language!==language)||candidate.length>1500)excludedEntries.push(entry);else {usedEntries.push(entry);phrases.push(phrase);}}
 const prompt=phrases.join(', ')||null;return {engine,model,language,status:!supported&&(snapshot.entries.length+snapshot.additions.length)>0?'unsupported':prompt?'recognition-context':'empty',interface:supported?'initial_prompt':null,prompt,usedEntries,excludedEntries};
}
export function validateVocabularyRun(value:unknown):import('../types/vocabulary').VocabularyRun {
 if(!object(value))throw Error('Invalid vocabulary run');fields(value,['schemaVersion','snapshot','configuration']);if(value.schemaVersion!==1||!object(value.configuration))throw Error('Invalid vocabulary run');const snapshot=validateVocabularySnapshot(value.snapshot),config=value.configuration;
 fields(config,['engine','model','language','status','interface','prompt','usedEntries','excludedEntries']);const engine=vocabularyText(config.engine,100),model=vocabularyText(config.model,100),language=vocabularyText(config.language,100);
 const expected=vocabularyConfiguration(snapshot,engine,model,language);
 for(const key of ['status','interface','prompt','usedEntries','excludedEntries'] as const)if(JSON.stringify(config[key])!==JSON.stringify(expected[key]))throw Error('Vocabulary configuration does not match its snapshot');
 return {schemaVersion:1,snapshot,configuration:expected};
}
