import type { TranscriptionChannelDiagnostics, TranscriptionDiagnostics, TranscriptionWarning } from "../../shared/types/speaker.ts";

const levelFields = ["rawRms", "rawPeak", "cleanedRms"] as const;
const countFields = ["asrSegments", "diarizationSegments", "usableEmbeddings", "retainedSegments", "discardedSegments", "fallbackSegments"] as const;
const warningCodes = new Set<TranscriptionWarning>(["microphone-all-asr-filtered", "microphone-attribution-fallback", "system-attribution-fallback"]);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** Copy only fixed numeric fields and warning codes; worker payloads never become diagnostics. */
export function sanitizeTranscriptionDiagnostics(value: unknown): TranscriptionDiagnostics | undefined {
 if (!object(value) || value.version !== 1 || typeof value.aecApplied !== "boolean" || !object(value.channels) || !Array.isArray(value.warnings)) return;
 const channels: TranscriptionDiagnostics["channels"] = {};
 for (const name of ["mic", "sys"] as const) {
  const source=value.channels[name];
  if(source === undefined) continue;
  if(!object(source) || typeof source.diarizationFailed !== "boolean" || !object(source.discardReasons)) return;
  if(levelFields.some(key=>typeof source[key] !== "number" || !Number.isFinite(source[key]) || (source[key] as number)<0) || countFields.some(key=>!count(source[key]))) return;
  const reason=source.discardReasons["echo-text-and-time"];
  if(reason !== undefined && !count(reason)) return;
  channels[name]={...Object.fromEntries([...levelFields,...countFields].map(key=>[key,source[key]])),
   diarizationFailed:source.diarizationFailed,discardReasons:reason === undefined ? {} : {"echo-text-and-time":reason}} as TranscriptionChannelDiagnostics;
 }
 if(!channels.mic && !channels.sys) return;
 return {version:1,channels,aecApplied:value.aecApplied,warnings:[...new Set(value.warnings.filter((warning): warning is TranscriptionWarning=>typeof warning === "string" && warningCodes.has(warning as TranscriptionWarning)))]};
}

/** Accept only a completed full-audio pass, never the provisional live preview. */
export function finalRecordingResult(fin: any, path: string) {
 if (!fin || fin.error || fin.finalized !== true || !["en", "pt"].includes(fin.language) || !Array.isArray(fin.turns)) {
  throw new Error(fin?.error || "Final transcription did not complete");
 }
 const autoNamed = fin.auto_named || {};
 const segments = fin.turns.filter((t: any) => (t.text || "").trim()).map((t: any, id: number) => ({
  id, speaker: t.speaker, channel: t.channel === "mic" ? "mic" as const : "sys" as const,
  text: t.text.trim(), start: t.start, end: t.end, auto: !!autoNamed[t.speaker],
  ...(t.attribution === "fallback" ? {attribution:"fallback" as const} : {}),
 }));
 const text = segments.map((t: any) => t.text).join("\n");
 const transcriptionDiagnostics=sanitizeTranscriptionDiagnostics(fin.diagnostics);
 return { success: true, finalized: true, duration:typeof fin.duration === "number" && Number.isFinite(fin.duration) && fin.duration >= 0 ? fin.duration : undefined, text, segments, speakers: [...new Set(segments.map((t: any) => t.speaker))], embeddings: fin.embeddings || {}, autoNamed,
  metadata: { language: fin.language as "en" | "pt", model: fin.model || "parakeet-v3" }, files: { wav: path, srt: "", txt: "" }, wordCount: text.split(/\s+/).filter(Boolean).length,
  ...(transcriptionDiagnostics ? {transcriptionDiagnostics} : {}) };
}

export function recordingFinalizationOptions(language: string, finalModel: string | null) {
 if (!["auto", "en", "pt"].includes(language) || (finalModel && !["parakeet-v3", "base", "small", "medium", "large-v3"].includes(finalModel))) {
  throw new Error("Choose auto, English or Portuguese and a supported final model");
 }
 return {language:finalModel ? language : "auto", final_model:finalModel || "parakeet-v3", manual:!!finalModel};
}
