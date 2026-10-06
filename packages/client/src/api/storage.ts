import {apiClient} from './client';
import type {StoragePreview,StorageUsage} from '@heed/shared';
export const storageApi={
 status:()=>apiClient.get<StorageUsage>('/api/storage'),
 preview:(limitBytes:number)=>apiClient.post<StoragePreview>('/api/storage/preview',{limitBytes}),
 apply:(limitBytes:number,token:string)=>apiClient.post<StorageUsage>('/api/storage/settings',{limitBytes,token}),
};
