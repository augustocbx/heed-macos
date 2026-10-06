import type {LibrarySnapshot,LibraryPreview,RevisionKey,DeletionPreview,DeletionJob,RecoveryTransaction} from '@heed/shared';import {apiClient} from './client';
export const libraryApi={
 recoveryJobs:()=>apiClient.post<RecoveryTransaction[]>('/api/library',{action:'recovery-jobs'}),
 releaseOperation:(operationId:string,expectedProviderId:string)=>apiClient.post<LibrarySnapshot>('/api/library',{action:'release-operation',operationId,expectedProviderId}),
 reconcile:(operationId:string,expectedProviderId:string)=>apiClient.post<LibrarySnapshot>('/api/library',{action:'reconcile',operationId,expectedProviderId}),
 freshRevision:(revisionId:string,expectedProviderId:string)=>apiClient.post<LibraryPreview>('/api/library',{action:'fresh-revision',revisionId,expectedProviderId}),
 deletionJobs:()=>apiClient.post<DeletionJob[]>('/api/library',{action:'delete-jobs'}),
 deletionPreview:(revisions:RevisionKey[],expectedProviderId:string,expectedDestinationId:string)=>apiClient.post<DeletionPreview>('/api/library',{action:'delete-preview',revisions,expectedProviderId,expectedDestinationId}),
 deletionConfirm:(token:string,expectedProviderId:string,expectedDestinationId:string)=>apiClient.post<DeletionJob>('/api/library',{action:'delete-confirm',token,confirmed:true,expectedProviderId,expectedDestinationId}),
 deletionRetry:(jobId:string,expectedProviderId:string,expectedDestinationId:string)=>apiClient.post<DeletionJob>('/api/library',{action:'delete-retry',jobId,expectedProviderId,expectedDestinationId}),
 queue:(sessionId:string)=>apiClient.post<LibraryPreview>('/api/library',{action:'queue',sessionId}),
 snapshot:()=>apiClient.get<LibrarySnapshot>('/api/library'),
 refresh:(expectedProviderId:string)=>apiClient.post<LibrarySnapshot>('/api/library',{action:'refresh',expectedProviderId}),
 importSelected:(revisionIds:string[],expectedProviderId:string)=>apiClient.post<LibrarySnapshot>('/api/library',{action:'import',revisionIds,expectedProviderId}),
 resolve:(revisionId:string)=>apiClient.post<LibraryPreview>('/api/library',{action:'resolve',revisionId}),
 publish:(revisionId:string,expectedProviderId:string)=>apiClient.post<LibrarySnapshot>('/api/library',{action:'publish',revisionId,expectedProviderId}),
 audio:async(sessionId:string)=>{const snapshot=await apiClient.get<LibrarySnapshot&{providerId?:string}>('/api/library');if(!snapshot.providerId)throw new Error('No remote library provider is configured');return apiClient.post<{available:true}>('/api/library',{action:'audio',sessionId,expectedProviderId:snapshot.providerId});},
 migrate:()=>apiClient.post<{migrated:number;pending:number;errors:string[]}>('/api/library',{action:'migrate'}),
};
