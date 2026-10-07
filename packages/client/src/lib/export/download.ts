import type { MeetingExportArtifact } from './worker';
export function downloadMeetingExport(artifact: MeetingExportArtifact, title: string): () => void {
 const filename = title.replace(/[\u0000-\u001f\u007f]/g, '').replace(/[\\/:*?"<>|]+/g, '-').replace(/^[.\s-]+|[.\s-]+$/g, '').slice(0, 180) || 'meeting';
 const blob = new Blob([new Uint8Array(artifact.bytes)], { type: artifact.mime });
 const url = URL.createObjectURL(blob); let revoked = false;
 const cleanup = () => { if (!revoked) { URL.revokeObjectURL(url); revoked = true; } };
 const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${filename}.${artifact.extension}`;
 try { document.body.appendChild(anchor); anchor.click(); } catch (error) { cleanup(); throw error; } finally { anchor.remove(); }
 return cleanup;
}
