import { tr } from "./i18n";
import { guardForSession } from "./acceptedSession";
import type { CandidateInput, Session, TranscribeResult } from "@heed/shared";
import { transcribe, type TranscribeHandlers } from "@/api/transcribe";
import { applySpeakerNames, reconcileSpeakerNames } from "./speakerNames";

export type FinalTranscriptionModel =
  | "parakeet-v3"
  | "base"
  | "small"
  | "medium"
  | "large-v3";
export type MeetingLanguage = "auto" | "en" | "pt";
const incomplete = () =>
  new Error(
    tr(
      "No complete English or Portuguese transcript was returned. The existing transcript was kept.",
    ),
  );

/** Stage only an authoritative, complete stream; accepted source and saved audio stay unchanged. */
export async function createRetranscriptionCandidate(
  session: Session,
  model: FinalTranscriptionModel,
  language: MeetingLanguage,
  handlers: Pick<TranscribeHandlers, "onStep" | "onProgress">,
  stage: (id: string, input: CandidateInput) => Promise<Session>,
): Promise<Session> {
  if (!session.files?.wav)
    throw new Error(tr("The saved audio is unavailable."));
  const id = session.id,
    url = session.files.wav,
    base = guardForSession(session),
    requestId = crypto.randomUUID();
  const sourceSegments = session.segments.map((segment) => ({ ...segment }));
  const names = Object.fromEntries(
    (session.speakers || [])
      .filter((speaker) => {
        if (
          ["Microphone (unattributed)", "System (unattributed)"].includes(
            speaker,
          ) &&
          sourceSegments.some(
            (segment) =>
              segment.speaker === speaker && segment.attribution === "fallback",
          )
        )
          return false;
        return (
          sourceSegments.some(
            (segment) => segment.speaker === speaker && segment.auto === false,
          ) ||
          (!/^(Speaker\s*\d+|Unknown|You|Me)$/i.test(speaker) &&
            sourceSegments.some(
              (segment) => segment.speaker === speaker && segment.auto !== true,
            ))
        );
      })
      .map((speaker) => [speaker, speaker]),
  );
  let completed: TranscribeResult | null = null;
  await transcribe(
    {
      url,
      language,
      diarize: true,
      recording_finalize: true,
      final_model: model,
    },
    {
      ...handlers,
      onResult: (result) => {
        completed = result;
      },
    },
  );
  const result = completed as TranscribeResult | null;
  if (
    result?.success !== true ||
    Object.hasOwn(result, "error") ||
    result.finalized !== true ||
    !Number.isFinite(result.duration) ||
    result.duration! < 0 ||
    typeof result.text !== "string" ||
    !result.text.trim() ||
    !["en", "pt"].includes(result.metadata?.language) ||
    typeof result.metadata?.model !== "string" ||
    !result.metadata.model.trim() ||
    !Number.isSafeInteger(result.wordCount) ||
    result.wordCount < 0 ||
    !result.files ||
    !["wav", "srt", "txt"].every(
      (key) =>
        typeof result.files[key as keyof typeof result.files] === "string",
    ) ||
    !Array.isArray(result.speakers) ||
    result.speakers.some(
      (speaker) => typeof speaker !== "string" || !speaker.trim(),
    ) ||
    new Set(result.speakers).size !== result.speakers.length ||
    !Array.isArray(result.segments) ||
    result.segments.some(
      (segment) =>
        !segment ||
        typeof segment.text !== "string" ||
        typeof segment.speaker !== "string" ||
        !result.speakers.includes(segment.speaker) ||
        !Number.isFinite(segment.start) ||
        !Number.isFinite(segment.end) ||
        segment.start < 0 ||
        segment.end < segment.start ||
        segment.end > result.duration! ||
        (segment.channel !== undefined &&
          !["mic", "sys"].includes(segment.channel)) ||
        (segment.auto !== undefined && typeof segment.auto !== "boolean") ||
        (segment.attribution !== undefined &&
          segment.attribution !== "fallback") ||
        (segment.id !== undefined && !Number.isSafeInteger(segment.id)) ||
        (segment.overlap !== undefined && typeof segment.overlap !== "boolean"),
    ) ||
    result.speakers.some(
      (speaker) =>
        !result.segments.some((segment) => segment.speaker === speaker),
    ) ||
    (result.embeddings !== undefined &&
      (result.embeddings === null ||
        typeof result.embeddings !== "object" ||
        Array.isArray(result.embeddings) ||
        Object.entries(result.embeddings).some(
          ([speaker, vector]) =>
            !result.speakers.includes(speaker) ||
            !Array.isArray(vector) ||
            !vector.length ||
            vector.some(
              (value) => typeof value !== "number" || !Number.isFinite(value),
            ),
        ))) ||
    (result.segments.length > 0 &&
      result.text !== result.segments.map((segment) => segment.text).join("\n"))
  )
    throw incomplete();
  const mapped = applySpeakerNames(
    result.segments,
    result.speakers,
    result.embeddings || {},
    reconcileSpeakerNames(sourceSegments, result.segments, names),
  );
  return stage(id, {
    requestId,
    base,
    result: {
      success: true,
      finalized: true,
      duration: result.duration,
      text: result.text,
      metadata: { ...result.metadata },
      wordCount: result.wordCount,
      transcriptionDiagnostics: result.transcriptionDiagnostics,
      files: { wav: "", srt: "", txt: "" },
      ...mapped,
    },
  });
}
