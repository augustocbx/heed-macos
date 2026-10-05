import { useEffect } from 'react';
import { useSessionsStore } from '@/stores/sessions';
/** One app-wide refresh keeps list, detail, and recording results on saved session data. */
export function useAutomaticNotesPolling() {
 useEffect(() => {
  let stopped = false;
  let refreshing = false;
  const refresh = async () => {
   if (stopped || refreshing) return;
   refreshing = true;
   try { await useSessionsStore.getState().load(true); }
   finally { refreshing = false; }
  };
  const interval = window.setInterval(() => void refresh(), 2000);
  const onFocus = () => void refresh();
  window.addEventListener('focus', onFocus);
  return () => { stopped = true; window.clearInterval(interval); window.removeEventListener('focus', onFocus); };
 }, []);
}
