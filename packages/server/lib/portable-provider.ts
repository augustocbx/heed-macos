import type {PortableCommit,ProviderCapabilities,DeletionCapabilities,RemoteInventory,DeletionRecord,PublicationIntent,ArtifactIdentity,RevisionDeletionFence} from '@heed/shared';
export interface RemoteTransaction {
 /** Private v3 preview binding; raw native object receipts never enter portable state. */
 observationDigest?():Promise<string>;
 /** Authorize release only after the caller's durable job/catalog checkpoint. */
 checkpoint():Promise<void>;
 inventory(signal?:AbortSignal):Promise<RemoteInventory>;
 writeDeletion(record:DeletionRecord,signal?:AbortSignal):Promise<void>;
 writeFence(fence:RevisionDeletionFence,signal?:AbortSignal):Promise<void>;
 writePending(intent:PublicationIntent,signal?:AbortSignal):Promise<void>;
 retirePending(intent:PublicationIntent,signal?:AbortSignal):Promise<void>;
 removeExact(jobId:string,artifact:ArtifactIdentity,signal?:AbortSignal):Promise<'removed'|'already-removed'>;
}
export interface TransactionContext {operationId:string;deviceId:string;kind:'read'|'publish'|'delete'}
export interface PendingRemoteTransaction {operationId:string;deviceId:string;kind:TransactionContext['kind'];recoverable:boolean;releaseOnly?:boolean;blockedReason?:string;admissions:Array<{meetingId:string;revisionId:string;manifestHash:string}>}
/** Adapters own authentication locally; this contract never accepts or exports credentials. */
export interface LibraryProvider {
 id:string;name:string;readOnly?:boolean;capabilities?:ProviderCapabilities;
 transport:'authenticated-network'|'os-managed-folder';
 deletionCapabilities?:DeletionCapabilities;
 pendingTransactions?():PendingRemoteTransaction[];
 withTransaction?<T>(context:TransactionContext,run:(transaction:RemoteTransaction)=>Promise<T>,signal?:AbortSignal):Promise<T>;
 list(cursor:string|null,limit:number,signal?:AbortSignal):Promise<{commits:PortableCommit[];next:string|null;complete:boolean}>;
 /** Advance a staged provider checkpoint only after complete validated catalog persistence. */
 acknowledgeDiscovery?(signal?:AbortSignal):Promise<void>;
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

/** Coordination versions are admitted explicitly; unknown versions never fall back to legacy I/O. */
export function coordinatedProvider(provider:LibraryProvider):boolean {
 const caps=provider.deletionCapabilities;if(!caps||caps.destinationVersion===1)return false;
 if(caps.destinationVersion===2){if(!provider.withTransaction)throw Error('Remote coordination is unavailable');return true;}
 if(caps.destinationVersion===3&&caps.revisionMetadata&&caps.exclusion==='exclusive-create'&&provider.withTransaction&&!provider.readOnly)return true;
 throw Error('Remote coordination is unavailable for this destination');
}
