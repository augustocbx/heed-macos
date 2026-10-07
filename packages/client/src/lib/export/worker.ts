import type { MeetingExportPreview } from '@heed/shared';
import { assertExportSize } from './bounds';
export interface MeetingExportArtifact {
 bytes: Uint8Array;
 mime: 'application/pdf' | 'application/x-subrip' | 'text/vtt';
 extension: 'pdf' | 'srt' | 'vtt';
 snapshotKey: string;
}
export function startMeetingExport(preview: MeetingExportPreview): { result: Promise<MeetingExportArtifact>; cancel: () => void } {
 assertExportSize(preview);
 const frozen = structuredClone(preview), jobId = crypto.randomUUID();
 const worker = new Worker(new URL('./export.worker.ts', import.meta.url), { type: 'module' });
 let finish!: (value: MeetingExportArtifact | Error | DOMException) => void, settled = false;
 const result = new Promise<MeetingExportArtifact>((resolve, reject) => {
  finish = value => {
   if (settled) return; settled = true; worker.terminate(); worker.onmessage = null; worker.onerror = null;
   if (value instanceof Error || value instanceof DOMException) reject(value); else resolve(value);
  };
 });
 worker.onmessage = event => {
  const message = event.data;
  if (message?.jobId !== jobId) return;
  if (typeof message.error === 'string') finish(new Error(message.error));
  else if (message.artifact?.snapshotKey !== frozen.snapshot.snapshotKey || !(message.artifact?.bytes instanceof Uint8Array) || message.artifact?.extension !== frozen.format ||
   message.artifact?.mime !== ({ pdf: 'application/pdf', srt: 'application/x-subrip', vtt: 'text/vtt' }[frozen.format])) finish(new Error('Export worker returned an invalid artifact.'));
  else finish(message.artifact);
 };
 worker.onerror = () => finish(new Error('Could not generate the export. Please retry.'));
 try { worker.postMessage({ jobId, preview: frozen }); } catch (error) { finish(error instanceof Error ? error : new Error('Could not start export.')); }
 return { result, cancel: () => finish(new DOMException('Export cancelled.', 'AbortError')) };
}
