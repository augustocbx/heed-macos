import styles from './VocabularySelection.module.css';
import {useHealthStore} from '@/stores/health';
import {useEffect,useState} from 'react';
import type {VocabularyLibrary,VocabularySelection as Selection} from '@heed/shared';
import {vocabularyApi} from '@/api/vocabulary';
import {parseMeetingVocabulary} from '@/lib/vocabulary';
import {useLocale} from '@/lib/i18n';
const additionsText=(entries:Selection["additions"])=> (entries??[]).map(entry=>entry.term+(entry.hint||entry.language?` | ${entry.hint??""}`:"")+(entry.language?` | ${entry.language}`:"")).join("\n");
export function VocabularySelection({value,onChange,disabled=false,onValidityChange,finalModel}:{value:Selection;onChange:(value:Selection)=>void;disabled?:boolean;onValidityChange?:(valid:boolean)=>void;finalModel?:string}){
 const {tr}=useLocale();const live=useHealthStore(s=>s.health.languageCapabilities?.live);const [library,setLibrary]=useState<VocabularyLibrary|null>(null),[text,setText]=useState(()=>additionsText(value.additions)),[error,setError]=useState('');
 useEffect(()=>{setText(additionsText(value.additions));setError('');onValidityChange?.(true);},[value.additions]);
 useEffect(()=>{let active=true;void vocabularyApi.read().then(next=>{if(active)setLibrary(next);}).catch(()=>{if(active)setError('Could not load vocabulary. Retry by reopening this page.');});return()=>{active=false;};},[]);
 const additions=(next:string)=>{setText(next);try{onChange({...value,additions:parseMeetingVocabulary(next)});setError('');onValidityChange?.(true);}catch{setError('Use term | hint | en or pt for each addition.');onValidityChange?.(false);}};
 return <fieldset className={styles.panel} disabled={disabled}><legend>{tr('Meeting vocabulary')}</legend><label>{tr('Glossary')} <select aria-label={tr('Glossary')} value={value.glossaryId===undefined?'default':value.glossaryId===null?'none':`glossary:${value.glossaryId}`} onChange={event=>onChange({...value,glossaryId:event.target.value==='default'?undefined:event.target.value==='none'?null:event.target.value.slice(9)})}>
 <option value="default">{tr('Use default glossary')}{library?.defaultGlossaryId?` (${library.glossaries.find(g=>g.id===library.defaultGlossaryId)?.name||''})`:''}</option><option value="none">{tr('No glossary')}</option>{library?.glossaries.map(g=><option key={g.id} value={`glossary:${g.id}`}>{g.name}</option>)}</select></label>
 <label>{tr('Meeting additions')}<textarea aria-label={tr('Meeting additions')} value={text} onChange={event=>additions(event.target.value)} placeholder="João | John | pt"/></label>
 <p>{tr('One term per line: term | optional hint | optional en or pt. Additions apply only to this run.')}</p>
 <p>{tr('Whisper uses vocabulary as first-window recognition context. Native Parakeet in Heed does not apply it. Recognition is not guaranteed; hints never rename speakers or replace text.')}</p>
 {finalModel?<p>{tr(finalModel==="parakeet-v3"?"Selected model: native Parakeet. Glossary assistance is unsupported by this Heed path.":"Selected model: Whisper. Glossary assistance provides context for the first part of the recording.")}</p>:<p>{tr(live?.engine==="mlx"||live?.engine==="ctranslate2"?"Live glossary assistance provides context independently for each live Whisper chunk.":live?.engine==="parakeet"?"Live glossary assistance is unsupported by this native Heed path.":"Live glossary capability is unavailable until the service reports its model.")}</p>}
 {error&&<p role="alert">{tr(error)}</p>}</fieldset>;
}
