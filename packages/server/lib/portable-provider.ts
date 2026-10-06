import type {PortableCommit} from '@heed/shared';
/** Adapters own authentication locally; this contract never accepts or exports credentials. */
export interface LibraryProvider {
 id:string;name:string;
 transport:'authenticated-network'|'os-managed-folder';
 list(cursor:string|null,limit:number,signal?:AbortSignal):Promise<{commits:PortableCommit[];next:string|null;complete:boolean}>;
 read(path:string,maxBytes:number,signal?:AbortSignal):Promise<Uint8Array>;
 stream(path:string,maxBytes:number,signal?:AbortSignal):AsyncIterable<Uint8Array>;
 /** The adapter verifies exact length/hash before committing an immutable object. */
 writeObjectImmutable(path:string,bytes:number,hash:string,source:AsyncIterable<Uint8Array>,signal?:AbortSignal):Promise<void>;
 writeImmutable(path:string,bytes:Uint8Array,signal?:AbortSignal):Promise<void>;
 /** A local folder write must return local-only until a provider verifies remote publication. */
 confirm(commit:PortableCommit,signal?:AbortSignal):Promise<'remote-confirmed'|'local-only'>;
}
export interface QuotaBudget {reserve(id:string,bytes:number,paths:string[]):void;release(id:string):void}
export function providerPath(path:string):string {
 if(typeof path!=='string'||path.length>512||path.includes('\\')||path.includes('%')||path.startsWith('/')||path.split('/').some(part=>!part||part==='.'||part==='..')||!(/^(meetings|commits|objects)\/[A-Za-z0-9_./-]+$/.test(path)))throw new Error('Invalid provider artifact path');return path;
}
