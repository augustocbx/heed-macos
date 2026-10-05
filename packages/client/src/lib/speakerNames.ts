import type { Segment } from "@heed/shared";

/** Applies manual choices without changing transcript timing, text, or channels. */
export function applySpeakerNames(
 segments: Segment[], speakers: string[], embeddings: Record<string, number[]>, names: Record<string, string>,
) {
 return {
  segments: segments.map(segment => names[segment.speaker]
   ? { ...segment, speaker: names[segment.speaker], auto: false } : segment),
  speakers: [...new Set(speakers.map(speaker => names[speaker] || speaker))],
  embeddings: Object.fromEntries(Object.entries(embeddings).map(([speaker, embedding]) => [names[speaker] || speaker, embedding])),
 };
}

/** Diarization indices may change; names transfer only with matching channel and timing evidence. */
export function reconcileSpeakerNames(previous: Segment[], final: Segment[], names: Record<string, string>) {
 if (previous === final) return { ...names };
 const resolved: Record<string, string> = {};
 const conflicts = new Set<string>();
 const assign = (speaker: string, name: string) => {
  if (conflicts.has(speaker)) return;
  if (resolved[speaker] && resolved[speaker] !== name) {
   delete resolved[speaker];
   conflicts.add(speaker);
  } else resolved[speaker] = name;
 };
 for (const [original, name] of Object.entries(names)) {
  const source = previous.filter(s => s.speaker === original);
  if (!source.length) continue;
  const mic = source.every(s => s.channel === "mic");
  const candidates = [...new Set(final.filter(s => mic ? s.channel === "mic" : s.channel !== "mic").map(s => s.speaker))];
  if (mic && candidates.length === 1) { assign(candidates[0], name); continue; }
  const scores = candidates.map(speaker => ({ speaker, overlap: final.filter(s => s.speaker === speaker).reduce((sum, target) =>
   sum + source.reduce((n, origin) => n + (origin.end > origin.start && target.end > target.start
    ? Math.max(0, Math.min(origin.end, target.end) - Math.max(origin.start, target.start)) : 0), 0), 0) })).sort((a,b) => b.overlap-a.overlap);
  const total = scores.reduce((sum, s) => sum+s.overlap, 0);
  // Do not assign a name to a different voice just because it received the same number.
  if (scores[0]?.overlap >= 0.25 && scores[0].overlap >= total * 0.7
   && (!scores[1] || scores[0].overlap > scores[1].overlap * 2)) {
   assign(scores[0].speaker, name);
  }
 }
 return resolved;
}
