import { taskPrompt } from './inference/prompts';
import type { Session } from '../../shared/types';
import { generateLocalStructured, type LocalStructuredInput } from './ollama-notes';
import { taskSegments } from './meeting-tasks';
export function generateTaskSuggestions(session:Session,signal:AbortSignal,options:Omit<LocalStructuredInput,'system'|'data'|'signal'>):Promise<string>{
 return generateLocalStructured({...options,signal,...taskPrompt(session.language,taskSegments(session))});
}
