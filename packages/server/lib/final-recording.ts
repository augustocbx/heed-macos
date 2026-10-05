/** Accept only a completed full-audio pass, never the provisional live preview. */
export function finalRecordingResult(fin: any, path: string) {
 if (!fin || fin.error || fin.finalized !== true || !["en", "pt"].includes(fin.language) || !Array.isArray(fin.turns)) {
  throw new Error(fin?.error || "Final transcription did not complete");
 }
 const autoNamed = fin.auto_named || {};
 const segments = fin.turns.filter((t: any) => (t.text || "").trim()).map((t: any, id: number) => ({
  id, speaker: t.speaker, channel: t.channel === "mic" ? "mic" as const : "sys" as const,
  text: t.text.trim(), start: t.start, end: t.end, auto: !!autoNamed[t.speaker],
 }));
 const text = segments.map((t: any) => t.text).join("\n");
 return { success: true, finalized: true, duration:typeof fin.duration === "number" && Number.isFinite(fin.duration) && fin.duration >= 0 ? fin.duration : undefined, text, segments, speakers: [...new Set(segments.map((t: any) => t.speaker))], embeddings: fin.embeddings || {}, autoNamed,
  metadata: { language: fin.language as "en" | "pt", model: fin.model || "parakeet-v3" }, files: { wav: path, srt: "", txt: "" }, wordCount: text.split(/\s+/).filter(Boolean).length };
}

export function recordingFinalizationOptions(language: string, finalModel: string | null) {
 if (!["auto", "en", "pt"].includes(language) || (finalModel && !["parakeet-v3", "base", "small", "medium", "large-v3"].includes(finalModel))) {
  throw new Error("Choose auto, English or Portuguese and a supported final model");
 }
 return {language:finalModel ? language : "auto", final_model:finalModel || "parakeet-v3", manual:!!finalModel};
}
