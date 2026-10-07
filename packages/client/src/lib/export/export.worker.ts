import type { MeetingExportPreview } from '@heed/shared';
import type { MeetingExportArtifact } from './worker';
import { assertExportSize } from './bounds';
import { serializeSubtitles } from './subtitles';

async function localFont(url: string): Promise<Uint8Array> {
 const response = await fetch(url); if (!response.ok) throw Error('The bundled PDF font is unavailable. Please retry.');
 return new Uint8Array(await response.arrayBuffer());
}
self.onmessage = async event => {
 const { jobId, preview } = event.data as { jobId: string; preview: MeetingExportPreview };
 try {
  assertExportSize(preview);
  let artifact: MeetingExportArtifact;
  if (preview.format === 'pdf') {
   const [{ renderMeetingPdf }, regular, bold] = await Promise.all([
    import('./pdf'), localFont(new URL('./fonts/NotoSans-Regular.ttf', import.meta.url).href), localFont(new URL('./fonts/NotoSans-Bold.ttf', import.meta.url).href),
   ]);
   artifact = { bytes: await renderMeetingPdf(preview, { regular, bold }), mime: 'application/pdf', extension: 'pdf', snapshotKey: preview.snapshot.snapshotKey };
  } else {
   artifact = { bytes: new TextEncoder().encode(serializeSubtitles(preview.format, preview.snapshot, preview.selection.speakers)),
    mime: preview.format === 'srt' ? 'application/x-subrip' : 'text/vtt', extension: preview.format, snapshotKey: preview.snapshot.snapshotKey };
  }
  self.postMessage({ jobId, artifact }, { transfer: [artifact.bytes.buffer] });
 } catch (error) { self.postMessage({ jobId, error: error instanceof Error ? error.message : 'Could not generate export.' }); }
};
