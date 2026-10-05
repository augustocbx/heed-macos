export type CaptureMode = "both" | "mic" | "system";
export function captureChannels(mode: CaptureMode): number { return mode === "both" ? 2 : 1; }
export function nativeCaptureCommand(binary: string, mode: CaptureMode): string[] { return [binary, "--mode", mode]; }
export function nativeRecordingCommand(mode: CaptureMode, output: string): string[] {
 const channels = String(captureChannels(mode));
 return ["ffmpeg", "-y", "-f", "s16le", "-ar", "16000", "-ac", channels, "-i", "pipe:0", "-ar", "16000", "-ac", channels, "-c:a", "pcm_s16le", output];
}
export function verifyNativeHandshake(line: string, mode: CaptureMode): { ready: boolean; permissionNeeded: boolean; error?: string } {
 let data: any;
 try { data = JSON.parse(line); } catch { return { ready: false, permissionNeeded: false, error: "A captura nativa não respondeu corretamente." }; }
 if (data.ready === true && data.sample_rate === 16000 && data.channels === captureChannels(mode) && data.mode === mode) return { ready: true, permissionNeeded: false };
 const error = String(data.error || "Formato incompatível na captura nativa. Atualize o Heed.");
 return { ready: false, permissionNeeded: /-3801|declined|TCC|permission|denied|autoriz|permiss/i.test(error), error };
}

// macOS frameworks may log diagnostics before our structured readiness line.
export function isNativeProtocolLine(line: string): boolean {
 try {
  const data = JSON.parse(line);
  return data !== null && typeof data === "object" && (Object.hasOwn(data, "ready") || Object.hasOwn(data, "error"));
 } catch { return false; }
}
