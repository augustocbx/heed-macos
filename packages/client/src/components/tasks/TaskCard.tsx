import {useEffect,useState} from 'react';
import type {TaskEvidence,TaskFields as Fields,TaskPatch,TaskView} from '@heed/shared';
import {useLocale} from '@/lib/i18n';
import {TaskFields} from './TaskFields';
import {TaskSources} from './TaskSources';
import styles from './Tasks.module.css';
const editableFields=(task:TaskView):Fields=>({title:task.title,description:task.description,assignee:task.assignee,dueDate:task.dueDate});
export function TaskCard({task,busy,onUpdate,onDelete,onSource}:{task:TaskView;busy:boolean;onUpdate:(task:TaskView,patch:TaskPatch)=>Promise<void>;onDelete:(task:TaskView)=>Promise<void>;onSource:(task:TaskView,evidence?:TaskEvidence)=>Promise<void>}) {
 const {tr,locale}=useLocale();const [editing,setEditing]=useState(false);const [draft,setDraft]=useState<Fields>(()=>editableFields(task));const [editRevision,setEditRevision]=useState(task.revision);
 // Polling can update completion/source status, but never overwrites an open edit form.
 useEffect(()=>{if(!editing)setDraft(editableFields(task));},[task,editing]);
 const save=async()=>{await onUpdate({...task,revision:editRevision},draft);setEditing(false);};
 const overdue=task.status==='open'&&task.dueDate!==null&&task.dueDate<new Date().toLocaleDateString('en-CA');
 return <article className={styles.card}>
  <div className={styles.row}><label><input type="checkbox" aria-label={tr('Mark task completed')} checked={task.status==='completed'} disabled={busy} onChange={()=>void onUpdate(task,{status:task.status==='open'?'completed':'open'}).catch(()=>{})}/>{tr(task.status==='completed'?'Completed':'Open')}</label><h3>{task.title}</h3></div>
  <p>{task.description}</p><p className={styles.meta}>{task.assignee||tr('No assignee')} · {task.dueDate||tr('No target date')}{overdue?` · ${tr('Overdue')}`:''}</p>
  {task.completedAt&&<p className={styles.meta}>{tr('Completed at')}: {new Date(task.completedAt).toLocaleString(locale)}</p>}
  <p className={styles.meta}>{task.meetingTitle} · {tr(task.sourceState==='meeting-deleted'?'Source meeting deleted':task.sourceState==='transcript-changed'?'Historical transcript evidence':'Transcript evidence')}</p>
  <p className={styles.meta}>{tr(task.audioAvailable?'Source audio available':'Source audio unavailable')}</p>
  <TaskSources evidence={task.evidence} onSource={task.sourceState==='available'?source=>void onSource(task,source):undefined}/>
  {task.sourceState!=='meeting-deleted'&&<button type="button" disabled={busy} onClick={()=>void onSource(task)}>{tr('Open source meeting')}</button>}
  {editing?<div><TaskFields value={draft} onChange={setDraft} disabled={busy}/><div className={styles.row}><button type="button" disabled={busy||!draft.title.trim()} onClick={()=>void save().catch(()=>{})}>{tr('Save task')}</button><button type="button" disabled={busy} onClick={()=>setEditing(false)}>{tr('Cancel')}</button></div></div>:<div className={styles.row}><button type="button" disabled={busy} onClick={()=>{setEditRevision(task.revision);setEditing(true);}}>{tr('Edit task')}</button><button type="button" disabled={busy} onClick={()=>{if(window.confirm(tr('Delete this task? Source suggestions remain reviewed.')))void onDelete(task);}}>{tr('Delete task')}</button></div>}
 </article>;
}
