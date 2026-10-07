import {useEffect, useState} from 'react';
import type {RecordingSettings, LiveSpeechLanguage} from '@heed/shared';
import {apiClient} from '@/api/client';
import {useLocale} from '@/lib/i18n';
import styles from './PermissionsPage.module.css';

export function LiveSpeechLanguageSettings() {
 const {tr}=useLocale();
 const [settings,setSettings]=useState<RecordingSettings|null>(null);
 const [saving,setSaving]=useState(false),[saved,setSaved]=useState(false),[error,setError]=useState('');
 useEffect(()=>{
  let disposed=false;
  void apiClient.get<RecordingSettings>('/api/recording/settings').then(value=>{if(!disposed)setSettings(value);}).catch(()=>{if(!disposed)setError('Could not load live speech language. Reopen Settings and try again.');});
  return ()=>{disposed=true;};
 },[]);
 const save=async(liveLanguage:LiveSpeechLanguage)=>{
  if(saving)return;
  setSaving(true);setSaved(false);setError('');
  try{setSettings(await apiClient.post<RecordingSettings>('/api/recording/settings',{liveLanguage}));setSaved(true);}
  catch{setError('Could not save live speech language. Try again.');}
  finally{setSaving(false);}
 };
 const capabilities=settings?.languageCapabilities;
 return <article className={styles.card} aria-labelledby="live-speech-language-title">
  <h2 id="live-speech-language-title">{tr('Live speech language')}</h2>
  <label>{tr('Live speech language')} <select disabled={!settings || saving} value={settings?.liveLanguage || 'en'} onChange={event=>void save(event.target.value as LiveSpeechLanguage)}>
   <option value="en">{tr('English')}</option><option value="pt">{tr('Brazilian Portuguese')}</option>
  </select></label>
  <p>{tr('This changes live speech recognition, independently of the interface language. It does not turn real-time transcription on.')}</p>
  {capabilities && <>
   <p>{tr('Live engine: {engine} • model: {model}',{engine:capabilities.live.engine || tr("Unknown"),model:capabilities.live.model || tr("Unknown")})}</p>
   <p>{tr('Final engine: {engine} • model: {model}',{engine:capabilities.final.engine || tr("Unknown"),model:capabilities.final.model || tr("Unknown")})}</p>
   {capabilities.live.model?.endsWith('.en') && <p>{tr('English-only models (.en) cannot preview Portuguese.')}</p>}
  </>}
  <p>{tr('The final transcript automatically detects English or Portuguese. Mixed-language accuracy has not been verified.')}</p>
  {settings?.activeLiveLanguage && <p>{tr('Active recording: {language}. Changes apply to the next recording.',{language:tr(settings.activeLiveLanguage==='pt'?'Brazilian Portuguese':'English')})}</p>}
  {saved && <p role="status">{tr('Saved. Live speech language applies to the next recording.')}</p>}
  {settings?.liveLanguageState==='unsupported' && <p role="alert">{tr('The live model does not support this language. Choose a compatible model or record final-only.')}</p>}
  {settings?.liveLanguageState==='unavailable' && <p role="alert">{tr('Live language capabilities are unavailable. Retry when the service is ready or record final-only.')}</p>}
  {error && <p role="alert" className={styles.error}>{tr(error)}</p>}
 </article>;
}
