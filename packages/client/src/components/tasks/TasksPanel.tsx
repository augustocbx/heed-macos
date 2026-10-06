import {useCallback,useEffect,useRef,useState} from 'react';
import type {Session,TaskEvidence,TaskFields as Fields,TaskPatch,TaskView,TasksSnapshot} from '@heed/shared';
import {useLocale} from '@/lib/i18n';
import {tasksApi} from '@/api/tasks';
import {sessionsApi} from '@/api/sessions';
import {useSessionsStore} from '@/stores/sessions';
import {useUIStore} from '@/stores/ui';
import {TaskFields} from './TaskFields';
import {TaskSources} from './TaskSources';
import {TaskCard} from './TaskCard';
import styles from './Tasks.module.css';
interface Props {session?:Session;onSeek?:(seconds:number)=>void;onShowTranscript?:(source?:TaskEvidence)=>void;}
const failedMessage:Record<string,string>={
 'model-missing':'Choose an installed local model to generate task suggestions.',
 'local-only':'Task suggestions require a local model.',
 'ollama-unavailable':'Start Ollama and retry task suggestions.',
};
export function TasksPanel({session,onSeek,onShowTranscript}:Props){
 const {tr}=useLocale();const [snapshot,setSnapshot]=useState<TasksSnapshot>({tasks:[]});const [loaded,setLoaded]=useState(false);
 const [error,setError]=useState('');const [busy,setBusy]=useState(false);const busyRef=useRef(false);const loadNumber=useRef(0);
 const [selected,setSelected]=useState<Set<string>>(new Set());const [drafts,setDrafts]=useState<Record<string,Fields>>({});
 const [status,setStatus]=useState('open');const [dateFilter,setDateFilter]=useState('all');const sourceRevision=useRef<string|undefined>(undefined);
 const refresh=useCallback(async()=>{
  if(busyRef.current)return;const sequence=++loadNumber.current;
  try{const result=await tasksApi.list(session?.id);if(sequence!==loadNumber.current)return;
   if(sourceRevision.current!==result.review?.sourceRevision){sourceRevision.current=result.review?.sourceRevision;setSelected(new Set());setDrafts({});}
   setSnapshot(result);setLoaded(true);setError('');
  }catch{if(sequence===loadNumber.current){setError('Could not load tasks. Please retry.');setLoaded(true);}}
 },[session?.id]);
 useEffect(()=>{
  setSnapshot({tasks:[]});setLoaded(false);setSelected(new Set());setDrafts({});sourceRevision.current=undefined;void refresh();
  const timer=window.setInterval(()=>void refresh(),3000);const focus=()=>void refresh();window.addEventListener('focus',focus);
  return()=>{++loadNumber.current;window.clearInterval(timer);window.removeEventListener('focus',focus);};
 },[refresh]);
 const mutate=async(work:()=>Promise<unknown>,rethrow=false)=>{
  if(busyRef.current)return;busyRef.current=true;++loadNumber.current;setBusy(true);setError('');
  try{await work();}catch(failure){setError((failure as Error).message||'Could not save tasks. Please retry.');if(rethrow)throw failure;}
  finally{busyRef.current=false;setBusy(false);}
 };
 const saveTask=(task:TaskView,patch:TaskPatch)=>mutate(async()=>{await tasksApi.update(task.id,task.revision,patch);await loadAfterMutation();},true);
 const loadAfterMutation=async()=>{const result=await tasksApi.list(session?.id);setSnapshot(result);};
 const openSource=async(task:TaskView,evidence?:TaskEvidence)=>{
  if(session?.id===task.sessionId){
   const currentSource=task.sourceState==='available'&&session.transcriptRevision===task.sourceRevision;
   onShowTranscript?.(currentSource?evidence:undefined);
   if(!currentSource&&evidence)useUIStore.getState().showToast('The transcript changed. Refresh before asking or retrying.');
   if(currentSource&&evidence?.start!==null&&evidence?.start!==undefined&&task.audioAvailable&&onSeek)onSeek(evidence.start);
   return;
  }
  await mutate(async()=>{
   const meeting=(await sessionsApi.list()).find(s=>s.id===task.sessionId);if(!meeting)throw new Error('Source meeting deleted');
   useSessionsStore.getState().accept(meeting);useSessionsStore.getState().view(meeting);
   const currentSource=task.sourceState==='available'&&meeting.transcriptRevision===task.sourceRevision;
   useUIStore.setState({currentPage:'sessions',
    chatSourceFocus:currentSource&&evidence?{...evidence,id:`${task.sessionId}:${task.sourceRevision}:${evidence.segmentIndex}:0`,sessionId:task.sessionId,segmentIndex:meeting.segments?.length?evidence.segmentIndex:null,paragraphIndex:null}:null,
    taskSourceSeek:currentSource&&task.audioAvailable&&evidence?.start!==null&&evidence?.start!==undefined?{sessionId:task.sessionId,seconds:evidence.start,sourceRevision:task.sourceRevision}:null});
   if(!currentSource&&evidence)useUIStore.getState().showToast('The transcript changed. Refresh before asking or retrying.');
  });
 };
 const review=snapshot.review;const currentReview=review?.status==='ready'&&session?.transcriptFinalized&&(!session.transcriptRevision||session.transcriptRevision===review.sourceRevision);
 const suggestions=currentReview?review!.suggestions.filter(s=>s.state==='suggested'):[];
 const tasks=snapshot.tasks.filter(t=>(status==='all'||t.status===status)&&(dateFilter==='all'||(dateFilter==='dated'?t.dueDate!==null:t.dueDate===null)));
 return <section className={styles.panel}>
  <h2>{tr('Tasks')}</h2><p className={styles.meta}>{tr('Suggestions stay local and become tasks only after you select and add them.')}</p>
  {error&&<div role="alert" className={styles.error}>{tr(error)} <button type="button" disabled={busy} onClick={()=>void refresh()}>{tr('Retry')}</button></div>}
  {!loaded&&<p role="status">{tr('Loading tasks…')}</p>}
  {session&&<section aria-label={tr('Suggested tasks')}>
   <h3>{tr('Suggested tasks')}</h3>
   {!session.transcriptFinalized&&<p>{tr('Task suggestions require the final transcript.')}</p>}
   {session.transcriptFinalized&&(!review||['queued','running','waiting','superseded'].includes(review.status))&&<p role="status">{tr('Waiting for local task suggestions…')}</p>}
   {review?.status==='failed'&&<div role="status"><p>{tr(failedMessage[review.error||'']||'Task suggestion generation failed. Retry to review the final transcript.')}</p><button type="button" disabled={busy} onClick={()=>void mutate(async()=>{setSnapshot(await tasksApi.retry(session.id));})}>{tr('Retry task suggestions')}</button></div>}
   {currentReview&&suggestions.length===0&&<p>{tr('No unreviewed task suggestions.')}</p>}
   {suggestions.map(suggestion=>{
    const draft=drafts[suggestion.id]||suggestion;
    return <article className={styles.card} key={suggestion.id}>
     <label className={styles.row}><input type="checkbox" aria-label={tr('Select suggestion {title}',{title:suggestion.title})} checked={selected.has(suggestion.id)} disabled={busy} onChange={event=>setSelected(previous=>{const next=new Set(previous);if(event.target.checked)next.add(suggestion.id);else next.delete(suggestion.id);return next;})}/><strong>{tr(suggestion.kind==='explicit'?'Explicit commitment':'Inferred suggestion — review carefully')}</strong></label>
     <TaskFields value={draft} onChange={value=>setDrafts(previous=>({...previous,[suggestion.id]:value}))} disabled={busy}/>
     {suggestion.dateReview&&<p><strong>{tr('Date needs review')}:</strong> <span>{suggestion.dateReview}</span></p>}
     <TaskSources evidence={suggestion.evidence} onSource={onShowTranscript||onSeek?source=>{onShowTranscript?.(source);if(onSeek&&source.start!==null)onSeek(source.start);}:undefined}/>
     <button type="button" disabled={busy} onClick={()=>void mutate(async()=>{setSnapshot(await tasksApi.dismiss(session.id,review!.sourceRevision,[suggestion.id]));setSelected(previous=>{const next=new Set(previous);next.delete(suggestion.id);return next;});})}>{tr('Dismiss suggestion')}</button>
    </article>;
   })}
   {currentReview&&suggestions.length>0&&<div className={styles.row}>
    <button type="button" disabled={busy||!suggestions.some(s=>selected.has(s.id))||suggestions.some(s=>selected.has(s.id)&&!(drafts[s.id]||s).title.trim())} onClick={()=>void mutate(async()=>{
     const items=suggestions.filter(s=>selected.has(s.id)).map(s=>({suggestionId:s.id,title:(drafts[s.id]||s).title,description:(drafts[s.id]||s).description,assignee:(drafts[s.id]||s).assignee,dueDate:(drafts[s.id]||s).dueDate}));
     setSnapshot(await tasksApi.accept(session.id,review!.sourceRevision,items));setSelected(new Set());
    })}>{tr('Add selected tasks')}</button>
    <button type="button" disabled={busy} onClick={()=>setSelected(new Set())}>{tr('Select none')}</button>
   </div>}
  </section>}
  <div className={styles.row}>
   <label>{tr('Task status filter')}<select value={status} onChange={event=>setStatus(event.target.value)}><option value="open">{tr('Open')}</option><option value="completed">{tr('Completed')}</option><option value="all">{tr('All tasks')}</option></select></label>
   <label>{tr('Task date filter')}<select value={dateFilter} onChange={event=>setDateFilter(event.target.value)}><option value="all">{tr('Any date')}</option><option value="dated">{tr('Dated')}</option><option value="undated">{tr('Undated')}</option></select></label>
  </div>
  {loaded&&tasks.length===0&&<p>{tr('No tasks match these filters.')}</p>}
  {tasks.map(task=><TaskCard key={task.id} task={task} busy={busy} onUpdate={saveTask} onDelete={task=>mutate(async()=>{await tasksApi.delete(task.id,task.revision);await loadAfterMutation();})} onSource={openSource}/>)}
  <p className={styles.meta}>{tr('Accepted tasks survive meeting deletion and audio expiration. Historical quotes stay with the task; unavailable sources are marked.')}</p>
 </section>;
}
