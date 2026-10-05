import type { Session } from "@heed/shared";
import { sessionsApi } from "@/api/sessions.ts";
import { useRecordingStore } from "@/stores/recording.ts";
import { applySpeakerNames } from "./speakerNames.ts";

export async function createRecordingSession(session: Partial<Session>) {
 const fields = () => applySpeakerNames(session.segments || [], session.speakers || [], session.embeddings || {}, useRecordingStore.getState().speakerNames);
 const initial = fields();
 const created = await sessionsApi.create({ ...session, ...initial });
 useRecordingStore.getState().setSessionId(created.id);
 // Uma edição feita enquanto o POST estava em andamento também precisa ser salva.
 const latest = fields();
 if (JSON.stringify(initial) !== JSON.stringify(latest)) {
  return await sessionsApi.patch(created.id, latest);
 }
 return created;
}
