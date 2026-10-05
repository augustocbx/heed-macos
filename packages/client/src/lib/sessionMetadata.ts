import type { Session } from '@heed/shared';
export function sessionLanguageLabel(language: string) {
 return language === 'en' ? 'English' : language === 'pt' || language === 'pt-BR' ? 'Portuguese (Brazil)' : language || '';
}
export function transcriptionModelLabel(model: string) {
 if (model === 'parakeet-v3' || model === 'parakeet') return 'Parakeet v3';
 if (['tiny','base','small','medium','large-v3'].includes(model)) return `Whisper ${model}`;
 return model;
}
export function sessionModelLabels(session: Session) {
 return [session.liveModel ? `Live: ${transcriptionModelLabel(session.liveModel)}` : null,
  session.transcriptionModel ? `Final: ${transcriptionModelLabel(session.transcriptionModel)}` : null].filter(Boolean).join(' · ');
}
