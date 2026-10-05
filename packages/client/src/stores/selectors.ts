import { useShallow } from "zustand/react/shallow";
import { useRecordingStore } from "./recording.ts";

/**
 * Atomic selectors for the recording store (TkDodo on Zustand): each hook subscribes to the
 * NARROWEST slice it needs, so a component re-renders only when ITS data changes — not on every
 * unrelated store write. `useShallow` for array/object slices avoids identity-churn re-renders.
 *
 * Prefer these over destructuring the whole store (`const { a, b } = useRecordingStore()`), which
 * subscribes a component to every field.
 */
export const useIsRecording = () => useRecordingStore((s) => s.recording);
export const useIsProcessing = () => useRecordingStore((s) => s.processing);
export const useProcessStep = () => useRecordingStore((s) => s.processStep);
export const useSeconds = () => useRecordingStore((s) => s.seconds);
export const useTranscript = () => useRecordingStore((s) => s.transcript);
export const useLiveQuality = () => useRecordingStore((s) => s.liveQuality);
export const useCurrentSessionId = () => useRecordingStore((s) => s.currentSessionId);

export const useSegments = () => useRecordingStore(useShallow((s) => s.segments));
export const useSpeakers = () => useRecordingStore(useShallow((s) => s.speakers));
