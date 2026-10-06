import type {GoogleDriveSnapshot,GoogleAccessMode,DriveFolderPreview,GoogleDriveCapacity} from '@heed/shared';import {apiClient} from './client';
export type GoogleExpected=Pick<GoogleDriveSnapshot,'generation'|'connectionId'|'folder'>;
const command=<T>(body:object,expected:GoogleExpected)=>apiClient.post<T>('/api/google-drive',{...body,expectedGeneration:expected.generation,expectedConnectionId:expected.connectionId??null,expectedFolderId:expected.folder?.id??null});
export const googleDriveApi={
 snapshot:()=>apiClient.get<GoogleDriveSnapshot>('/api/google-drive'),
 connect:(input:{clientId:string;accessMode:GoogleAccessMode;broaderAccessConfirmed:boolean},expected:GoogleExpected)=>command<GoogleDriveSnapshot>({action:'connect',...input},expected),
 cancel:(expected:GoogleExpected)=>command<GoogleDriveSnapshot>({action:'cancel'},expected),
 disconnect:(revoke:boolean,expected:GoogleExpected)=>command<GoogleDriveSnapshot>({action:'disconnect',revoke},expected),
 folders:(expected:GoogleExpected)=>command<DriveFolderPreview[]>({action:'folders'},expected),
 select:(folderId:string,expected:GoogleExpected)=>command<GoogleDriveSnapshot>({action:'select',folderId},expected),
 create:(input:{parentId:string;name:string;confirmed:boolean},expected:GoogleExpected)=>command<GoogleDriveSnapshot>({action:'create',...input},expected),
 capacity:(expected:GoogleExpected)=>command<GoogleDriveCapacity>({action:'capacity'},expected),
 enable:(expected:GoogleExpected)=>command<GoogleDriveSnapshot>({action:'enable'},expected),
 forgetCreation:(expected:GoogleExpected)=>command<GoogleDriveSnapshot>({action:'forget-creation'},expected),
};
