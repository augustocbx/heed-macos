import { expect, test } from 'vitest';
import { parseSync } from 'subtitle';
import { buildSubtitleCues, serializeSubtitles } from './subtitles';
import { exportPreview } from './fixtures.test-support';

const decode = (text: string) => text.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
test.each(['srt', 'vtt'] as const)('%s independently roundtrips literal four-language Unicode without injected cues', format => {
 const snapshot = exportPreview().snapshot;
 snapshot.segments = [{ start: 1.2346, end: 3, text: 'Ação / Hello / Straße / français\n\n<b> --> &amp;\na\u0301', speaker: '<b>Ana --> &amp;</b>' }];
 const output = serializeSubtitles(format, snapshot, true);
 const nodes = parseSync(output).filter(node => node.type === 'cue');
 expect(nodes).toHaveLength(1); const cue = nodes[0]!; if (cue.type !== 'cue') throw Error('Missing cue');
 expect(cue.data.start).toBe(1235); expect(cue.data.end).toBe(3000);
 expect(decode(cue.data.text)).toBe(buildSubtitleCues(snapshot, true).cues[0]!.text);
 expect(output).not.toContain('<b>'); expect(output.endsWith('\n')).toBe(true);
 if (format === 'vtt') { expect(output.startsWith('WEBVTT\n\nNOTE ')).toBe(true); expect(output).toContain(snapshot.sourceRevision); }
 else { expect(output.startsWith('1\n00:00:01,235 --> 00:00:03,000\n')).toBe(true); expect(output).not.toContain(snapshot.sourceRevision); }
});
test('preserves overlap, stable ties, late hours and one cue per nonempty corrected segment', () => {
 const snapshot = exportPreview().snapshot; snapshot.duration = null;
 snapshot.segments = [{ start: 90000, end: 90002, text: 'Long '.repeat(30) }, { start: 0, end: 2, text: 'first' }, { start: 0, end: 2, text: 'second' }, { start: -1, end: -2, text: '' }];
 const built = buildSubtitleCues(snapshot, false); expect(built.cues.map(cue => cue.sourceIndex)).toEqual([1, 2, 0]);
 expect(built.warnings).toEqual(['subtitle-long-cue', 'subtitle-overlap']);
 const parsed = parseSync(serializeSubtitles('srt', snapshot, false)).filter(node => node.type === 'cue'); expect(parsed).toHaveLength(3);
 expect(serializeSubtitles('vtt', snapshot, false)).toContain('25:00:00.000 --> 25:00:02.000');
});
test('invalid timing, empty output and Unicode scalars fail clearly', () => {
 const snapshot = exportPreview().snapshot;
 for (const segment of [{ start: 0.0001, end: 0.0004, text: 'collapse' }, { start: 0, end: 5, text: 'beyond duration' }, { start: 0, end: 1, text: '\0' }, { start: 0, end: 1, text: '\ud800' }]) {
  expect(() => serializeSubtitles('vtt', { ...snapshot, segments: [segment] }, false)).toThrow();
 }
 expect(() => serializeSubtitles('srt', { ...snapshot, segments: [] }, false)).toThrow();
});
