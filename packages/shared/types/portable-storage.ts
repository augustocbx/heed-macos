import type {MeetingMode} from "./session";
import type {Segment} from './speaker';
import type {DeletionCapabilities} from './remote-deletion';
import type {RecognitionGeneration,TranscriptEdit} from './transcript-editing';
import type {NotesMetadata} from './notes';
export interface PortableAudio {sha256:string;bytes:number;format:'wav';mode:'archived';objectPath:string}
interface PortableMeetingFields {
 meetingId:string;title:string;createdAt:string;updatedAt?:string;duration:number;language:string;
 transcript:string;segments:Segment[];speakers:string[];tags:string[];aiNotes:string;summary:string;pinned:boolean;
 transcriptFinalized:true;transcriptionModel?:string;liveModel?:string;audio?:PortableAudio;
}
export interface PortableTranscriptHistory {schemaVersion:1;activeGenerationId:string;generations:Array<Omit<RecognitionGeneration,'transcriptionDiagnostics'>>;edits:Array<Omit<TranscriptEdit,'requestId'|'requestSignature'>>}
export type PortableMeeting = (PortableMeetingFields & {schemaVersion:1}) | (PortableMeetingFields & {schemaVersion:2;meetingMode?:MeetingMode;audioUnavailableReason?:'transcript-only';transcriptHistory?:PortableTranscriptHistory;notesMetadata?:NotesMetadata});
export interface PortableManifest {
 schemaVersion:1;libraryId:string;meetingId:string;revisionId:string;parents:string[];
 artifacts:Array<{path:'meeting.json';bytes:number;sha256:string}>;
}
export interface PortableCommit {
 schemaVersion:1;libraryId:string;meetingId:string;revisionId:string;deviceId:string;manifestPath:string;manifestHash:string;
}
export type PublicationState='local-saved'|'pending'|'uploading'|'provider-confirmed'|'verified'|'conflict'|'unavailable';
export interface LibraryPreview {libraryId:string;meetingId:string;revisionId:string;title:string;createdAt:string;bytes:number;local:boolean;deleted?:boolean;remoteDeleted?:boolean;remoteAvailable?:boolean;state:PublicationState;audio:boolean;error?:string}
export interface ProviderCapabilities {read:boolean;write:boolean;transportSecurity?:'signed'|'encrypted'|'unknown';remoteDeletion:boolean;durability:'share-readback'|'provider-receipt'|'local-only'}
export interface LibrarySnapshot {providerId?:string;readOnly?:boolean;capabilities?:ProviderCapabilities;deletionCapabilities?:DeletionCapabilities;configured:boolean;localMeetings?:Array<{id:string;title:string}>;providerName?:string;previews:LibraryPreview[];imported:number;skipped:number;pending:number;complete:boolean;error?:string}
