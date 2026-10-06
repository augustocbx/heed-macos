import type { AcceptTaskInput, TaskPatch, TasksSnapshot } from '@heed/shared';
import { apiClient } from './client';
export const tasksApi = {
 list:(sessionId?:string)=>apiClient.get<TasksSnapshot>(`/api/tasks${sessionId?`?sessionId=${encodeURIComponent(sessionId)}`:''}`),
 accept:(sessionId:string,sourceRevision:string,items:AcceptTaskInput[])=>apiClient.post<TasksSnapshot>('/api/tasks',{action:'accept',sessionId,sourceRevision,items}),
 dismiss:(sessionId:string,sourceRevision:string,ids:string[])=>apiClient.post<TasksSnapshot>('/api/tasks',{action:'dismiss',sessionId,sourceRevision,ids}),
 retry:(sessionId:string)=>apiClient.post<TasksSnapshot>('/api/tasks',{action:'retry',sessionId}),
 update:(id:string,revision:string,patch:TaskPatch)=>apiClient.post<TasksSnapshot>('/api/tasks',{action:'update',id,revision,patch}),
 delete:(id:string,revision:string)=>apiClient.post<TasksSnapshot>('/api/tasks',{action:'delete',id,revision}),
};
