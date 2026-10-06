import type { ChatCommand, ChatThread } from "@heed/shared";
import { apiClient } from "./client";
const path=(sessionId:string)=>`/api/sessions/${encodeURIComponent(sessionId)}/chat`;
export const chatApi={
 get:(sessionId:string)=>apiClient.get<ChatThread>(path(sessionId)),
 models:()=>apiClient.get<{models:string[]}>("/api/chat/models"),
 command:(sessionId:string,command:ChatCommand)=>apiClient.post<ChatThread>(path(sessionId),command),
};
