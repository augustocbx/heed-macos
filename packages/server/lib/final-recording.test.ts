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
