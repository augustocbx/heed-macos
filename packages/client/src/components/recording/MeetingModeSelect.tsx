import {useEffect,useState} from 'react';
import type {MeetingMode,RecordingSettings} from '@heed/shared';
import {apiClient} from '@/api/client';
import {useRecordingStore} from '@/stores/recording';
import {useLocale} from '@/lib/i18n';

export function MeetingModeSelect(){
 const {tr}=useLocale();const activeMode=useRecordingStore(state=>state.meetingMode),state=useRecordingStore(state=>state.coordinatorState);
 const active=['starting','recording','stopping','finalizing','failed'].includes(state);
 const [mode,setMode]=useState<MeetingMode|null>(null),[confirm,setConfirm]=useState(false),[saving,setSaving]=useState(false),[error,setError]=useState('');
 useEffect(()=>{let disposed=false;void apiClient.get<RecordingSettings>('/api/recording/settings').then(settings=>{if(!disposed)setMode(settings.meetingMode ?? 'audio-transcript');}).catch(()=>{if(!disposed)setError('Could not load meeting mode. Retry when the service is ready.');});return()=>{disposed=true;};},[state]);
 const save=async(next:MeetingMode)=>{setSaving(true);setError('');try{const settings=await apiClient.post<RecordingSettings>('/api/recording/settings',{meetingMode:next,...(next==='transcript-only'?{acknowledgeTemporaryAudio:true}:{})});setMode(settings.meetingMode ?? next);setConfirm(false);}catch{setError('Could not save meeting mode. Try again.');}finally{setSaving(false);}};
 return <div>
  <label>{tr('Meeting mode')} <select aria-label={tr('Meeting mode')} value={active?activeMode:mode ?? 'audio-transcript'} disabled={active||saving||mode===null} onChange={event=>{if(event.target.value==='transcript-only')setConfirm(true);else void save('audio-transcript');}}>
   <option value="audio-transcript">{tr('Audio + transcript')}</option><option value="transcript-only">{tr('Transcript only')}</option>
  </select></label>
  {(confirm||(active?activeMode:mode)==='transcript-only')&&<p>{tr('Transcript only uses temporary local audio during capture and final processing. After the final transcript is saved, audio is deleted. Playback and retranscription are unavailable.')}</p>}
  {confirm&&!active&&<div><button type="button" disabled={saving} onClick={()=>void save('transcript-only')}>{tr('Enable transcript only')}</button><button type="button" disabled={saving} onClick={()=>setConfirm(false)}>{tr('Cancel')}</button></div>}
  <p>{tr('Changes apply to the next recording. An active recording keeps its mode.')}</p>
  {error&&<p role="alert">{tr(error)}</p>}
 </div>;
}
