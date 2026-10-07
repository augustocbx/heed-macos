import { useEffect } from "react";
import { useRecordingStore } from "@/stores/recording";
import { useHealthStore } from "@/stores/health";
import { applyRecordingSnapshot } from "@/lib/recordingSnapshot";

/** Browser clients observe capture; menu commands execute entirely in the backend. */
export function useDesktopControl() {
  useEffect(()=>{
    const client=crypto.randomUUID();let disposed=false;let busy=false;
    const poll=async()=>{
      if(disposed || busy)return;busy=true;
      try {
        const response=await fetch("/api/desktop/control/poll",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({client,ready:useHealthStore.getState().health.whisper})});
        if(!response.ok)return;
        const {status}=await response.json();if(disposed || !status)return;
        if(status.snapshot){applyRecordingSnapshot(status.snapshot);return;}
        // Compatibility while an installed backend is being updated.
        const local=useRecordingStore.getState();if(status.recording&&!local.recording)local.startRecording();
        const seconds=status.recording||local.recording?Math.max(0,Number(status.seconds)||0):local.seconds && (local.processing || local.segments.length || local.transcript)?local.seconds:0;
        useRecordingStore.setState({recording:status.recording===true,seconds});
      }catch { /* Retry after backend reconnect; never issue capture commands from polling. */ }
      finally{busy=false;}
    };
    const timer=window.setInterval(()=>void poll(),1000);void poll();
    return()=>{disposed=true;window.clearInterval(timer);};
  },[]);
}
