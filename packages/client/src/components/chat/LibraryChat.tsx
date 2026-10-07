import {aiWaitingMessage} from '@/lib/ai-waiting';
import {useEffect,useRef,useState} from 'react';
import {tagKey,type LibraryChatScope,type LibraryChatContext,type ChatCommand,type LibraryChatTurn,type TranscriptEvidence} from '@heed/shared';
import {libraryChatApi} from '@/api/library-chat';
import {chatApi} from '@/api/chat';
import {ApiError} from '@/api/client';
import {useLocale} from '@/lib/i18n';
import {fmtDuration} from '@/lib/format';
import {useSessionsStore} from '@/stores/sessions';
import {useUIStore} from '@/stores/ui';
import {chatErrorMessages} from './chat-errors';
import styles from './MeetingChat.module.css';
import scopeStyles from './LibraryChat.module.css';
const emptyScope:LibraryChatScope={mode:'labels',labels:[],match:'any'};
function storedScope():LibraryChatScope{
 try{const scope=JSON.parse(localStorage.getItem('heed-library-chat-scope')||'null');if(scope&&['labels','all'].includes(scope.mode)&&['any','all'].includes(scope.match)&&Array.isArray(scope.labels)&&scope.labels.length<=50&&scope.labels.every((label:unknown)=>typeof label==='string'&&label.length<=200)&&(scope.mode!=='all'||!scope.labels.length))return scope;}catch{}return emptyScope;
}
const messages={...chatErrorMessages,'scope-changed':'The selected meetings or labels changed. Refresh the scope before asking.','scope-empty':'Choose labels or explicitly select All meetings before asking.'};
export function LibraryChat(){
 const {tr}=useLocale();const [scope,setScope]=useState<LibraryChatScope>(storedScope);const [context,setContext]=useState<LibraryChatContext|null>(null);
 const [search,setSearch]=useState('');const [question,setQuestion]=useState('');const [models,setModels]=useState<string[]>([]);const [model,setModel]=useState('');const [error,setError]=useState('');const [saving,setSaving]=useState(false);const [clearing,setClearing]=useState(false);
 const mounted=useRef(false),version=useRef(0),sequence=useRef(0);const pending=useRef<Extract<ChatCommand,{action:'send'}>|null>(null);
 const errorText=(reason:string)=>tr(messages[reason as keyof typeof messages]||'Could not load or update chat. Refresh and retry.');
 const changeScope=(next:LibraryChatScope)=>{++version.current;++sequence.current;pending.current=null;setContext(null);setQuestion('');setError('');setClearing(false);setScope(next);};
 useEffect(()=>{mounted.current=true;let disposed=false;void chatApi.models().then(result=>{if(!disposed)setModels(result.models);}).catch(error=>{if(!disposed)setError(error.message);});return()=>{disposed=true;mounted.current=false;++version.current;};},[]);
 useEffect(()=>{
  const generation=++version.current;setContext(null);pending.current=null;try{localStorage.setItem('heed-library-chat-scope',JSON.stringify(scope));}catch{}
  let disposed=false;const refresh=async()=>{const request=++sequence.current,current=version.current;try{const result=await libraryChatApi.context(scope);if(!disposed&&current===version.current&&request===sequence.current)setContext(result);}catch(error){if(!disposed&&current===version.current&&request===sequence.current)setError(error instanceof Error?error.message:'chat-storage-failed');}};
  void refresh();const interval=window.setInterval(()=>void refresh(),2000);
  return()=>{disposed=true;window.clearInterval(interval);if(version.current===generation)++version.current;};
 },[scope]);
 const refresh=async()=>{const current=++version.current,request=++sequence.current;setError('');try{const [result,installed]=await Promise.all([libraryChatApi.context(scope),chatApi.models()]);if(mounted.current&&version.current===current&&request===sequence.current){setContext(result);setModels(installed.models);}}catch(error){if(mounted.current&&version.current===current)setError(error instanceof Error?error.message:'chat-storage-failed');}};
 const mutate=async(command:ChatCommand)=>{const current=++version.current;setSaving(true);setError('');try{const thread=await libraryChatApi.command(scope,command);if(mounted.current&&version.current===current){++sequence.current;setContext(previous=>previous?{...previous,thread}:null);return true;}}catch(error){if(mounted.current&&version.current===current){setError(error instanceof Error?error.message:'chat-storage-failed');if(error instanceof ApiError&&error.status===409)pending.current=null;}}finally{if(mounted.current&&version.current===current)setSaving(false);}return false;};
 const send=async()=>{if(!context?.preview.ready||!question.trim()||!models.includes(model)||saving)return;if(!pending.current||pending.current.question!==question.trim()||pending.current.model!==model)pending.current={action:'send',requestId:crypto.randomUUID(),question:question.trim(),model,expectedSourceRevision:context.preview.snapshot.key,expectedThreadRevision:context.thread.revision};if(await mutate(pending.current)){pending.current=null;setQuestion('');}};
 const openCitation=async(turn:LibraryChatTurn,citation:TranscriptEvidence)=>{
  const current=++version.current;setSaving(true);setError('');try{const session=await libraryChatApi.source(scope,turn.snapshot.key,citation.id);if(mounted.current&&current===version.current){if(session.id!==citation.sessionId||session.transcriptRevision!==citation.sourceRevision)throw new Error('scope-changed');useSessionsStore.getState().view(session);useUIStore.setState({currentPage:'sessions',chatSourceFocus:citation,taskSourceSeek:null});}}catch(error){if(mounted.current&&current===version.current)setError(error instanceof Error?error.message:'chat-storage-failed');}finally{if(mounted.current&&current===version.current)setSaving(false);}
 };
 const labels=context?.preview.availableLabels||[];const running=context?.thread.turns.some(turn=>turn.status==='running'||turn.status==='waiting');
 return <section className={styles.chat} aria-label={tr('Meeting chat')}>
  <h1>{tr('Meeting chat')}</h1><p className={styles.hint}>{tr('Answers use the saved final transcript and stay on this Mac. Check cited evidence before relying on an answer.')}</p>
  <fieldset className={scopeStyles.scope}><legend>{tr('Meeting scope')}</legend>
   <label><input type="radio" name="meeting-scope" checked={scope.mode==='labels'} disabled={saving} onChange={()=>changeScope({...emptyScope})}/>{tr('Selected labels')}</label>
   <label><input type="radio" name="meeting-scope" checked={scope.mode==='all'} disabled={saving} onChange={()=>changeScope({mode:'all',labels:[],match:'any'})}/>{tr('All meetings')}</label>
   {scope.mode==='labels'&&<><label>{tr('Search labels')}<input type="search" value={search} onChange={event=>setSearch(event.target.value)}/></label><div className={scopeStyles.labels}>{labels.filter(label=>tagKey(label).includes(tagKey(search))).map(label=><button key={tagKey(label)} aria-pressed={scope.labels.some(selected=>tagKey(selected)===tagKey(label))} disabled={saving} onClick={()=>changeScope({...scope,labels:scope.labels.some(selected=>tagKey(selected)===tagKey(label))?scope.labels.filter(selected=>tagKey(selected)!==tagKey(label)):[...scope.labels,label]})}>{label}</button>)}</div>
   <label>{tr('Combine selected labels')}<select value={scope.match} disabled={saving} onChange={event=>changeScope({...scope,match:event.target.value as 'any'|'all'})}><option value="any">{tr('Match any selected label')}</option><option value="all">{tr('Match all selected labels')}</option></select></label><p>{scope.labels.length?scope.labels.join(' · '):tr('Choose labels or explicitly select All meetings before asking.')}</p></>}
  </fieldset>
  {context&&<div className={scopeStyles.preview}><strong>{tr(context.preview.snapshot.sources.length===1?'1 eligible meeting':'{count} eligible meetings',{count:context.preview.snapshot.sources.length})}</strong><p className={styles.hint}>{tr('{count} matching meetings; {unavailable} need a final transcript.',{count:context.preview.matchingCount,unavailable:context.preview.unavailableCount})}</p>
   <details><summary>{tr('Inspect included meetings')}</summary><ul>{context.preview.snapshot.sources.map(source=><li key={source.sessionId}>{source.title||tr('Untitled')} <small>{source.tags.join(' · ')}</small></li>)}</ul></details>
   {!context.preview.ready&&scope.mode==='all'&&<p role="status">{tr('No eligible final transcripts in this scope. No broader search was performed.')}</p>}
   {!context.preview.ready&&scope.mode==='labels'&&scope.labels.length>0&&<p role="status">{tr('No eligible final transcripts in this scope. No broader search was performed.')}</p>}
  </div>}
  {error&&<p role="alert" className={styles.error}>{errorText(error)}</p>}
  <div className={styles.controls}><label>{tr('Local chat model')}<select aria-label={tr('Local chat model')} value={model} onChange={event=>setModel(event.target.value)} disabled={saving}><option value="">{tr('Choose an installed chat model')}</option>{models.map(name=><option key={name} value={name}>{name}</option>)}</select></label><button onClick={()=>void refresh()} disabled={saving}>{tr('Refresh chat')}</button><button onClick={()=>setClearing(true)} disabled={saving||!context?.thread.turns.length}>{tr('Clear chat history')}</button></div>
  {!models.length&&<p>{tr('No installed compatible chat models are available.')}</p>}
  {clearing&&<div className={styles.confirm} role="dialog" aria-label={tr('Clear chat history?')}><p>{tr('Clear chat history? Saved questions and answers will be removed.')}</p><button disabled={saving} onClick={async()=>{if(context&&await mutate({action:'clear',expectedThreadRevision:context.thread.revision})){pending.current=null;setClearing(false);}}}>{tr('Clear history')}</button><button onClick={()=>setClearing(false)}>{tr('Keep history')}</button></div>}
  <div className={styles.history} aria-live="polite">{context?.thread.turns.map(turn=><article className={styles.turn} key={turn.id}><p className={styles.question}>{turn.question}</p><small>{turn.model} · {turn.snapshot.sources.length} {tr('Meetings')}</small>
   {turn.stale&&<p className={styles.warning}>{tr('Historical answer: labels, meetings or transcripts changed.')}</p>}
   <details><summary>{tr('Sources when this question was asked')}</summary><ul>{turn.snapshot.sources.map(source=><li key={source.sessionId}>{source.title} · {source.tags.join(' · ')}</li>)}</ul></details>
   {(turn.status==='running'||turn.status==='waiting')&&<div><p role="status">{tr(turn.status==='waiting'?aiWaitingMessage(turn.waitingReason):'Reviewing transcript evidence…')}</p><button disabled={saving} onClick={()=>void mutate({action:'cancel',turnId:turn.id})}>{tr('Cancel answer')}</button></div>}
   {(turn.status==='failed'||turn.status==='cancelled')&&<div><p role="status">{errorText(turn.reason||'interrupted')}</p><button disabled={saving||turn.stale} onClick={()=>void mutate({action:'retry',turnId:turn.id,...(model?{model}:{})})}>{tr('Retry answer')}</button></div>}
   {turn.status==='completed'&&turn.answer&&<div>{!turn.answer.claims.length&&<p>{tr(turn.answer.coverage.complete?'Not found in the selected meetings.':'No supporting evidence found in the reviewed excerpts.')}</p>}
    {turn.answer.claims.map((claim,index)=><div className={styles.claim} key={index}><p>{claim.text}</p><div className={styles.citations}>{claim.citations.map(citation=><details key={citation.id}><summary>{turn.snapshot.sources.find(source=>source.sessionId===citation.sessionId)?.title} · {citation.speaker||tr('Transcript')}</summary><blockquote>{citation.quote}</blockquote><button disabled={saving||turn.stale} onClick={()=>void openCitation(turn,citation)}>{turn.snapshot.sources.find(source=>source.sessionId===citation.sessionId)?.title} · {citation.start===null?tr('Open source text'):fmtDuration(Math.floor(citation.start))}</button></details>)}</div></div>)}
    <p className={styles.hint}>{tr('Reviewed {reviewed} of {total} transcript chunks.',{reviewed:turn.answer.coverage.reviewedChunks,total:turn.answer.coverage.totalChunks})}</p>{!turn.answer.coverage.complete&&<p className={styles.warning}>{tr('Coverage is partial. Evidence was sampled across the selected meetings; missing topics may exist in unreviewed excerpts.')}</p>}{turn.answer.coverage.answerLimited&&<p className={styles.warning}>{tr('The displayed answer was limited to 40 supported statements. Ask a narrower question.')}</p>}
   </div>}
  </article>)}</div>
  <form onSubmit={event=>{event.preventDefault();void send();}}><label htmlFor="library-question">{tr('Question across selected meetings')}</label><textarea id="library-question" value={question} maxLength={2000} rows={3} disabled={saving} onChange={event=>setQuestion(event.target.value)}/><button type="submit" disabled={!context?.preview.ready||!question.trim()||!models.includes(model)||saving||running}>{tr('Send question')}</button></form>
 </section>;
}
