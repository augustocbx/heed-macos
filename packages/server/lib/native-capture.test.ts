import { describe, expect, test } from "bun:test";
import { nativeCaptureCommand, nativeRecordingCommand, verifyNativeHandshake, isNativeProtocolLine } from "./native-capture";
describe("unified native capture", () => {
 for (const mode of ["both", "mic", "system"] as const) {
  test(`preserves the format and a single input for ${mode}`, () => {
   const channels = mode === "both" ? 2 : 1;
   expect(nativeCaptureCommand("/capture", mode)).toEqual(["/capture", "--mode", mode]);
   const args = nativeRecordingCommand(mode, "/audio.wav");
   expect(args.filter(arg => arg === "-i")).toHaveLength(1);
   expect(args).not.toContain("avfoundation");
   expect(args[args.indexOf("-ac") + 1]).toBe(String(channels));
   expect(verifyNativeHandshake(JSON.stringify({ ready: true, sample_rate: 16000, channels, mode }), mode).ready).toBe(true);
  });
 }
 test("rejects partial capture or an incompatible format", () => {
  expect(verifyNativeHandshake('{"ready":true}', "both").ready).toBe(false);
  expect(verifyNativeHandshake('{"ready":true,"sample_rate":16000,"channels":1,"mode":"system"}', "both").ready).toBe(false);
 });
 test("reports denied permission without starting", () => {
  expect(verifyNativeHandshake('{"error":"Microphone permission denied"}', "mic")).toEqual({ ready: false, permissionNeeded: true, error: "Microphone permission denied" });
  expect(verifyNativeHandshake("", "both").ready).toBe(false);
 });
});

test("ignores system warnings and metadata before readiness", () => {
 expect(isNativeProtocolLine("AVAudioEngine warning: format changed")).toBe(false);
 expect(isNativeProtocolLine('{"device":"Built-in Microphone"}')).toBe(false);
 expect(isNativeProtocolLine("null")).toBe(false);
 expect(isNativeProtocolLine('{"ready":true,"mode":"both","channels":2,"sample_rate":16000}')).toBe(true);
 expect(isNativeProtocolLine('{"error":"permission denied"}')).toBe(true);
});
