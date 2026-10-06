import type {LibrarySnapshot,LibraryPreview} from '@heed/shared';import {apiClient} from './client';
export const libraryApi={
 queue:(sessionId:string)=>apiClient.post<LibraryPreview>('/api/library',{action:'queue',sessionId}),
 snapshot:()=>apiClient.get<LibrarySnapshot>('/api/library'),
 refresh:()=>apiClient.post<LibrarySnapshot>('/api/library',{action:'refresh'}),
 importSelected:(revisionIds:string[])=>apiClient.post<LibrarySnapshot>('/api/library',{action:'import',revisionIds}),
 resolve:(revisionId:string)=>apiClient.post<LibraryPreview>('/api/library',{action:'resolve',revisionId}),
 publish:(revisionId:string,expectedProviderId:string)=>apiClient.post<LibrarySnapshot>('/api/library',{action:'publish',revisionId,expectedProviderId}),
 audio:(sessionId:string)=>apiClient.post<{available:true}>('/api/library',{action:'audio',sessionId}),
 migrate:()=>apiClient.post<{migrated:number;pending:number;errors:string[]}>('/api/library',{action:'migrate'}),
};
