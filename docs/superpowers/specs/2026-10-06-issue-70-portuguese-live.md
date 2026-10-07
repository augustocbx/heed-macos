# Issue #70: Portuguese live speech language and honest capabilities

This specification follows the user-approved recommended design for [issue #70](https://github.com/augustocbx/heed-macos/issues/70). Planning originally used `f13c3da` and now includes merged #63 on product base `298bc324f1b6f7d9764572ca786f57983715de4e`; execution integrates reviewed #7 and any later main changes first. The current #63 implementation is on `feat/issue-63-real-time-transcription` at `f45d101`. This is a docs-only contract, not evidence that Portuguese quality or mixed-language recognition has passed.

## Outcome and boundaries

Persist `live_speech_language:'en'|'pt'` in existing device-local config, default English for missing/invalid legacy data. Reject invalid new writes. This setting is independent of `ui_locale`, #63 real-time enabled/disabled, and the existing final EN/PT automatic-detection pipeline. Selecting Portuguese uses `task:'transcribe'` on a genuinely multilingual live model; no translation, vocabulary substitution or implicit final-language override. Retain four interface locales. French/German speech research (#22), vocabulary assistance (#6), quality infrastructure (#68), model-policy expansion (#67), and cloud services remain separate.

Initial user choices are English and Brazilian Portuguese. Do not add automatic preview selection in this delivery. The matrix may show technical model auto-detection support, explicitly distinct from an offered reliable live-auto feature. Evaluate segment-level mixed speech under both fixed choices, but advertise mixed-language reliability only for a tested exact engine/model path. Successful PT requests, translated UI or a multilingual model card are not measured quality evidence.

## Source and integration contracts

#63 owns the persisted enabled flag, immutable admitted mode, preview configuration sequence, counted leases, owned worker deadlines/cleanup and validated startup-owner/generation handshake. Extend those paths; do not create a parallel capture/resource framework or global unload. #7 owns canonical accepted final source, local monotonic versions/corrections/history and portable provenance. Live segments stay provisional; stop/recovery finalization replaces them using existing speaker reconciliation and #7's trusted source boundary. Text corrections to saved meetings are not undone by a late preview response.

Browser/menu/automatic starts all use the same coordinator and persisted preferences. Remove hardcoded English from `useRecording`, native command bodies, `beginSysRecording`, live chunk/full/stream calls and SSE subscription query. Speech language is never read from UI locale or arbitrary browser/query strings.

## Live/final capability matrix

Expose `languageCapabilities` in Python health and relay it through the existing model/health server response. It is separate from legacy `languages`, which may remain for existing final/file clients. Use these shared types in `packages/shared/types/live-language.ts`:

```ts
type LiveSpeechLanguage = 'en'|'pt';
type PreviewEngine = 'mlx'|'ctranslate2'|'parakeet';
type PreviewMode = 'chunk'|'full'|'stream';
interface SpeechPathCapability {
  engine: PreviewEngine | null; model: string | null;
  modelIdentity: string | null; modelRevision: string | null;
  state: 'loaded'|'lazy'|'disabled'|'unavailable';
  supportedLanguages: LiveSpeechLanguage[];
  automatic: {modelSupported: boolean;pipelineAvailable: boolean;offered: boolean};
  mixedLanguage: 'unverified'|'evaluated-limited'|'verified';
  evaluationId?: string;
  mode: PreviewMode | null;
  adaptiveModels: Array<{model: string;modelIdentity: string;languages: LiveSpeechLanguage[]}>;
}
interface LanguageCapabilities {
  schemaVersion: 1; capabilityKey: string;
  live: SpeechPathCapability; final: SpeechPathCapability;
}
interface LiveCaptureOptions {
  realTimeTranscription: boolean;
  requestedLanguage: LiveSpeechLanguage;
  effectiveLanguage: LiveSpeechLanguage | null;
  engine: PreviewEngine | null; mode: PreviewMode | null;
  initialModel: string | null; initialModelIdentity: string | null;
  capabilityKey: string | null;
  compatibleModels: string[];
}
```

`modelIdentity` contains only registered engine/model/repository identity, no cache path. Include an immutable model revision when actually known; null is truthful otherwise. Key the capability descriptor by its schema/actual registered identity/language support/mode; PID remains the independent service generation. A compatible adaptive tier may change the current descriptor key; active resynchronization checks admitted language/engine and compatible identities rather than requiring its initial model key to equal the current tier. Do not derive live engine identity solely from `active_engine`: on native Macs final is Parakeet while eight-second live chunk ASR is MLX Whisper base.

| Actual path | Offered EN/PT support | Automatic/mixed policy |
| --- | --- | --- |
| Registered MLX multilingual Whisper tiny/base/small/medium/large-v3 repos | EN and PT; current native-Mac live path is MLX base | Model auto capability may be true; offered live-auto false; quality/mixed remains unverified until actual evidence. |
| Registered CTranslate2 multilingual Whisper model | EN and PT | Same conservative distinction; do not advertise tested quality from mocked coverage. |
| English-only Whisper `tiny.en`, `base.en`, `small.en`, `medium.en` | EN only; PT rejected before capture | No PT/auto/mixed promise. `.en` is not a multilingual model. |
| Verified native Parakeet final plus existing EN/PT detector | Final EN/PT automatic pipeline retained; native model itself has no automatic detector | Report detector/pipeline separately from model; final identity is not live identity. |
| A verified native live stream path, if actually selected | Only its explicit registered language set/mode | Do not select it merely to satisfy PT. Test its actual live support separately. |
| Unknown/custom identity or malformed metadata | No inferred live support | Explicit unavailable/final-only choice; no guessed English output or hidden engine switch. |

Use registered engine/model metadata and, for owned preview workers, a bounded ready handshake reporting actual identity. Preserve NativeWorker's deadline, cancellation, ownership and readiness semantics; do not introduce a second transport. MLX's current unknown model-to-small fallback must become an explicit unknown-model error rather than masquerading as the requested model. Engine `.en` support must come from verified model identity; unknown custom folders do not gain PT from a filename assumption. Model cards distinguish English-only and multilingual variants ([Whisper model/language documentation](https://github.com/openai/whisper/blob/main/README.md)); quality still requires local fixture evidence.

## Settings, admission and unsupported-language choice

Extend #63 GET/POST/PATCH `/api/recording/settings` with saved `liveLanguage`, `activeLiveLanguage`, current `languageCapabilities` and `liveLanguageState:'supported'|'unsupported'|'unavailable'`. Bodies may contain either/both `{enabled:boolean,liveLanguage:'en'|'pt'}` with strict validation/unknown-field rejection; save together atomically, preserving config keys. `appliesTo:'next-recording'` and active feedback remain. Saving preferences never selects a different engine or warms a disabled preview.

Start requests accept capture mode/request ID only. Reject provided `language`, `liveLanguage`, `liveSpeechLanguage`, `realTimeTranscription` or `enabled` override fields with 400 and actionable settings feedback, including the legacy native hardcoded language field. Migrate all bundled callers in the same change. #63 previously ignored supplied preview override fields; #70 intentionally makes that rejection explicit and updates those tests. SSE `lang` is not inference authority; reject a supplied query override with 400 after migrating the hook to a query-free URL.

Resolve capability metadata under a bounded two-second health deadline without inference, then reread saved preferences immediately before synchronous transition to `starting`. Expose a read-only coordinator `admissionPending` getter while the existing start operation resolves; include it in audio priority, maintenance/start gating and settings deferral, without inventing a new capture state. Reserve existing capture admission/priority while resolution is pending; concurrent starts share only the compatible admitted command and cannot replace its options. Persist resolved `liveOptions` alongside #63 `realTimeTranscription` and `liveSpeechLanguage`; ensure the boolean mirror equals `liveOptions.realTimeTranscription`. Supply options to the adapter as an explicit fourth argument. Settings changes after transition affect only the next meeting; no live language, mode or engine-family change during capture.

If saved real-time is off, resolve final-only options with effective language/engine/model null, send no live inference/warm-up and retain the saved requested language for later. Do not let missing live capabilities block an otherwise-ready final-only capture. If enabled but PT/EN is unsupported or capability metadata unavailable, reject start before capture with 409 `live-language-unsupported` or `live-capabilities-unavailable`. Show requested language/actual path and explicit “Record final-only” action. This action saves `{enabled:false}` through the authoritative settings route, clearly states it remains off for future meetings, then sends a normal start request. Browser and native menu use the same two-call sequence; no one-shot request override or silent setting change. A concurrent preference change between those calls is resolved truthfully at admission, never forced through.

The native menu exposes saved English/Portuguese choice independently of Interface language, labels active effective language, and offers the explicit final-only action only when applicable. Recording status/SSE/recovery preserve requested/effective language and admitted engine/mode/model identity. Legacy manifests default missing speech language to English and preserve #63 false; backend restart recovers audio/finalizes rather than reclassifying preview as final.

## Runtime adaptation and service restart

Keep effective language and engine family immutable. Existing governor adaptation may switch among compatible same-family models supporting the admitted language. Do not globally disable/pin the governor; retain capture priority, cadence adaptation and preview release. Filter adaptive/fallback candidates by admitted language and registered same-family identities; an English-only model cannot satisfy PT. No hidden MLX↔CTranslate2/native engine fallback. Report the actual model used for each chunk, separately from the next model chosen by the governor; offsets/timestamps are preserved across the swap, with no duplicated/skipped accepted chunk window. `initialModel` remains admission metadata, while existing `liveModel`/quality status reports runtime actual model.

Both microphone/system calls use the same effective language and `task:'transcribe'` for ASR. Native stream start fixes that language for its stream lifetime. Unsupported paths/disabled mode issue zero ASR/diar/filter jobs. A compatible model failing after admission reports unavailable live preview while capture/finalization continue; it does not substitute English, change engine, clear all previous segments or corrupt final source.

Extend #63 validated owner startup/compact capture status handshake to include live options. Python-only restart must suppress premature warm-up until validated active options exist and restore the admitted language/engine family before live work. Continue dead-owned-worker recreation and governor recovery within the same compatible model policy. Off-active/next-on and on-PT-active/next-EN or off preference remain unchanged across restart. Maintain bounded cancellation/deadlines and shared final resources.

## Evidence and capability claims

Implement a reproducible actual-engine harness with explicit existing interpreter/native binary and isolated app/work directories. Set Homebrew FFmpeg PATH explicitly on remote Macs; no environment install/symlinks or installed-app config changes. Verify actual live engine/model/task/language per result, not just health's final engine. Run multilingual MLX PT on both Air M1 and Pro M4 Pro; English-only/unsupported cases have controlled rejection coverage, not fabricated actual quality results.

Fixture manifest records license/provenance/SHA-256, ground-truth language spans/text/times/names/technical terms. Include EN/PT speech, short utterances (1–3 seconds), silence, human regional accents where a licensed small sample is available, authored names/technical vocabulary, alternating turns, within-turn code switching, dual-channel and overlap. TTS does not prove human accent diversity; disclose unavailable cohorts. Use at least three runs per fixed language/fixture on each Mac, recording warm/cold context, exact model/dependency/hardware identities and variability.

Report WER/CER per annotated language and mixed spans, name/term exact preservation, missed/duplicated/translated spans, timestamp error, first preview and p50/p95 latency, sampled CPU/RSS/pressure/swap, audio hash/duration and final text/speakers. WER normalization case-folds/removes punctuation but preserves accents; CER counts Unicode code points after documented NFC comparison (including accents), never mutating output. Publish content-free metric JSON plus licensed synthetic expected transcripts separately. Silence must not produce usable hallucinated text. Evaluate final processing independently; current whole-meeting EN/PT detector does not establish segment-level auto language support.

Claims default to unverified. A documented evaluation ID may establish a limited claim only for its exact model/revision/cohort. To advertise mixed-language reliability, require no silent translation, no missed/duplicated annotated language spans and at least 90% annotated EN/PT span-language preservation on both Macs across the three runs; report WER/CER/latency limitations too. Failing evaluation remains a truthful evaluated-limited/unverified label; do not lower this claim gate afterward to make a test pass. Fixed PT selection can ship with measured limitations without advertising reliable auto/mixed behavior. Model quality beyond tested cohorts is never guaranteed.

Acceptance maps to engine matrix/selection (unit+Python/health/UI/native), genuine PT/final-only (#63 production capture/zero-job tests plus actual MLX), accent/name/vocabulary/code-switch evaluation (annotated real-engine metrics), provisional/final timing/speakers/corrections (coordinator/recovery/#7 integration), and resource preference/priority (owned lifecycle/preemption/paired resource report). Actual engine replay is not physical capture/installed-app proof. This issue does not reopen unrelated release/permission acceptance gates, and this docs-only spec reports no completed evaluation.
