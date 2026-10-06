import type {PortableCommit} from './portable-storage';
export interface RevisionKey {libraryId:string;meetingId:string;revisionId:string}
export interface ArtifactIdentity {path:string;bytes:number;sha256:string}
export interface RevisionDescriptor extends RevisionKey {manifestHash:string;parents:string[]}
export interface RevisionDeletionFence {kind:'heed-deleted-revision';version:1;jobId:string;destinationId:string;revision:RevisionDescriptor;artifact:ArtifactIdentity}
export interface DeletionRecord {version:1;jobId:string;destinationId:string;revisions:RevisionDescriptor[];artifacts:ArtifactIdentity[]}
export interface PublicationIntent {version:1;id:string;deviceId:string;revision:RevisionKey;audio?:ArtifactIdentity}
export interface RemoteInventory {commits:PortableCommit[];deletions:DeletionRecord[];pending:PublicationIntent[];complete:boolean}
export interface DeletionCapabilities {revisionMetadata:boolean;sharedAudioGC:boolean;exclusion:'exclusive-create'|'local-coordination'|'none';confirmation:'pending-verification'|'pending-propagation'|'disabled';connectionGeneration:string;destinationVersion:1|2|3;destinationId?:string;blockedReason?:string}
export interface DeletionSelection {providerId:string;destinationId:string;revisions:RevisionKey[]}
export interface DeletionPreview {token:string;expiresAt:string;selection:DeletionSelection;versions:number;eligibleBytes:number;retainedBytes:number;sharedAudioGC:boolean;confirmation:DeletionCapabilities['confirmation']}
export interface DeletionJob {id:string;selection:DeletionSelection;state:'prepared'|'deleting'|'incomplete'|'pending-verification'|'pending-propagation';removed:number;total:number;retainedBytes:number;error?:string;blockedReason?:string}

export interface RecoveryTransaction {operationId:string;kind:'read'|'publish'|'delete';recoverable:boolean;releaseOnly?:boolean;releaseAvailable?:boolean;blockedReason?:string}
