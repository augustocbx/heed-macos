import { useEffect, useRef } from 'react';
import { useRecordingStore } from '@/stores/recording.ts';
import { useHealthStore } from '@/stores/health.ts';
import { useUIStore } from '@/stores/ui.ts';
import { executeDesktopCommand, type DesktopCommand } from '@/lib/desktop-command.ts';

/** The menu delegates to this lifecycle so transcript/session persistence stays identical. */
export function useDesktopControl(controls:{start:(language?:string)=>Promise<boolean>;stop:(language?:string)=>Promise<boolean>}, setLanguage:(language:string)=>void) {
 const latest = useRef({controls,setLanguage});
 latest.current = {controls,setLanguage};
 useEffect(() => {
  const client = crypto.randomUUID();
  let cancelled = false;
  let busy = false;
  let executing:string|null = null;
  async function post(path:string, body:unknown) {
   const response = await fetch(`/api/desktop/control/${path}`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
   const data = await response.json();
   if (!response.ok) throw new Error(data.error || 'Desktop control failed');
   return data;
  }
  async function poll() {
   if (cancelled || busy) return;
   busy = true;
   try {
    const state = useRecordingStore.getState();
    const {command,status} = await post('poll', {client,recording:state.recording,processing:state.processing || !!executing,commandId:executing,seconds:state.seconds,ready:useHealthStore.getState().health.whisper});
    if (command && !cancelled && !executing) {
     const cmd = command as DesktopCommand & {id:string};
     executing = cmd.id;
     void (async () => {
     let error:string|null = null;
     try {
      // A new tab can stop/recover capture if the recording tab was closed.
      if (cmd.action === 'stop' && status.recording && !useRecordingStore.getState().recording) {
       useRecordingStore.getState().startRecording();
       useRecordingStore.setState({seconds:status.seconds});
      }
      latest.current.setLanguage(cmd.language);
      useUIStore.getState().setPage('record');
      await executeDesktopCommand(cmd, {recording:status.recording,processing:status.processing,ready:useHealthStore.getState().health.whisper}, latest.current.controls);
     } catch (e) {
      error = (e as Error).message;
      useUIStore.getState().showToast(error);
     }
     try { await post('complete', {client,id:cmd.id,error}); } catch { /* the server lease recovers a lost acknowledgment */ }
     finally {executing=null;}
     })();
    }
   } catch { /* retry when the local service is available */ }
   finally { busy = false; }
  }
  const timer = window.setInterval(poll,1000);
  void poll();
  return () => {cancelled=true;window.clearInterval(timer);};
 }, []);
}
