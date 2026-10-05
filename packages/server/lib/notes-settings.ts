import type { AutomaticNotesSettings, NotesLanguagePolicy } from "@heed/shared";

const LANGUAGES: NotesLanguagePolicy[] = ["meeting", "en", "pt", "fr", "de"];
const SAFE_ID = /^[a-zA-Z0-9_-]{1,180}$/;

export function automaticNotesSettings(config: Record<string, unknown>): AutomaticNotesSettings {
 const stored = config.automatic_notes as Partial<AutomaticNotesSettings> | undefined;
 return {
  enabled: stored?.enabled === true,
  templateId: typeof stored?.templateId === "string" && SAFE_ID.test(stored.templateId) ? stored.templateId : "general",
  model: typeof stored?.model === "string" && stored.model.trim() ? stored.model : null,
  language: LANGUAGES.includes(stored?.language as NotesLanguagePolicy) ? stored!.language! : "meeting",
 };
}

export function validateNotesSettings(value: unknown, template: {id:string;prompt:string} | null, installedLocalModels: string[]): AutomaticNotesSettings {
 const settings = value as AutomaticNotesSettings;
 if (!settings || typeof settings.enabled !== "boolean" || typeof settings.templateId !== "string" || !SAFE_ID.test(settings.templateId)
  || !(settings.model === null || (typeof settings.model === "string" && settings.model.trim())) || !LANGUAGES.includes(settings.language)) {
  throw new Error("Choose a template, local notes model, and output language.");
 }
 if (settings.enabled && (!template?.prompt?.trim() || template.id !== settings.templateId)) throw new Error("The selected notes template is unavailable.");
 if (settings.enabled && (!settings.model || !installedLocalModels.includes(settings.model))) throw new Error("Choose an installed local notes model before enabling automatic notes.");
 return {enabled:settings.enabled,templateId:settings.templateId,model:settings.model,language:settings.language};
}
