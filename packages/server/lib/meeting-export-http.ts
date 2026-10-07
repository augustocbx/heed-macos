import type { Session } from '../../shared/types/session';
import type { TaskView } from '../../shared/types/tasks';
import type { MeetingExportPreviewInput, MeetingExportValidateInput } from '../../shared/types/meeting-export';
import { createMeetingExportPreview, validateMeetingExportPreview, validateMeetingExportInput, MeetingExportError, MEETING_EXPORT_LIMIT } from './meeting-export';

export interface MeetingExportReaders {
 session: (id: string) => Session | null;
 tasks: (id: string) => TaskView[];
 now: () => string;
}
const headers = { 'Cache-Control': 'no-store' };
async function boundedBody(request: Request): Promise<unknown> {
 if (Number(request.headers.get('content-length')) > MEETING_EXPORT_LIMIT) throw new MeetingExportError('Export request exceeds 16,000,000 bytes.', 413, 'request-too-large');
 const reader = request.body?.getReader();
 if (!reader) throw new MeetingExportError('An export request body is required.', 400, 'invalid-body');
 const chunks: Uint8Array[] = [];
 let size = 0;
 try {
  while (true) {
   const next = await reader.read(); if (next.done) break;
   size += next.value.byteLength;
   if (size > MEETING_EXPORT_LIMIT) { await reader.cancel(); throw new MeetingExportError('Export request exceeds 16,000,000 bytes.', 413, 'request-too-large'); }
   chunks.push(next.value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
 } catch (error) {
  if (error instanceof MeetingExportError) throw error;
  throw new MeetingExportError('Export request must contain valid UTF-8 JSON.', 400, 'invalid-body');
 } finally { reader.releaseLock(); }
}
export async function meetingExportResponse(request: Request, readers: MeetingExportReaders, allowed: boolean): Promise<Response | null> {
 const match = /^\/api\/sessions\/([^/]+)\/export-(preview|validate)$/.exec(new URL(request.url).pathname);
 if (!match) return null;
 if (!allowed) return Response.json({ error: 'Local export access denied.', code: 'access-denied' }, { status: 403, headers });
 if (request.method !== 'POST') return new Response(null, { status: 405, headers: { ...headers, Allow: 'POST' } });
 try {
  let id: string; try { id = decodeURIComponent(match[1]!); } catch { throw new MeetingExportError('Invalid meeting ID.', 400, 'invalid-id'); }
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) throw new MeetingExportError('Invalid meeting ID.', 400, 'invalid-id');
  const validating = match[2] === 'validate', input = await boundedBody(request);
  validateMeetingExportInput(input, validating);
  // Capture source and accepted tasks without yielding, so both describe one local read point.
  const session = readers.session(id);
  if (!session) throw new MeetingExportError('Meeting not found.', 404, 'meeting-not-found');
  const tasks = readers.tasks(id);
  const output = validating ? validateMeetingExportPreview(session, tasks, input as MeetingExportValidateInput)
   : createMeetingExportPreview(session, tasks, input as MeetingExportPreviewInput, readers.now());
  return Response.json(output, { headers });
 } catch (error) {
  if (error instanceof MeetingExportError) return Response.json({ error: error.message, code: error.code }, { status: error.status, headers });
  return Response.json({ error: 'Could not read export content. Please retry.', code: 'export-unavailable' }, { status: 503, headers });
 }
}
