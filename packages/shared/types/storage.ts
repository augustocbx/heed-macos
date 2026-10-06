export interface StorageUsage {
 limitBytes:number;usedBytes:number;reservedBytes:number;protectedBytes:number;reclaimableBytes:number;availableBytes:number;
 categories:{text:number;media:number;indexes:number;staging:number};
}
export interface StoragePreview extends StorageUsage {requestedLimit:number;removals:Array<{path:string;bytes:number}>;token:string}
