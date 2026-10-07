import {libraryApi} from '@/api/library';
import { tr, useLocale } from "@/lib/i18n.ts";
import {useState, useEffect, useRef, type RefObject} from 'react';
import styles from './SessionDetail.module.css';

interface Props {
 sessionId:string;
 available:boolean;
 archived?:boolean;
 unavailableReason?:"transcript-only";
 cleanupPending?:boolean;
 audioRef:RefObject<HTMLAudioElement|null>;
 onTime:(seconds:number|null)=>void;
 onDuration:(seconds:number)=>void;
}

export function SessionAudioPlayer({sessionId,available,archived,unavailableReason,cleanupPending,audioRef,onTime,onDuration}:Props) {
	useLocale();
 const [error,setError]=useState(false);
 const [downloaded,setDownloaded]=useState(false),[downloading,setDownloading]=useState(false),[downloadError,setDownloadError]=useState('');
 useEffect(()=>{setDownloaded(false);setDownloadError('');},[sessionId]);
 const graph=useRef<AudioContext|null>(null);
 useEffect(()=>{setError(false);},[sessionId,available]);
 useEffect(()=>()=>{void graph.current?.close();graph.current=null;},[sessionId,available]);
 const playAudio = (audio:HTMLAudioElement) => {
  // The recording separates microphone/left and system/right for diarization.
  // During playback, the mono mix sends both voices to both headphone channels.
  if(!graph.current && typeof AudioContext!=='undefined') {
   const context=new AudioContext();
   try {
    const mix=context.createGain();mix.channelCount=1;
    mix.channelCountMode='explicit';mix.channelInterpretation='speakers';
    context.createMediaElementSource(audio).connect(mix);mix.connect(context.destination);
    graph.current=context;
   } catch {void context.close();}
  }
  void graph.current?.resume().catch(()=>setError(true));
  onTime(audio.currentTime);
 };
 if(unavailableReason === "transcript-only")return <div><p className={styles.audioMessage}>{tr("Transcript-only meeting. Playback and retranscription are unavailable.")}</p>{cleanupPending&&<p role="status">{tr("Temporary audio cleanup is pending. Open recording recovery to retry cleanup.")}</p>}</div>;
 if(!available&&!downloaded&&archived)return <div><button disabled={downloading} onClick={()=>{setDownloading(true);setDownloadError('');void libraryApi.audio(sessionId).then(()=>setDownloaded(true)).catch(error=>setDownloadError(/quota|reservation/i.test(String(error))?'Increase the storage limit or select fewer meetings. Retained transcripts are preserved.':'Archived audio is unavailable. The transcript remains available.')).finally(()=>setDownloading(false));}}>{tr(downloading?'Downloading audio…':'Download archived audio')}</button>{downloadError&&<p role="alert">{tr(downloadError)}</p>}</div>;
 if(!available&&!downloaded)return <p className={styles.audioMessage}>{tr("Audio is unavailable for this meeting. The transcript remains available.")}</p>;
 return <div className={styles.audioPlayer}>
  <audio key={sessionId} ref={audioRef} controls preload="metadata" aria-label={tr("Meeting audio")}
   src={`/api/sessions/${encodeURIComponent(sessionId)}/audio`}
   onTimeUpdate={event=>onTime(event.currentTarget.currentTime)}
   onSeeked={event=>onTime(event.currentTarget.currentTime)}
   onPlay={event=>playAudio(event.currentTarget)}
   onLoadedMetadata={event=>{
    const duration=event.currentTarget.duration;
    if(Number.isFinite(duration)&&duration>0)onDuration(duration);
   }}
   onError={()=>{setError(true);onTime(null);}}
  />
  {error ? <p className={styles.audioMessage} role="status">{tr("Could not load audio. It may have been removed by the storage limit.")}</p>
   : <p className={styles.audioMessage}>{tr("Click a transcript segment to play from that point.")}</p>}
 </div>;
}
