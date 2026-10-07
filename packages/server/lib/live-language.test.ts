import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageCapabilities } from "@heed/shared";
import * as language from "./live-language";
import { RecordingCoordinator } from "./recording-coordinator";

const path = {engine:"mlx", model:"base", modelIdentity:"mlx:mlx-community/whisper-base-mlx",modelRevision:null,state:"lazy",supportedLanguages:["en","pt"],automatic:{modelSupported:true,pipelineAvailable:true,offered:false},mixedLanguage:"unverified",mode:"chunk",adaptiveModels:[{model:"tiny",modelIdentity:"mlx:mlx-community/whisper-tiny-mlx",languages:["en","pt"]},{model:"base.en",modelIdentity:"mlx:mlx-community/whisper-base.en-mlx",languages:["en"]}]} as const;
export const capabilities = (): LanguageCapabilities => structuredClone({schemaVersion:1,capabilityKey:"a".repeat(64),live:path,final:{...path,engine:"parakeet",model:"parakeet-v3",modelIdentity:"parakeet:FluidAudio/parakeet-tdt-0.6b-v3",mode:"full",adaptiveModels:[]}}) as unknown as LanguageCapabilities;
test("language defaults independently from interface locale and rejects unsupported new writes", () => {
 expect(language.configuredLiveSpeechLanguage({ui_locale:"pt-BR"})).toBe("en");
 expect(language.configuredLiveSpeechLanguage({live_speech_language:"fr"})).toBe("en");
 expect(language.configuredLiveSpeechLanguage({live_speech_language:"pt",ui_locale:"de"})).toBe("pt");
 expect(language.recordingSettingsPatch({liveLanguage:"pt",enabled:false})).toEqual({live_speech_language:"pt",real_time_transcription:false});
 for(const body of [{}, {liveLanguage:"auto"},{liveLanguage:"pt-BR"},{enabled:1},{liveLanguage:"pt",language:"en"}])expect(()=>language.recordingSettingsPatch(body)).toThrow();
});
test("admission filters PT adaptation and refuses unavailable paths without warming", () => {
 const value=language.resolveLiveCaptureOptions(true,"pt",capabilities());
 expect(value).toMatchObject({requestedLanguage:"pt",effectiveLanguage:"pt",engine:"mlx",initialModel:"base",mode:"chunk",compatibleModels:["mlx:mlx-community/whisper-base-mlx","mlx:mlx-community/whisper-tiny-mlx"]});
 const english=capabilities();english.live.supportedLanguages=["en"];
 expect(()=>language.resolveLiveCaptureOptions(true,"pt",english)).toThrow("not supported");
 expect(()=>language.resolveLiveCaptureOptions(true,"en",null)).toThrow("unavailable");
 expect(language.resolveLiveCaptureOptions(false,"pt",null)).toMatchObject({realTimeTranscription:false,requestedLanguage:"pt",effectiveLanguage:null,engine:null,initialModel:null,compatibleModels:[]});
 for(const input of [{schemaVersion:1}, {...capabilities(),live:{...path,modelIdentity:"/private/custom"}},{...capabilities(),live:{...path,automatic:{offered:true}}}])expect(()=>language.resolveLiveCaptureOptions(true,"pt",input as any)).toThrow();
});
test("runtime words require exact admitted model identity and transcribe language, not the next governor model",()=>{
 const options=language.resolveLiveCaptureOptions(true,"pt",capabilities());
 const result={engine:"mlx",model:"base",modelIdentity:"mlx:mlx-community/whisper-base-mlx",language:"pt",task:"transcribe",gov:{live_model:"tiny"}};
 expect(language.previewResultMatches(options,result)).toBe(true);
 for(const change of [{model:"/private/custom"},{engine:"ctranslate2"},{language:"en"},{task:"translate"},{model:"base.en",modelIdentity:"mlx:mlx-community/whisper-base.en-mlx"}])expect(language.previewResultMatches(options,{...result,...change})).toBe(false);
});
test("pending admission owns capture priority; latest preference resolves once and later settings do not replace it",async()=>{
 const directory=mkdtempSync(join(tmpdir(),"heed-language-admission-"));let release!:()=>void;let preference:"en"|"pt"="en";let starts=0;let received:any;
 const coordinator=new RecordingCoordinator({manifestPath:join(directory,"manifest.json"),resolveLiveOptions:async()=>{await new Promise<void>(resolve=>release=resolve);return language.resolveLiveCaptureOptions(true,preference,capabilities());},adapter:{start:async(_mode,_id,_path,options)=>{starts++;received=options;return {path:join(directory,"synthetic.wav")};},stop:async()=>{throw Error("unused");},finalize:async()=>{throw Error("unused");},save:()=>{throw Error("unused");}}});
 try{const pending=coordinator.start("first","mic");await Bun.sleep(0);expect(coordinator.admissionPending).toBe(true);expect(starts).toBe(0);expect(()=>coordinator.setMaintenance(true,"test")).toThrow();
 await expect(coordinator.start("different-mode","system")).rejects.toThrow("pending");
 preference="pt";release();const accepted=await pending;expect(accepted).toMatchObject({state:"recording",realTimeTranscription:true,liveSpeechLanguage:"pt",liveOptions:{effectiveLanguage:"pt"}});expect(received.effectiveLanguage).toBe("pt");expect(coordinator.admissionPending).toBe(false);
 preference="en";expect((await coordinator.start("first","mic")).liveSpeechLanguage).toBe("pt");expect(starts).toBe(1);
 }finally{rmSync(directory,{recursive:true,force:true});}
});
