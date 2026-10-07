import type {ManagedCategory} from './managed-quota';
import type {LocalIdentity} from './qa/synchronization-device-binding';

/** Optional local authority. A refusal never selects the ordinary pathname implementation. */
export interface LocalStoreStat {
 dev:number;ino:number;birthtimeMs:number;size:number;mtimeMs:number;uid:number;mode:number;nlink:number;
 isFile():boolean;isDirectory():boolean;isSymbolicLink():boolean;
}
export interface LocalReadHandle {readonly identity:LocalIdentity;readAt(offset:number,maximum:number):Buffer;verify():void;close():void}
export interface LocalWriteHandle {readonly identity:LocalIdentity;append(chunk:Uint8Array):void;sync():void;verify():void;close():void}
export interface LocalOwnedFile {path:string;bytes:number;modified:number;category:'text'|'media'|'indexes'|'staging';identity:string}
export interface LocalStoreIo {
 exists(path:string):boolean;stat(path:string):LocalStoreStat;readFile(path:string,maximum:number):Buffer;
 list(path:string,maximumEntries:number):string[];mkdir(path:string):void;canonical(path:string):string;
 writeAtomic(path:string,data:string):void;openRead(path:string,maximum:number):LocalReadHandle;
 createFile(path:string,maximum:number):LocalWriteHandle;stream(path:string,maximum:number,signal?:AbortSignal):AsyncIterable<Uint8Array>;
 promote(source:string,destination:string):void;unlink(path:string):void;removeStaging(path:string):void;
 syncDirectory(path:string):void;owns(path:string):boolean;
 inventory(roots:Partial<Record<ManagedCategory,string[]>>,excludedLedger:string):LocalOwnedFile[];
}
export type SessionLocalIo=Pick<LocalStoreIo,'exists'|'stat'|'readFile'|'list'|'unlink'>;
export type PortableLocalIo=Pick<LocalStoreIo,'exists'|'stat'|'readFile'|'list'|'mkdir'|'canonical'|'writeAtomic'|'openRead'|'createFile'|'stream'|'promote'|'removeStaging'|'syncDirectory'>;
export type QuotaLocalIo=Pick<LocalStoreIo,'exists'|'stat'|'unlink'|'removeStaging'|'owns'|'inventory'>;
