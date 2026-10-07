import type { Segment, TranscriptionDiagnostics } from "./speaker.ts";
import type { Session, MeetingMode, AudioCleanup } from "./session.ts";
import type { LanguageCapabilities, LiveCaptureOptions, LiveSpeechLanguage } from "./live-language.ts";

export type CaptureMode = "both" | "mic" | "system";
export type CoordinatorState = "idle" | "starting" | "recording" | "stopping" | "finalizing" | "completed" | "failed";
export interface FinalCapture {
  path: string;
  duration: number;
  language: "en" | "pt";
  model: string;
  liveModel?: string;
  turns: Segment[];
  embeddings?: Record<string, number[]>;
  transcriptionDiagnostics?: TranscriptionDiagnostics;
}
export interface RecordingSnapshot {
  meetingMode?:MeetingMode;
  audioCleanup?:AudioCleanup;
  audioDiscardRequested?:boolean;
  meetingId: string | null;
  state: CoordinatorState;
  revision: number;
  startedAt: number | null;
  path: string | null;
  liveModel?: string;
  /** Effective mode at admission; missing legacy manifests mean enabled. */
  realTimeTranscription?: boolean;
  liveSpeechLanguage?: LiveSpeechLanguage;
  liveOptions?: LiveCaptureOptions;
  seconds: number;
  mode: CaptureMode;
  segments: Segment[];
  speakerNames: Record<string, string>;
  session: Session | null;
  finalCapture?: FinalCapture;
  error: string | null;
  maintenance: boolean;
}

export interface RecordingSettings {
  meetingMode?:MeetingMode;
  activeMeetingMode?:MeetingMode|null;
  liveLanguage?: LiveSpeechLanguage;
  activeLiveLanguage?: LiveSpeechLanguage | null;
  languageCapabilities?: LanguageCapabilities | null;
  liveLanguageState?: "supported" | "unsupported" | "unavailable";
  enabled: boolean;
  activeEnabled: boolean | null;
  appliesTo: "next-recording";
  engineState: "ready" | "unavailable" | "deferred";
}
