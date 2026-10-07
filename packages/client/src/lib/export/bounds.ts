import type { MeetingExportPreview } from '@heed/shared';
/** Match the server's selected deterministic payload bound, excluding clock/review/availability. */
export function assertExportSize(preview: MeetingExportPreview): void {
 const { generatedAt: _date, snapshotKey: _key, ...snapshot } = preview.snapshot;
 const { transcript, notes, taskIds, speakers, timestamps } = preview.selection;
 const payload = { format: preview.format, selection: { transcript, notes, taskIds: [...taskIds].sort(), speakers, timestamps }, snapshot };
 if (new TextEncoder().encode(JSON.stringify(payload)).byteLength > 16_000_000) throw Error('Selected export exceeds 16,000,000 UTF-8 bytes. Choose a smaller scope.');
}
