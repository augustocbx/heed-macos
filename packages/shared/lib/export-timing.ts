import type { MeetingExportSnapshot, MeetingExportWarning, SubtitleCue } from '../types/meeting-export';

export class ExportContentError extends Error {
 constructor(message: string, public code: string) { super(message); }
}

export function assertExportText(text: string): void {
 if (typeof text !== 'string' || text.includes('\0') || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text)) {
  throw new ExportContentError('Export text contains an invalid Unicode character.', 'invalid-text');
 }
}

const graphemes = new Intl.Segmenter('und', { granularity: 'grapheme' });
/** Preserve nonempty authored lines; wrap presentation without splitting Unicode clusters. */
export function wrapSubtitleText(text: string): string {
 assertExportText(text);
 const lines: string[] = [];
 for (const line of text.replace(/\r\n?/g, '\n').split('\n').filter(line => line.trim().length > 0)) {
  const clusters = [...graphemes.segment(line)].map(value => value.segment);
  while (clusters.length > 42) {
   let cut = 42;
   // Prefer a word boundary, retaining its space so wrapping does not remove authored text.
   for (let index = 41; index > 0; index--) if (/\s/u.test(clusters[index]!)) { cut = index + 1; break; }
   lines.push(clusters.splice(0, cut).join(''));
  }
  if (clusters.length) lines.push(clusters.join(''));
 }
 return lines.join('\n');
}

export function buildTimedExportCues(segments: MeetingExportSnapshot['segments'], duration: number | null, speakers: boolean): { cues: SubtitleCue[]; warnings: MeetingExportWarning[] } {
 const cues: SubtitleCue[] = [];
 const warnings = new Set<MeetingExportWarning>();
 const durationMs = duration !== null && Number.isFinite(duration) && duration > 0 ? Math.round(duration * 1000) : null;
 for (const [sourceIndex, segment] of segments.entries()) {
  assertExportText(segment.text);
  if (!segment.text.trim()) continue;
  const startMs = Math.round(segment.start * 1000), endMs = Math.round(segment.end * 1000);
  if (!Number.isFinite(segment.start) || !Number.isFinite(segment.end) || segment.start < 0 ||
   !Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs) || endMs <= startMs || (durationMs !== null && endMs > durationMs)) {
   throw new ExportContentError(`Segment ${sourceIndex + 1} has invalid subtitle timing.`, 'invalid-timing');
  }
  if (speakers && segment.speaker !== undefined) assertExportText(segment.speaker);
  const literal = speakers && segment.speaker ? `${segment.speaker}: ${segment.text}` : segment.text;
  const text = wrapSubtitleText(literal);
  const visible = [...graphemes.segment(literal)].filter(value => !/\s/u.test(value.segment)).length;
  if (text.split('\n').length > 2 || visible / ((endMs - startMs) / 1000) > 20) warnings.add('subtitle-long-cue');
  cues.push({ startMs, endMs, text, sourceIndex });
 }
 if (!cues.length) throw new ExportContentError('This meeting has no nonempty timed transcript to export.', 'no-subtitles');
 cues.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs || a.sourceIndex - b.sourceIndex);
 let latestEnd = -1;
 for (const cue of cues) { if (cue.startMs < latestEnd) warnings.add('subtitle-overlap'); latestEnd = Math.max(latestEnd, cue.endMs); }
 return { cues, warnings: [...warnings] };
}
