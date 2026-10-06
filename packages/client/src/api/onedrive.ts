import type {OneDriveConnectionSnapshot,OneDriveExpected,OneDriveLibraryChoice} from '@heed/shared';
import {apiClient} from './client';
const path='/api/connectors/onedrive';
export function oneDriveExpectation(snapshot:OneDriveConnectionSnapshot):OneDriveExpected{return {connectionId:snapshot.selected?.connectionId??null,folderGeneration:snapshot.folderGeneration,authGeneration:snapshot.authGeneration};}
export const oneDriveApi={
 snapshot:()=>apiClient.get<OneDriveConnectionSnapshot>(path),
 command:(action:string,expected:OneDriveExpected,fields:Record<string,unknown>={})=>apiClient.post<OneDriveConnectionSnapshot>(path,{action,expected,...fields}),
 libraries:(expected:OneDriveExpected)=>apiClient.post<OneDriveLibraryChoice[]>(path,{action:'libraries',expected}),
 create:(expected:OneDriveExpected,name:string)=>apiClient.post<OneDriveLibraryChoice>(path,{action:'create',expected,name}),
 initialize:(expected:OneDriveExpected,folderId:string)=>apiClient.post<OneDriveLibraryChoice>(path,{action:'initialize',expected,folderId}),
};
