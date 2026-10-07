import { expect, test } from "bun:test";
import { finalRecordingResult, recordingFinalizationOptions } from "./final-recording";
test("full pass uses detected Portuguese and preserves audio timing and speaker name", () => {
 const result = finalRecordingResult({ finalized:true, duration:732.3, language:"pt", model:"parakeet-v3", turns:[{speaker:"Augusto",channel:"mic",text:" Bom dia ",start:1.5,end:2.3}], auto_named:{Augusto:{name:"Augusto",score:0.9}} }, "audio.wav");
 expect(result.metadata.language).toBe("pt");
 expect(result.duration).toBe(732.3);
 expect(result.segments[0]).toMatchObject({speaker:"Augusto",start:1.5,end:2.3,text:"Bom dia",auto:true});
 expect(result.files.wav).toBe("audio.wav");
});
test("failed, incomplete or unsupported-language finals are never accepted", () => {
 for (const response of [null, {turns:[]}, {finalized:false,language:"en",turns:[]}, {finalized:true,language:"es",turns:[]}]) expect(() => finalRecordingResult(response,"audio.wav")).toThrow();
});
test("silent completed recording remains an empty final rather than live text", () => {
 expect(finalRecordingResult({finalized:true,language:"en",turns:[]},"audio.wav").wordCount).toBe(0);
});
test("automatic recovery detects language while a manual override stays request scoped", () => {
 expect(recordingFinalizationOptions("en",null)).toEqual({language:"auto",final_model:"parakeet-v3",manual:false});
 expect(recordingFinalizationOptions("pt","large-v3")).toEqual({language:"pt",final_model:"large-v3",manual:true});
 expect(recordingFinalizationOptions("auto","base")).toEqual({language:"auto",final_model:"base",manual:true});
 expect(() => recordingFinalizationOptions("es","base")).toThrow();
 expect(() => recordingFinalizationOptions("auto","download-other-model")).toThrow();
});

const channelDiagnostic = () => ({rawRms:0.04,rawPeak:0.8,cleanedRms:0.03,asrSegments:3,diarizationSegments:1,usableEmbeddings:1,retainedSegments:2,discardedSegments:1,discardReasons:{"echo-text-and-time":1},fallbackSegments:1,diarizationFailed:false});
const finalDiagnostics = () => ({version:1 as const,channels:{mic:channelDiagnostic(),sys:channelDiagnostic()},aecApplied:true,warnings:["microphone-attribution-fallback" as const]});

test("final conversion preserves fallback attribution and content-free channel diagnostics", () => {
 const diagnostics=finalDiagnostics();
 const result=finalRecordingResult({finalized:true,language:"pt",turns:[{speaker:"You",channel:"mic",text:"Speech",start:1,end:2,attribution:"fallback"}],diagnostics},"audio.wav");
 expect(result).toMatchObject({transcriptionDiagnostics:diagnostics,segments:[{speaker:"You",attribution:"fallback"}]});
 expect(finalRecordingResult({finalized:true,language:"en",turns:[]},"audio.wav")).not.toHaveProperty("transcriptionDiagnostics");
});

test("diagnostic allowlist strips content, private worker payloads and unknown reason codes", () => {
 const diagnostics=finalDiagnostics();
 const payload={...diagnostics,transcript:"private transcript",workerError:"private path",channels:{...diagnostics.channels,mic:{...diagnostics.channels.mic,text:"private speech",embedding:[1,2],discardReasons:{"echo-text-and-time":1,"private reason":2}},privateChannel:{audio:"private audio"}},warnings:[...diagnostics.warnings,"private worker failure"]};
 const result=finalRecordingResult({finalized:true,language:"en",turns:[],diagnostics:payload},"audio.wav");
 expect(result.transcriptionDiagnostics).toEqual(diagnostics);
 expect(JSON.stringify(result.transcriptionDiagnostics)).not.toContain("private");
});

test("malformed or future diagnostic payloads do not break final transcription", () => {
 const diagnostic=finalDiagnostics();
 for(const diagnostics of [null,[],{...diagnostic,version:2},{...diagnostic,channels:{}},{...diagnostic,aecApplied:"yes"},
  {...diagnostic,channels:{mic:{...diagnostic.channels.mic,rawRms:-1}}},
  {...diagnostic,channels:{mic:{...diagnostic.channels.mic,rawPeak:Infinity}}},
  {...diagnostic,channels:{mic:{...diagnostic.channels.mic,asrSegments:1.2}}},
  {...diagnostic,channels:{mic:{...diagnostic.channels.mic,diarizationFailed:"worker failure"}}},
  {...diagnostic,channels:{mic:{...diagnostic.channels.mic,discardReasons:{"echo-text-and-time":-1}}}}]) {
  const result=finalRecordingResult({finalized:true,language:"en",turns:[],diagnostics},"audio.wav");
  expect(result.success).toBe(true);expect(result).not.toHaveProperty("transcriptionDiagnostics");
 }
});

test("single-channel diagnostics remain supported and arbitrary attribution cannot enter segments", () => {
 const diagnostics=finalDiagnostics();
 const microphoneOnly={...diagnostics,channels:{mic:diagnostics.channels.mic},aecApplied:false};
 const result=finalRecordingResult({finalized:true,language:"en",diagnostics:microphoneOnly,turns:[{speaker:"You",channel:"mic",text:"Speech",start:0,end:1,attribution:"private worker detail"}]},"audio.wav");
 expect(result.transcriptionDiagnostics).toEqual(microphoneOnly);
 expect(result.segments[0]).not.toHaveProperty("attribution");
});
