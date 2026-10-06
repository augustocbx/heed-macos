import { useLocale } from '@/lib/i18n';
import type { TaskFields as Fields } from '@heed/shared';
import styles from './Tasks.module.css';
export function TaskFields({value,onChange,disabled}:{value:Fields;onChange:(value:Fields)=>void;disabled?:boolean}) {
 const {tr}=useLocale();
 return <div className={styles.fields}>
  <label>{tr('Task title')}<input required maxLength={500} value={value.title} disabled={disabled} onChange={event=>onChange({...value,title:event.target.value})}/></label>
  <label>{tr('Task description')}<textarea maxLength={10000} value={value.description} disabled={disabled} onChange={event=>onChange({...value,description:event.target.value})}/></label>
  <div className={styles.row}>
   <label>{tr('Assignee (optional)')}<input maxLength={500} value={value.assignee||''} disabled={disabled} onChange={event=>onChange({...value,assignee:event.target.value||null})}/></label>
   <label>{tr('Target date')}<input type="date" value={value.dueDate||''} disabled={disabled} onChange={event=>onChange({...value,dueDate:event.target.value||null})}/></label>
   <button type="button" disabled={disabled||!value.dueDate} onClick={()=>onChange({...value,dueDate:null})}>{tr('Clear date')}</button>
  </div>
  {!value.dueDate&&<small>{tr('No target date')}</small>}
 </div>;
}
