import { tr } from "./i18n.ts";
import type { Session, SessionPatch, TranscribeResult } from '@heed/shared';
import { transcribe, type TranscribeHandlers } from '@/api/transcribe';
import { applySpeakerNames, reconcileSpeakerNames } from './speakerNames';

export type FinalTranscriptionModel = 'parakeet-v3' | 'base' | 'small' | 'medium' | 'large-v3';
export type MeetingLanguage = 'auto' | 'en' | 'pt';

/** Replace a transcript only after the entire authoritative stream succeeds. */
export async function retranscribeSession(
 session: Session, model: FinalTranscriptionModel, language: MeetingLanguage,
 handlers: Pick<TranscribeHandlers, 'onStep' | 'onProgress'>,
 save: (id: string, patch: SessionPatch) => Promise<void>,
) {
 if (!session.files?.wav) throw new Error(tr("The saved audio is unavailable."));
 let completed: TranscribeResult | null = null;
 await transcribe({url:session.files.wav,language,diarize:true,recording_finalize:true,final_model:model},
  {...handlers,onResult:result=>{completed=result;}});
 const result = completed as TranscribeResult | null;
 if (!result?.success || !Array.isArray(result.segments) || !result.text?.trim()
  || !['en','pt'].includes(result.metadata?.language)) throw new Error(tr("No complete English or Portuguese transcript was returned. The existing transcript was kept."));
 const names = Object.fromEntries((session.speakers || []).filter(speaker =>
  session.segments.some(segment=>segment.speaker===speaker && segment.auto===false)
  || (!/^(Speaker\s*\d+|Unknown|You|Me)$/i.test(speaker)
   && session.segments.some(segment=>segment.speaker===speaker && segment.auto!==true))).map(speaker=>[speaker,speaker]));
 const mapped = applySpeakerNames(result.segments,result.speakers,result.embeddings || {},
  reconcileSpeakerNames(session.segments,result.segments,names));
 await save(session.id,{transcript:result.text,language:result.metadata.language,
  transcriptionModel:result.metadata.model || model,
  ...(Number.isFinite(result.duration) && (result.duration || 0)>0 ? {duration:result.duration} : {}),...mapped});
}
