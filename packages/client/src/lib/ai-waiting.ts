import type { AiWaitingReason } from '@heed/shared';

const messages: Record<AiWaitingReason, string> = {
 retrieval: 'Waiting for the local transcript catalog to become ready.',
 recording: 'Waiting for recording to finish.',
 transcription: 'Waiting for transcription to finish.',
 notes: 'Waiting for notes generation to finish.',
 tasks: 'Waiting for task suggestions to finish.',
 chat: 'Waiting for another chat answer to finish.',
 queued: 'Waiting for local AI resources.',
};

/** Older servers omit the blocker; keep their fallback broad and accurate. */
export function aiWaitingMessage(reason?: AiWaitingReason): string {
 return (reason && messages[reason]) || 'Waiting for recording, transcription or local AI resources.';
}
