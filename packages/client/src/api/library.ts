import type {LibrarySnapshot,LibraryPreview} from '@heed/shared';import {apiClient} from './client';
export const libraryApi={
 queue:(sessionId:string)=>apiClient.post<LibraryPreview>('/api/library',{action:'queue',sessionId}),
 snapshot:()=>apiClient.get<LibrarySnapshot>('/api/library'),
 refresh:(expectedProviderId:string)=>apiClient.post<LibrarySnapshot>('/api/library',{action:'refresh',expectedProviderId}),
 importSelected:(revisionIds:string[],expectedProviderId:string)=>apiClient.post<LibrarySnapshot>('/api/library',{action:'import',revisionIds,expectedProviderId}),
 resolve:(revisionId:string)=>apiClient.post<LibraryPreview>('/api/library',{action:'resolve',revisionId}),
 publish:(revisionId:string,expectedProviderId:string)=>apiClient.post<LibrarySnapshot>('/api/library',{action:'publish',revisionId,expectedProviderId}),
 audio:async(sessionId:string)=>{const snapshot=await apiClient.get<LibrarySnapshot&{providerId?:string}>('/api/library');if(!snapshot.providerId)throw new Error('No remote library provider is configured');return apiClient.post<{available:true}>('/api/library',{action:'audio',sessionId,expectedProviderId:snapshot.providerId});},
 migrate:()=>apiClient.post<{migrated:number;pending:number;errors:string[]}>('/api/library',{action:'migrate'}),
};
