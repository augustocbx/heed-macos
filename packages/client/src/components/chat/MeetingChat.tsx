import { aiWaitingMessage } from "@/lib/ai-waiting";
import {chatErrorMessages} from "./chat-errors";
import { useEffect, useRef, useState } from "react";
import type { ChatCommand, ChatThread, Session, TranscriptEvidence } from "@heed/shared";
import { ApiError } from "@/api/client";
import { chatApi } from "@/api/chat";
import { useLocale } from "@/lib/i18n";
import { fmtDuration } from "@/lib/format";
import styles from "./MeetingChat.module.css";

const errorReason=(value:unknown)=>value instanceof Error ? value.message : String(value);

interface Props {session:Session;onCitation:(citation:TranscriptEvidence)=>void;}
export function MeetingChat({session,onCitation}:Props) {
 const {tr}=useLocale();
 const [thread,setThread]=useState<ChatThread|null>(null);
 const [models,setModels]=useState<string[]>([]);const [model,setModel]=useState("");
 const [question,setQuestion]=useState("");const [error,setError]=useState("");const [saving,setSaving]=useState(false);
 const [clearing,setClearing]=useState(false);
 const mounted=useRef(false);const version=useRef(0);const sequence=useRef(0);
 const pending=useRef<Extract<ChatCommand,{action:"send"}>|null>(null);
 const errorText=(value:unknown)=>tr(chatErrorMessages[value instanceof Error ? value.message : String(value)]||"Could not load or update chat. Refresh and retry.");
 useEffect(()=>{
  mounted.current=true;setThread(null);setError("");setQuestion("");pending.current=null;setModel("");setModels([]);
  const id=session.id;let disposed=false;const generation=++version.current;
  const refresh=async()=>{
   const request=++sequence.current;const requestVersion=version.current;
   try{const saved=await chatApi.get(id);if(!disposed&&request===sequence.current&&requestVersion===version.current){setThread(saved);}}
   catch(e){if(!disposed&&request===sequence.current&&requestVersion===version.current)setError(errorReason(e));}
  };
  void refresh();
  void chatApi.models().then(result=>{if(!disposed&&generation===version.current)setModels(result.models);}).catch(e=>{if(!disposed)setError(errorReason(e));});
  const interval=window.setInterval(()=>void refresh(),2000);
  return()=>{disposed=true;mounted.current=false;window.clearInterval(interval);++version.current;};
 },[session.id]);
 const mutate=async(command:ChatCommand)=>{
  const current=++version.current;setSaving(true);setError("");
  try {const saved=await chatApi.command(session.id,command);if(mounted.current&&current===version.current){++sequence.current;setThread(saved);return true;}}
  catch(e){if(mounted.current&&current===version.current){setError(errorReason(e));if(e instanceof ApiError&&e.status===409)pending.current=null;}}
  finally{if(mounted.current&&current===version.current)setSaving(false);}
  return false;
 };
 const refreshChat=async()=>{
  const current=++version.current;setError("");
  try{const [saved,installed]=await Promise.all([chatApi.get(session.id),chatApi.models()]);if(mounted.current&&current===version.current){setThread(saved);setModels(installed.models);}}catch(e){if(mounted.current&&current===version.current)setError(errorReason(e));}
 };
 const send=async()=>{
  if(!thread||!question.trim()||!model||saving)return;
  if(!pending.current||pending.current.question!==question.trim()||pending.current.model!==model)pending.current={action:"send",requestId:crypto.randomUUID(),question:question.trim(),model,expectedSourceRevision:session.transcriptRevision||"",expectedThreadRevision:thread.revision};
  if(await mutate(pending.current)){pending.current=null;setQuestion("");}
 };
 const running=thread?.turns.some(turn=>turn.status==="running"||turn.status==="waiting");
 return <section className={styles.chat} aria-label={tr("Meeting chat")}>
  <p className={styles.scope}>{tr("Chat scope: this meeting only.")} <strong>{session.title}</strong></p>
  <p className={styles.hint}>{tr("Answers use the saved final transcript and stay on this Mac. Check cited evidence before relying on an answer.")}</p>
  {!session.transcriptFinalized&&<p role="status">{tr("Chat becomes available after the final transcript is saved.")}</p>}
  {error&&<p role="alert" className={styles.error}>{errorText(error)}</p>}
  <div className={styles.controls}>
   <label>{tr("Local chat model")}<select aria-label={tr("Local chat model")} value={model} onChange={event=>setModel(event.target.value)} disabled={saving}>
    <option value="">{tr("Choose an installed chat model")}</option>{models.map(name=><option key={name} value={name}>{name}</option>)}
   </select></label>
   <button onClick={()=>void refreshChat()} disabled={saving}>{tr("Refresh chat")}</button>
   <button onClick={()=>setClearing(true)} disabled={saving||!thread?.turns.length}>{tr("Clear chat history")}</button>
  </div>
  {!models.length&&<p>{tr("No installed compatible chat models are available.")}</p>}
  {clearing&&<div className={styles.confirm} role="dialog" aria-label={tr("Clear chat history?")}>
   <p>{tr("Clear chat history? Saved questions and answers will be removed.")}</p>
   <button onClick={async()=>{if(thread&&await mutate({action:"clear",expectedThreadRevision:thread.revision})){setClearing(false);pending.current=null;}}} disabled={saving}>{tr("Clear history")}</button>
   <button onClick={()=>setClearing(false)}>{tr("Keep history")}</button>
  </div>}
  <div className={styles.history} aria-live="polite">
   {thread?.turns.map(turn=><article key={turn.id} className={styles.turn}>
    <p className={styles.question}>{turn.question}</p><small>{turn.model}</small>
    {(turn.stale||turn.sourceRevision!==session.transcriptRevision)&&<p className={styles.warning}>{tr("This answer uses an older transcript revision. Its evidence is retained below.")}</p>}
    {(turn.status==="waiting"||turn.status==="running")&&<div><p role="status">{tr(turn.status==="waiting" ? aiWaitingMessage(turn.waitingReason) : "Reviewing transcript evidence…")}</p><button onClick={()=>void mutate({action:"cancel",turnId:turn.id})} disabled={saving}>{tr("Cancel answer")}</button></div>}
    {(turn.status==="failed"||turn.status==="cancelled")&&<div><p role="status">{turn.status==="cancelled"&&!turn.reason ? tr("Answer cancelled.") : errorText(turn.reason||"interrupted")}</p><button onClick={()=>void mutate({action:"retry",turnId:turn.id,...(model ? {model} : {})})} disabled={saving}>{tr("Retry answer")}</button></div>}
    {turn.status==="completed"&&turn.answer&&<div>
     {!turn.answer.claims.length&&<p>{tr(turn.answer.coverage.complete ? "Not found in this meeting." : "No supporting evidence found in the reviewed excerpts.")}</p>}
     {turn.answer.claims.map((claim,index)=><div key={index} className={styles.claim}><p>{claim.text}</p><div className={styles.citations}>{claim.citations.map(citation=><details key={citation.id}>
      <summary>{tr("Transcript evidence")} · {citation.speaker||tr("Transcript")}</summary>
      <blockquote>{citation.quote}</blockquote>
      <button disabled={turn.stale||citation.sourceRevision!==session.transcriptRevision} onClick={()=>onCitation(citation)}>{citation.speaker||tr("Transcript")} · {citation.start===null ? tr("Open source text") : fmtDuration(Math.floor(citation.start))}</button>
     </details>)}</div></div>)}
     <p className={styles.hint}>{tr("Reviewed {reviewed} of {total} transcript chunks.",{reviewed:turn.answer.coverage.reviewedChunks,total:turn.answer.coverage.totalChunks})}</p>
     {!turn.answer.coverage.complete&&<p className={styles.warning}>{tr("Coverage is partial. Evidence was sampled across the recording; missing topics may exist in unreviewed excerpts.")}</p>}
     {turn.answer.coverage.answerLimited&&<p className={styles.warning}>{tr("The displayed answer was limited to 40 supported statements. Ask a narrower question.")}</p>}
    </div>}
   </article>)}
  </div>
  <form onSubmit={event=>{event.preventDefault();void send();}}>
   <label htmlFor={`question-${session.id}`}>{tr("Question about this meeting")}</label>
   <textarea id={`question-${session.id}`} value={question} maxLength={2000} onChange={event=>setQuestion(event.target.value)} rows={3} disabled={saving}/>
   <button type="submit" disabled={!thread||!question.trim()||!models.includes(model)||!session.transcriptFinalized||saving||running}>{tr("Send question")}</button>
  </form>
 </section>;
}
