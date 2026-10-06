import { useLocale } from '@/lib/i18n';
import type { TaskEvidence } from '@heed/shared';
import styles from './Tasks.module.css';
export function TaskSources({evidence,onSource}:{evidence:TaskEvidence[];onSource?:(evidence:TaskEvidence)=>void}){
 const {tr}=useLocale();
 return <div className={styles.sources}>{evidence.map((source,index)=><blockquote key={`${source.segmentIndex}-${index}`}>
  <p>{source.quote}</p><cite>{source.speaker}{source.start===null?'':` · ${Math.floor(source.start/60)}:${String(Math.floor(source.start%60)).padStart(2,'0')}`}</cite>
  {onSource&&<button type="button" onClick={()=>onSource(source)}>{tr('View task source')}</button>}
 </blockquote>)}</div>;
}
