import {useState, useEffect, type RefObject} from 'react';
import styles from './SessionDetail.module.css';

interface Props {
 sessionId:string;
 available:boolean;
 audioRef:RefObject<HTMLAudioElement|null>;
 onTime:(seconds:number|null)=>void;
 onDuration:(seconds:number)=>void;
}

export function SessionAudioPlayer({sessionId,available,audioRef,onTime,onDuration}:Props) {
 const [error,setError]=useState(false);
 useEffect(()=>{setError(false);},[sessionId,available]);
 if(!available)return <p className={styles.audioMessage}>Áudio indisponível nesta sessão. A transcrição continua disponível.</p>;
 return <div className={styles.audioPlayer}>
  <audio key={sessionId} ref={audioRef} controls preload="metadata" aria-label="Áudio da reunião"
   src={`/api/sessions/${encodeURIComponent(sessionId)}/audio`}
   onTimeUpdate={event=>onTime(event.currentTarget.currentTime)}
   onSeeked={event=>onTime(event.currentTarget.currentTime)}
   onPlay={event=>onTime(event.currentTarget.currentTime)}
   onLoadedMetadata={event=>{
    const duration=event.currentTarget.duration;
    if(Number.isFinite(duration)&&duration>0)onDuration(duration);
   }}
   onError={()=>{setError(true);onTime(null);}}
  />
  {error ? <p className={styles.audioMessage} role="status">Não foi possível carregar o áudio. Ele pode ter sido removido pelo limite de armazenamento.</p>
   : <p className={styles.audioMessage}>Clique em um trecho da transcrição para ouvir a partir dele.</p>}
 </div>;
}
