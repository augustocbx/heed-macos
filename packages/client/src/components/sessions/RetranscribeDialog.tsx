import { tr, useLocale } from "@/lib/i18n.ts";
import { useEffect, useRef, useState } from 'react';
import type { Session } from '@heed/shared';
import { useSessionsStore } from '@/stores/sessions';
import { useRecordingStore } from '@/stores/recording';
import { useUIStore } from '@/stores/ui';
import { retranscribeSession, type FinalTranscriptionModel, type MeetingLanguage } from '@/lib/sessionTranscription';
import styles from './RetranscribeDialog.module.css';

export function RetranscribeDialog({session,onClose,onBusy}:{session:Session;onClose:()=>void;onBusy:(busy:boolean)=>void}) {
	useLocale();
 const [model,setModel]=useState<FinalTranscriptionModel>('parakeet-v3');
 const [language,setLanguage]=useState<MeetingLanguage>('auto');
 const [busy,setBusy]=useState(false);
 const [step,setStep]=useState('');
 const [progress,setProgress]=useState<number|null>(null);
 const [error,setError]=useState('');
 const dialogRef=useRef<HTMLElement>(null);
 const selectRef=useRef<HTMLSelectElement>(null);
 useEffect(()=>{selectRef.current?.focus();},[]);
 const start = async () => {
  const state=useRecordingStore.getState();
  if (busy || state.recording || state.processing) {setError(tr("Wait for the current recording or transcription to finish."));return;}
  setBusy(true);onBusy(true);setError('');setStep(tr("Preparing transcription…"));
  useRecordingStore.setState({processing:true});
  try {
   await retranscribeSession(session,model,language,{onStep:setStep,onProgress:setProgress},useSessionsStore.getState().update);
   useUIStore.getState().showToast(tr("Transcript updated"));onClose();
  } catch (e) {setError((e as Error).message);}
  finally {useRecordingStore.setState({processing:false});setBusy(false);onBusy(false);}
 };
 return <div className={styles.overlay}>
  <section ref={dialogRef} className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="retranscribe-heading"
   onKeyDown={event=>{
    if(event.key==='Escape'&&!busy)onClose();
    if(event.key==='Tab') {
     const items=dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), select:not(:disabled)');
     if(!items?.length) {event.preventDefault();return;}
     const first=items[0],last=items[items.length-1];
     if(event.shiftKey&&document.activeElement===first) {event.preventDefault();last.focus();}
     else if(!event.shiftKey&&document.activeElement===last) {event.preventDefault();first.focus();}
    }
   }}>
   <h2 id="retranscribe-heading">{tr("Transcribe saved audio")}</h2>
   <p>{tr("The complete recording will be transcribed again. Your existing transcript stays available until the new transcript is saved.")}</p>
   <label>{tr("Transcription model")}<select ref={selectRef} value={model} disabled={busy} onChange={e=>setModel(e.target.value as FinalTranscriptionModel)}>
     <option value="parakeet-v3">{tr("Parakeet v3 · native and fast")}</option>
     <option value="base">{tr("Whisper base · lighter")}</option><option value="small">{tr("Whisper small")}</option>
     <option value="medium">{tr("Whisper medium")}</option><option value="large-v3">{tr("Whisper large-v3 · highest Whisper accuracy")}</option>
    </select>
   </label>
   <label>{tr("Meeting language")}<select value={language} disabled={busy} onChange={e=>setLanguage(e.target.value as MeetingLanguage)}>
     <option value={tr("auto")}>{tr("Detect English or Portuguese")}</option><option value="en">{tr("English")}</option><option value="pt">{tr("Portuguese (Brazil)")}</option>
    </select>
   </label>
   <p className={styles.hint}>{tr("Models may need to download on first use. Larger models use more memory and take longer.")}</p>
   {busy&&<div role="status"><p>{tr(step)}</p>{progress!==null&&<progress max="100" value={progress} aria-label={tr("Transcription progress")}/>}</div>}
   {error&&<p role="alert" className={styles.error}>{tr(error)}</p>}
   <div className={styles.actions}><button disabled={busy} onClick={onClose}>{tr("Cancel")}</button>
    <button disabled={busy} onClick={()=>void start()}>{busy?'Transcribing…':tr("Start transcription")}</button></div>
  </section>
 </div>;
}
