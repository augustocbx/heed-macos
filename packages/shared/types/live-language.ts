export type LiveSpeechLanguage = "en" | "pt";
export type PreviewEngine = "mlx" | "ctranslate2" | "parakeet";
export type PreviewMode = "chunk" | "full" | "stream";
export interface SpeechPathCapability {
 engine: PreviewEngine | null; model: string | null;
 modelIdentity: string | null; modelRevision: string | null;
 state: "loaded" | "lazy" | "disabled" | "unavailable";
 supportedLanguages: LiveSpeechLanguage[];
 automatic: { modelSupported: boolean; pipelineAvailable: boolean; offered: boolean };
 mixedLanguage: "unverified" | "evaluated-limited" | "verified";
 evaluationId?: string;
 vocabulary?:{status:"recognition-context"|"unsupported";interface:"initial_prompt"|null;scope:"first-window"|null};
 mode: PreviewMode | null;
 adaptiveModels: Array<{ model: string; modelIdentity: string; languages: LiveSpeechLanguage[] }>;
}
export interface LanguageCapabilities {
 schemaVersion: 1; capabilityKey: string;
 live: SpeechPathCapability; final: SpeechPathCapability;
}
export interface LiveCaptureOptions {
 realTimeTranscription: boolean; requestedLanguage: LiveSpeechLanguage;
 effectiveLanguage: LiveSpeechLanguage | null;
 engine: PreviewEngine | null; mode: PreviewMode | null;
 initialModel: string | null; initialModelIdentity: string | null;
 capabilityKey: string | null; compatibleModels: string[];
}
