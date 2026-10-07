import type { MeetingExportSnapshot, MeetingExportWarning, SubtitleCue } from '@heed/shared';
import { assertExportText, buildTimedExportCues } from '../../../../shared/lib/export-timing';

export function buildSubtitleCues(snapshot: MeetingExportSnapshot, speakers: boolean): { cues: SubtitleCue[]; warnings: MeetingExportWarning[] } {
 return buildTimedExportCues(snapshot.segments, snapshot.duration, speakers);
}
function escapeText(text: string): string { return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'); }
function timestamp(value: number, separator: ',' | '.'): string {
 return `${String(Math.floor(value / 3_600_000)).padStart(2, '0')}:${String(Math.floor(value / 60_000) % 60).padStart(2, '0')}:${String(Math.floor(value / 1000) % 60).padStart(2, '0')}${separator}${String(value % 1000).padStart(3, '0')}`;
}
export function serializeSubtitles(format: 'srt' | 'vtt', snapshot: MeetingExportSnapshot, speakers: boolean): string {
 if (format !== 'srt' && format !== 'vtt') throw Error('Choose SRT or VTT for subtitles.');
 const { cues } = buildSubtitleCues(snapshot, speakers);
 const separator = format === 'srt' ? ',' : '.';
 const body = cues.map((cue, index) => `${index + 1}\n${timestamp(cue.startMs, separator)} --> ${timestamp(cue.endMs, separator)}\n${escapeText(cue.text)}\n`).join('\n');
 if (format === 'srt') return body;
 assertExportText(snapshot.sourceRevision); assertExportText(snapshot.generatedAt);
 const source = escapeText(snapshot.sourceRevision.replace(/[\r\n]/g, ' ')), date = escapeText(snapshot.generatedAt.replace(/[\r\n]/g, ' '));
 return `WEBVTT\n\nNOTE Source ${source}; local version ${snapshot.sourceVersion}; generated ${date}\n\n${body}`;
}
