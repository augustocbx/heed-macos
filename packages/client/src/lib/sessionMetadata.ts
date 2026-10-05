import { tr } from "./i18n.ts";
import type { Session } from '@heed/shared';
export function sessionLanguageLabel(language: string) {
 return language === 'en' ? tr("English") : language === 'pt' || language === 'pt-BR' ? tr("Portuguese (Brazil)") : language || '';
}
export function transcriptionModelLabel(model: string) {
 if (model === 'parakeet-v3' || model === 'parakeet') return 'Parakeet v3';
 if (['tiny','base','small','medium','large-v3'].includes(model)) return `Whisper ${model}`;
 return model;
}
export function sessionModelLabels(session: Session) {
 return [session.liveModel ? tr("Live: {model}", undefined, {model:transcriptionModelLabel(session.liveModel)}) : null,
  session.transcriptionModel ? tr("Final: {model}", undefined, {model:transcriptionModelLabel(session.transcriptionModel)}) : null].filter(Boolean).join(' · ');
}
