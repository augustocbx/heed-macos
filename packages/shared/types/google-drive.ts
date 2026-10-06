export type GoogleAccessMode='app-files'|'existing-readonly'|'existing-readwrite';
export interface GoogleFolder {id:string;name:string;destinationId:string;driveId?:string;canUpload:boolean}
export interface GoogleConnectionSnapshot {connected:boolean;authorizing:boolean;connectionId?:string;clientId?:string;accessMode?:GoogleAccessMode;folder?:GoogleFolder;generation:number;error?:string}
export interface GoogleDriveSnapshot extends GoogleConnectionSnapshot {pendingCreation:boolean;busy:boolean;recoveryRequired?:boolean}
export interface DriveFolderPreview {id:string;name:string;canCreate:boolean;driveId?:string}
export interface GoogleDriveCapacity {limit?:number;usage?:number}
