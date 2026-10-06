export interface OneDriveBinding {connectionId:string;driveId:string;appRootId:string;rootId:string;destinationId:string;name:string;accountType:'personal'|'business'|'documentLibrary'|'unknown'}
export interface OneDriveLibraryChoice {id:string;name:string;destinationId?:string;needsCreation:boolean}
export interface OneDriveExpected {connectionId:string|null;folderGeneration:number;authGeneration:number}
export interface OneDriveConnectionSnapshot {folderGeneration:number;authGeneration:number;connected:boolean;authorizing:boolean;clientId?:string;tenant?:string;selected?:OneDriveBinding;uploadLocal:boolean;enabled:boolean;busy:boolean;pending:number;imported:number;skipped:number;lastSync?:string;error?:string;remoteCapacity?:{total:number;remaining:number};retryAt?:number}
