import type { LanguageCapabilities, LiveCaptureOptions, LiveSpeechLanguage, PreviewEngine, SpeechPathCapability } from "@heed/shared";
import type { TrxConfig } from "./app-config";
export class LiveLanguageError extends Error {
 readonly status = 409;
 constructor(message:string,public code:"live-language-unsupported"|"live-capabilities-unavailable"){super(message);}
}
export function configuredLiveSpeechLanguage(config:TrxConfig = {}):LiveSpeechLanguage {return config.live_speech_language === "pt" ? "pt" : "en";}
export function recordingSettingsPatch(input:unknown):Partial<TrxConfig> {
 if(!input || typeof input!=="object" || Array.isArray(input))throw Error("Choose valid recording settings.");
 const value=input as Record<string,unknown>,keys=Object.keys(value);
 if(!keys.length || keys.some(key=>!["enabled","liveLanguage","meetingMode","acknowledgeTemporaryAudio"].includes(key)) || ("enabled" in value && typeof value.enabled!=="boolean") || ("liveLanguage" in value && !["en","pt"].includes(value.liveLanguage as string)))throw Error("Choose English or Brazilian Portuguese and a valid real-time setting.");
 if(("meetingMode" in value && !["audio-transcript","transcript-only"].includes(value.meetingMode as string)) || (value.meetingMode === "transcript-only" && value.acknowledgeTemporaryAudio !== true) || ("acknowledgeTemporaryAudio" in value && (value.acknowledgeTemporaryAudio !== true || value.meetingMode !== "transcript-only")))throw Error("Acknowledge temporary local audio processing and loss of playback/retranscription before enabling transcript-only.");
 return {...("meetingMode" in value?{meeting_mode:value.meetingMode as TrxConfig["meeting_mode"]}:{}),...("enabled" in value?{real_time_transcription:value.enabled as boolean}:{}),...("liveLanguage" in value?{live_speech_language:value.liveLanguage as LiveSpeechLanguage}:{})};
}
const models=["tiny","base","small","medium","large-v3","tiny.en","base.en","small.en","medium.en"];
function identity(engine:PreviewEngine,model:string):string|null {
 if(engine==="parakeet")return model==="parakeet-v3"?"parakeet:FluidAudio/parakeet-tdt-0.6b-v3":null;
 if(!models.includes(model))return null;
 return engine==="mlx"?"mlx:mlx-community/whisper-"+model+"-mlx"+(model==="large-v3"?"-4bit":""):"ctranslate2:Systran/faster-whisper-"+model;
}
function validPath(value:any):value is SpeechPathCapability {
 if(!value || !["mlx","ctranslate2","parakeet"].includes(value.engine) || typeof value.model!=="string" || value.modelIdentity!==identity(value.engine,value.model) || !value.modelIdentity || !["chunk","full","stream"].includes(value.mode) || !["loaded","lazy","disabled","unavailable"].includes(value.state))return false;
 if(!Array.isArray(value.supportedLanguages)||value.supportedLanguages.some((language:unknown)=>!["en","pt"].includes(language as string)||(language==="pt"&&value.model.endsWith(".en"))))return false;
 if(!value.automatic || typeof value.automatic.modelSupported!=="boolean" || typeof value.automatic.pipelineAvailable!=="boolean" || value.automatic.offered!==false || value.mixedLanguage!=="unverified" || (value.modelRevision!==null&&typeof value.modelRevision!=="string"))return false;
 return Array.isArray(value.adaptiveModels)&&value.adaptiveModels.length<=20&&value.adaptiveModels.every((candidate:any)=>typeof candidate?.model==="string"&&candidate.modelIdentity===identity(value.engine,candidate.model)&&!!candidate.modelIdentity&&Array.isArray(candidate.languages)&&candidate.languages.every((language:unknown)=>["en","pt"].includes(language as string)&&!(language==="pt"&&candidate.model.endsWith(".en"))));
}
export function validatedLanguageCapabilities(input:unknown):LanguageCapabilities|null {
 const value=input as LanguageCapabilities;
 return value?.schemaVersion===1 && /^[a-f0-9]{64}$/.test(value.capabilityKey) && validPath(value.live) && validPath(value.final)?value:null;
}
export function resolveLiveCaptureOptions(enabled:boolean,requestedLanguage:LiveSpeechLanguage,input:LanguageCapabilities|null):LiveCaptureOptions {
 const empty:LiveCaptureOptions={realTimeTranscription:enabled,requestedLanguage,effectiveLanguage:null,engine:null,mode:null,initialModel:null,initialModelIdentity:null,capabilityKey:null,compatibleModels:[]};
 if(!enabled)return empty;
 const descriptor=validatedLanguageCapabilities(input),path=descriptor?.live;
 if(!descriptor||!path||path.state==="unavailable"||((path.engine==="parakeet")!==(path.mode==="stream")))throw new LiveLanguageError("Live speech capabilities are unavailable. Check the service or choose Record final-only.","live-capabilities-unavailable");
 if(!path.supportedLanguages.includes(requestedLanguage))throw new LiveLanguageError("Requested live speech language is not supported by "+path.engine+" "+path.model+". Choose a supported language or Record final-only.","live-language-unsupported");
 return {...empty,effectiveLanguage:requestedLanguage,engine:path.engine,mode:path.mode,initialModel:path.model,initialModelIdentity:path.modelIdentity,capabilityKey:descriptor.capabilityKey,compatibleModels:[...new Set([path.modelIdentity!,...path.adaptiveModels.filter(value=>value.languages.includes(requestedLanguage)).map(value=>value.modelIdentity)])]};
}
export function rejectRecordingOverrides(body:Record<string,unknown>):void {
 if(!body || typeof body!=="object" || Array.isArray(body) || ["language","liveLanguage","liveSpeechLanguage","realTimeTranscription","enabled","meetingMode"].some(key=>Object.hasOwn(body,key)))throw Object.assign(Error("Save live language and real-time preferences in recording settings before starting."),{status:400});
}
export function previewResultMatches(options:LiveCaptureOptions,value:any):boolean {
 return !!(options.realTimeTranscription&&options.engine&&value?.engine===options.engine&&value?.language===options.effectiveLanguage&&value?.task==="transcribe"&&typeof value?.model==="string"&&value.modelIdentity===identity(options.engine,value.model)&&options.compatibleModels.includes(value.modelIdentity));
}
