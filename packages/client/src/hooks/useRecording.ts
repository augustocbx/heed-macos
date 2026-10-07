import { useEffect, useRef, useState } from "react";
import { ApiError } from "@/api/client";
import { recordingApi } from "@/api/recording";
import { applyRecordingSnapshot } from "@/lib/recordingSnapshot";
import { useRecordingStore } from "@/stores/recording";
import { useSessionsStore } from "@/stores/sessions";
import { useUIStore } from "@/stores/ui";
import { tr } from "@/lib/i18n";

interface UseRecordingOptions {
  micBars: React.RefObject<HTMLDivElement[] | null>;
  systemBars: React.RefObject<HTMLDivElement[] | null>;
}

/** Commands the backend; browser lifetimes affect visualization subscriptions only. */
export function useRecording({micBars,systemBars}:UseRecordingOptions) {
  const [liveStartError,setLiveStartError]=useState<string|null>(null);
  const [starting,setStarting]=useState(false);
  const recording=useRecordingStore(s=>s.recording);
  const levels=useRef<number[]>(new Array(24).fill(0));
  const meters=useRef<HTMLDivElement[]>([]);
  meters.current=systemBars.current || [];
  useEffect(()=>{
    if(!recording)return;
    const live=new EventSource("/api/sysrecord/live");
    const source=new EventSource("/api/sysrecord/levels");
    const onSnapshot=(event:Event)=>{
      try {applyRecordingSnapshot(JSON.parse((event as MessageEvent).data));} catch { /* Reconnect and status polling restore authoritative state. */ }
    };
    live.addEventListener?.("snapshot",onSnapshot);
    live.addEventListener?.("quality",event=>{
      try {useRecordingStore.getState().setLiveQuality(JSON.parse((event as MessageEvent).data));}catch { /* Ignore malformed hints. */ }
    });
    source.onmessage=event=>{try {levels.current=JSON.parse(event.data);}catch{}};
    const visualizer=window.setInterval(()=>{
      meters.current.forEach((bar,index)=>{if(bar)bar.style.height=`${Math.max(2,(levels.current[index] || 0)/3.5)}px`;});
    },50);
    // Browser microphone permission is optional; it never blocks native commands.
    let disposed=false;
    let stream:MediaStream|undefined;
    let context:AudioContext|undefined;
    let frame:number|undefined;
    void(async()=>{
      try {
        const candidate=await navigator.mediaDevices.getUserMedia({audio:true});
        if(disposed){candidate.getTracks().forEach(track=>track.stop());return;}
        stream=candidate;context=new AudioContext();const analyser=context.createAnalyser();analyser.fftSize=64;
        context.createMediaStreamSource(candidate).connect(analyser);
        const animate=()=>{if(disposed)return;const values=new Uint8Array(analyser.frequencyBinCount);analyser.getByteFrequencyData(values);
          micBars.current?.forEach((bar,index)=>{if(bar)bar.style.height=`${Math.max(2,(values[index] || 0)/3.5)}px`;});frame=requestAnimationFrame(animate);};animate();
      } catch { /* Native microphone capture does not depend on the browser meter. */ }
    })();
    return()=>{disposed=true;live.close();source.close();window.clearInterval(visualizer);stream?.getTracks().forEach(track=>track.stop());void context?.close();if(frame!==undefined)cancelAnimationFrame(frame);
      micBars.current?.forEach(bar=>{if(bar)bar.style.height="2px";});meters.current.forEach(bar=>{if(bar)bar.style.height="2px";});};
  },[recording,micBars]);

  const begin=async(finalOnly:boolean)=>{
    if(starting)return false;
    setStarting(true);setLiveStartError(null);
    try {
      const data=await (finalOnly?recordingApi.recordFinalOnly("both",crypto.randomUUID()):recordingApi.start("both",crypto.randomUUID()));
      if(finalOnly)useUIStore.getState().showToast(tr("Real-time transcription is now off for future recordings. Change it in Settings to turn it on again."));
      if(data.permissionNeeded){useUIStore.getState().showToast(tr("Allow Screen Recording in the Settings window, then try recording again"));return false;}
      if(data.error)throw new Error(data.error);
      if(data.snapshot)applyRecordingSnapshot(data.snapshot);else useRecordingStore.getState().startRecording();
      return true;
    }catch(error){
      if(error instanceof ApiError && ["live-language-unsupported","live-capabilities-unavailable"].includes(error.code || ""))setLiveStartError(error.code!);
      if(error instanceof Error && 'persistedOff' in error && error.persistedOff===true)useUIStore.getState().showToast(tr('Real-time transcription is now off for future recordings. Change it in Settings to turn it on again.')+' '+tr(error.message));
      else useUIStore.getState().showToast(tr("Error: {message}",undefined,{message:tr((error as Error).message)}));return false;}finally{setStarting(false);}
  };
  const start=()=>begin(false);
  const recordFinalOnly=()=>begin(true);
  const stop=async()=>{
    const meetingId=useRecordingStore.getState().coordinatorMeetingId;
    try {
      if(!meetingId)throw new Error("The active meeting changed; reload before issuing this command");
      useRecordingStore.getState().stopRecording();
      const result=await recordingApi.stop(meetingId,crypto.randomUUID());
      if(!result.snapshot?.session?.transcriptFinalized || result.snapshot.state!=="completed")throw new Error(tr("The transcript could not be saved. The audio remains available in recovery."));
      applyRecordingSnapshot(result.snapshot);void useSessionsStore.getState().load();return true;
    }catch(error){useRecordingStore.setState({processing:false});useUIStore.getState().showToast(tr("Stop failed: {message}",undefined,{message:tr((error as Error).message)}));return false;}
  };
  return {start,stop,recordFinalOnly,liveStartError,starting};
}
