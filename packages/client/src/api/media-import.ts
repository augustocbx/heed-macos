import type {MediaImportConfig,MediaImportJob,MediaImportSnapshot} from '@heed/shared';
import {apiClient} from './client';
export const mediaImportApi={
 list:()=>apiClient.get<MediaImportSnapshot>('/api/media/imports'),
 submit:(requestId:string,file:File,config:MediaImportConfig)=>{const form=new FormData();form.append('requestId',requestId);form.append('file',file);for(const [key,value]of Object.entries(config))form.append(key,value);return apiClient.postForm<MediaImportJob>('/api/media/imports',form,{'X-Heed-Import-Id':requestId,'X-Heed-Import-Size':String(file.size)});},
 command:(id:string,action:'cancel'|'retry'|'discard')=>apiClient.post<MediaImportJob>(`/api/media/imports/${encodeURIComponent(id)}/command`,{action}),
};
