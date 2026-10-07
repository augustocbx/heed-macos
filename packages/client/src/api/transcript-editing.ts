import type { CandidateInput, ReplaceInput, ReplacementPreview, Session, TranscriptCommand, TranscriptGuard } from "@heed/shared";
import { apiClient } from "./client";
import { beginSessionRequest, useSessionsStore } from "@/stores/sessions";

const path = (id: string) => `/api/sessions/${encodeURIComponent(id)}/transcript`;
async function mutation(id: string, route: string, input: unknown): Promise<Session> {
 const order = beginSessionRequest(id);
 const saved = await apiClient.post<Session>(`${path(id)}/${route}`, input);
 return useSessionsStore.getState().accept(saved, order);
}
export const transcriptEditingApi = {
 preview: (id: string, input: ReplaceInput, guard: TranscriptGuard) =>
  apiClient.post<ReplacementPreview>(`${path(id)}/preview`, { input, guard }),
 command: (id: string, command: TranscriptCommand) => mutation(id, "commands", command),
 stage: (id: string, input: CandidateInput) => mutation(id, "candidates", input),
 discard: (id: string, candidateId: string, requestId: string) =>
  mutation(id, `candidates/${encodeURIComponent(candidateId)}/discard`, { requestId }),
};
