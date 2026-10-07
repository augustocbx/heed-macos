import {useEffect, useState} from 'react';
import type {RecordingSettings} from '@heed/shared';
import {apiClient} from '@/api/client';
import {useLocale} from '@/lib/i18n';
import styles from './PermissionsPage.module.css';

export function RealTimeTranscriptionSettings() {
 const {tr}=useLocale();
 const [settings,setSettings]=useState<RecordingSettings|null>(null);
 const [saving,setSaving]=useState(false),[saved,setSaved]=useState(false),[error,setError]=useState('');
 useEffect(()=>{
  let disposed=false;
  void apiClient.get<RecordingSettings>('/api/recording/settings').then(value=>{if(!disposed)setSettings(value);}).catch(()=>{if(!disposed)setError('Could not load real-time transcription settings. Reopen Settings and try again.');});
  return ()=>{disposed=true;};
 },[]);
 const save=async(enabled:boolean)=>{
  if(saving)return;
  setSaving(true);setSaved(false);setError('');
  try{setSettings(await apiClient.post<RecordingSettings>('/api/recording/settings',{enabled}));setSaved(true);}
  catch{setError('Could not save real-time transcription settings. Try again.');}
  finally{setSaving(false);}
 };
 return <article className={styles.card} aria-labelledby="real-time-transcription-title">
  <h2 id="real-time-transcription-title">{tr('Real-time transcription')}</h2>
  <label><input type="checkbox" checked={settings?.enabled ?? true} disabled={!settings || saving} onChange={event=>void save(event.target.checked)}/>{tr('Real-time transcription')}</label>
  <p>{tr('When disabled, microphone and system audio are still saved. The final transcript and speaker labels are prepared after stopping.')}</p>
  <p>{tr('Turning this off reduces processing during capture. RAM savings depend on shared model residency; final processing may still peak.')}</p>
  <p>{tr('Changes apply to the next recording. An active recording keeps its mode.')}</p>
  {saved && <p role="status">{tr('Saved. Changes apply to the next recording; the current recording keeps its mode.')}</p>}
  {settings?.engineState==='unavailable' && <p role="alert">{tr('Preference saved. The transcription service is unavailable; retry after it is ready.')}</p>}
  {error && <p role="alert" className={styles.error}>{tr(error)}</p>}
 </article>;
}
