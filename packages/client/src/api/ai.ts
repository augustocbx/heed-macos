import type {AiPlanRequest, AiPreview, AiAuthorizationDecision, AiAuthorizationReceipt, AiConnectionInput, AiConnectionSnapshot, AiFeature, AiSelection, AiSettingsSnapshot} from '@heed/shared';
import {apiClient} from './client';
/** Keys are submitted once and never retained by this API or browser storage. */
export const aiApi={
 plan:(command:AiPlanRequest)=>apiClient.post<AiPreview>('/api/ai/plans',command),
 authorize:(planId:string,decision:AiAuthorizationDecision)=>apiClient.post<AiAuthorizationReceipt>('/api/ai/authorize',{planId,decision}),
 settings:()=>apiClient.get<AiSettingsSnapshot>('/api/ai/settings'),
 saveSelection:(feature:AiFeature,selection:AiSelection)=>apiClient.post<AiSettingsSnapshot>('/api/ai/settings',{feature,selection}),
 register:(input:AiConnectionInput)=>apiClient.post<AiConnectionSnapshot>('/api/ai/connections',{action:'register',...input}),
 validate:(id:string)=>apiClient.post<AiConnectionSnapshot>('/api/ai/connections',{action:'validate',id}),
 replace:(id:string,input:AiConnectionInput)=>apiClient.post<AiConnectionSnapshot>('/api/ai/connections',{action:'replace',id,...input}),
 remove:(id:string)=>apiClient.post<AiSettingsSnapshot>('/api/ai/connections',{action:'remove',id}),
};
