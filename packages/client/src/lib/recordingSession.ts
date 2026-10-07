import type { Session } from "@heed/shared";
import { sessionsApi } from "@/api/sessions.ts";
import { useRecordingStore } from "@/stores/recording.ts";
import { guardForSession } from "./acceptedSession";
import { applySpeakerNames } from "./speakerNames.ts";

export async function createRecordingSession(session: Partial<Session>) {
 const fields = () => {
  const state = useRecordingStore.getState();
  const source = session.transcript && session.transcript === state.transcript ? state : session;
  return applySpeakerNames(source.segments || [], source.speakers || [], source.embeddings || {}, state.speakerNames);
 };
 const initial = fields();
 let saved = await sessionsApi.create({ ...session, ...initial, ...(session.transcriptFinalized ? { transcriptFinalized: false } : {}) });
 if (saved.transcriptFinalized) {
  useRecordingStore.getState().setSessionId(saved.id);
  return saved;
 }
 let previous = initial;
 // Keep the ID unpublished while final speaker writes are pending. An edit made
 // during any save must be included before the final recording is acknowledged.
 while (true) {
  const latest = fields();
  if (JSON.stringify(previous) === JSON.stringify(latest)) break;
  saved = await sessionsApi.patch(saved.id, { ...latest, ...guardForSession(saved), ...(session.transcriptFinalized ? { transcriptFinalized: false } : {}) });
  previous = latest;
 }
 if (session.transcriptFinalized) {
  // Close participant editing across the last commit. No eligible notes job can
  // appear during the reconciliation loop or use an in-flight speaker mapping.
  useRecordingStore.setState({finalSavePending:true});
  try { saved = await sessionsApi.patch(saved.id,{...fields(),transcriptFinalized:true,...guardForSession(saved)}); }
  finally { useRecordingStore.setState({finalSavePending:false}); }
 }
 useRecordingStore.getState().setSessionId(saved.id);
 return saved;
}
