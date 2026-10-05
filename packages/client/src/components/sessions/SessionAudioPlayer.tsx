import {useState, useEffect, useRef, type RefObject} from 'react';
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
 const graph=useRef<AudioContext|null>(null);
 useEffect(()=>{setError(false);},[sessionId,available]);
 useEffect(()=>()=>{void graph.current?.close();graph.current=null;},[sessionId,available]);
 const playAudio = (audio:HTMLAudioElement) => {
  // O arquivo separa microfone/esquerda e sistema/direita para diarização.
  // Na reprodução, a mistura mono envia ambas as vozes aos dois lados do fone.
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
 if(!available)return <p className={styles.audioMessage}>Áudio indisponível nesta sessão. A transcrição continua disponível.</p>;
 return <div className={styles.audioPlayer}>
  <audio key={sessionId} ref={audioRef} controls preload="metadata" aria-label="Áudio da reunião"
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
  {error ? <p className={styles.audioMessage} role="status">Não foi possível carregar o áudio. Ele pode ter sido removido pelo limite de armazenamento.</p>
   : <p className={styles.audioMessage}>Clique em um trecho da transcrição para ouvir a partir dele.</p>}
 </div>;
}
