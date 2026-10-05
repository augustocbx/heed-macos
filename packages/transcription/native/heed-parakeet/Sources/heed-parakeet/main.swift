import CoreML
import FluidAudio
import Foundation

// heed-parakeet — resident sidecar. Loads Parakeet ASR + FluidAudio diarization ONCE, then
// serves newline-delimited JSON requests on stdin and writes JSON responses on stdout:
//   {"cmd":"transcribe","wav":"/path.wav","language":"es"}  -> {"ok":true,"text":"..."}
//   {"cmd":"diarize","wav":"/path.wav"}                     -> {"ok":true,"speakers":[...],"segments":[...]}
// Keeping models warm in one process is what makes the live path fast (no per-call reload).

func emit(_ obj: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: obj),
        let s = String(data: data, encoding: .utf8) {
        print(s)
    }
    fflush(stdout)
}

func langEnum(_ s: String?) -> Language? {
    guard let s = s, !s.isEmpty, s != "auto" else { return nil }
    return Language(rawValue: s)
}

// --- Role split (KILLER parallelism): run ASR and diarization in SEPARATE sidecar processes so the
// diarizer never blocks the transcriber. HEED_ROLE = "asr" | "diar" | "all" (default "all" = both,
// backward compatible). The ASR process keeps the ANE; the DIAR process can be pinned to a different
// compute unit (GPU/Metal) via HEED_DIAR_CU so ASR and diarization truly run on separate hardware.
let role = ProcessInfo.processInfo.environment["HEED_ROLE"] ?? "all"
let loadASR = (role == "asr" || role == "all")
let loadDiar = (role == "diar" || role == "all")

// --- Load models once (downloads CoreML from HuggingFace on first run — NO gated token) ---
// Two ASR managers, routed by language — measured: neither alone handles both well.
//   English  -> UnifiedAsrManager (one-shot): full long-form English, fastest (~115x).
//   Other    -> AsrManager + melChunkContext:false + dualDecodeArbitration:true + language hint.
var asrEN: UnifiedAsrManager? = nil
var asrML: AsrManager? = nil
if loadASR {
    let asrModels = try await AsrModels.downloadAndLoad(version: .v3)
    let en = UnifiedAsrManager()
    try await en.loadModels()
    asrEN = en
    let ml = AsrManager(config: ASRConfig(melChunkContext: false, dualDecodeArbitration: true))
    try await ml.loadModels(asrModels)
    asrML = ml
}

// clusteringThreshold 0.74 (default 0.7 over-split similar voices, e.g. a 2-host podcast → 3).
// Measured: 0.74 yields the correct count on hard audio AND clean clips; >=0.76 over-merges.
// The Python side also drops residual phantom speakers as a safety net (_filter_spurious_speakers).
var diarizer: DiarizerManager? = nil
if loadDiar {
    // heed re-clusters per-segment embeddings on the Python side, so we can OVER-segment here (lower
    // threshold → more raw speakers, never merge two real voices) and let heed re-fuse. Overridable.
    let ct = Float(ProcessInfo.processInfo.environment["HEED_DIAR_CLUSTER_THRESHOLD"] ?? "") ?? 0.74
    let d = DiarizerManager(config: DiarizerConfig(clusteringThreshold: ct))
    // Compute-unit pin: a dedicated DIAR process runs on GPU/Metal so it doesn't queue behind ASR on
    // the ANE (single-process "all" keeps .all so CoreML schedules both). HEED_DIAR_CU overrides.
    let cuName = ProcessInfo.processInfo.environment["HEED_DIAR_CU"] ?? (role == "diar" ? "gpu" : "all")
    let mlcfg = MLModelConfiguration()
    switch cuName {
    case "gpu": mlcfg.computeUnits = .cpuAndGPU
    case "ane": mlcfg.computeUnits = .cpuAndNeuralEngine
    default: mlcfg.computeUnits = .all
    }
    let diarModels = try await DiarizerModels.downloadIfNeeded(configuration: mlcfg)
    d.initialize(models: diarModels)
    diarizer = d
}

let converter = AudioConverter()

// --- Live STREAMING (Nemotron multilingual): real-time commit/partial ---
// Lazy-loaded on the first stream-start so the resident memory cost is only paid when the
// user actually records. 560ms chunk = lowest latency (~0.5s) with clean Spanish (eval'd).
// Gives a monotonically-growing partial (confirmed prefix never changes) — heed shows it
// directly, no re-render. finish() yields the final text == what was on screen (seamless stop).
// Per-channel ASR streaming sessions (mic + system) that SHARE the ~1.5 GB model weights
// (preloadShared) and only cost ~50 MB of state each — so we can transcribe BOTH the user's mic
// AND the remote/system channel live without doubling memory.
var streamShared: SharedNemotronMultilingualModels? = nil
var streamVariant: String? = nil
var streamMgrs: [String: StreamingNemotronMultilingualAsrManager] = [:]

func ensureStream(_ channel: String, _ language: String) async throws -> StreamingNemotronMultilingualAsrManager {
    let variant = StreamingNemotronMultilingualAsrManager.languageDirectory(for: language)
    if streamShared == nil || streamVariant != variant {
        let dir = try await StreamingNemotronMultilingualAsrManager.downloadVariant(languageCode: language, chunkMs: 560)
        streamShared = try await StreamingNemotronMultilingualAsrManager.preloadShared(from: dir)
        streamVariant = variant
        streamMgrs.removeAll()  // model variant changed → drop per-channel sessions
    }
    if streamMgrs[channel] == nil {
        let m = StreamingNemotronMultilingualAsrManager()
        try await m.loadFromShared(streamShared!)
        streamMgrs[channel] = m
    }
    let m = streamMgrs[channel]!
    await m.reset()
    await m.setLanguage(language)
    return m
}

// --- Live STREAMING diarization (Sortformer): speakers in real time ---
// Lazy-loaded on first diar-start. Streaming addAudio + process gives a growing speaker timeline
// (finalized segments are stable; max 4 speakers). Used live on the SYSTEM channel (the remote
// party); the mic is always "Me". The Python side drops phantom speakers (post-filter).
var diarStream: SortformerDiarizer? = nil

func ensureDiarStream() async throws -> SortformerDiarizer {
    if diarStream == nil {
        // Sortformer v2.1 (fast, ~1.04s confirmation latency): 40% better DER than v2, most robust
        // in meeting scenarios. Explicit preset (SortformerConfig.default already resolves to v2.1
        // via its init default, but we pin it so a future change to `default` can't regress us).
        let cfg = SortformerConfig.fastV2_1
        let d = SortformerDiarizer(config: cfg)
        let models = try await SortformerModels.loadFromHuggingFace(config: cfg, computeUnits: .all)
        d.initialize(models: models)
        diarStream = d
    }
    let d = diarStream!
    d.reset()
    return d
}

emit(["ready": true, "engine": "parakeet-fluidaudio"])

// --- Serve requests ---
while let line = readLine() {
    guard let data = line.data(using: .utf8),
        let req = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
        let cmd = req["cmd"] as? String
    else {
        emit(["ok": false, "error": "bad request"])
        continue
    }
    do {
        switch cmd {
        case "transcribe":
            guard let wav = req["wav"] as? String else {
                emit(["ok": false, "error": "no wav"]); continue
            }
            guard let asrEN = asrEN, let asrML = asrML else {
                emit(["ok": false, "error": "asr not loaded in this role"]); continue
            }
            let samples = try converter.resampleAudioFile(path: wav)
            let lang = langEnum(req["language"] as? String)
            // English (or unspecified) -> Unified one-shot; everything else -> multilingual fix.
            let text: String
            if lang == nil || lang == .english {
                text = try await asrEN.transcribe(samples)
            } else {
                var state = try TdtDecoderState()
                text = try await asrML.transcribe(samples, decoderState: &state, language: lang).text
            }
            emit(["ok": true, "text": text])
        case "transcribe-ts":
            // Like "transcribe" but returns per-token timestamps. ALWAYS uses the multilingual
            // AsrManager (returns ASRResult.tokenTimings) — the fast English UnifiedAsrManager only
            // yields a flat string. This is what the post-stop uses to rebuild a properly segmented,
            // time-stamped transcript instead of stitching live karaoke fragments.
            guard let wav = req["wav"] as? String else {
                emit(["ok": false, "error": "no wav"]); continue
            }
            guard let asrML = asrML else {
                emit(["ok": false, "error": "asr not loaded in this role"]); continue
            }
            let samples = try converter.resampleAudioFile(path: wav)
            let lang = langEnum(req["language"] as? String)  // nil = auto
            var state = try TdtDecoderState()
            let result = try await asrML.transcribe(samples, decoderState: &state, language: lang)
            let tokens: [[String: Any]] = (result.tokenTimings ?? []).map {
                ["t": $0.token, "s": Double($0.startTime), "e": Double($0.endTime)] as [String: Any]
            }
            emit(["ok": true, "text": result.text, "tokens": tokens])
        case "diarize":
            guard let wav = req["wav"] as? String else {
                emit(["ok": false, "error": "no wav"]); continue
            }
            guard let diarizer = diarizer else {
                emit(["ok": false, "error": "diarizer not loaded in this role"]); continue
            }
            let samples = try converter.resampleAudioFile(path: wav)
            let result = try diarizer.performCompleteDiarization(samples, sampleRate: 16000)
            // Per-SEGMENT embedding (the window's WeSpeaker vector, not the cluster centroid) so the
            // Python backbone can re-cluster by cosine — the key to separating speakers FluidAudio merged.
            let segs = result.segments.map {
                ["speaker": $0.speakerId, "start": Double($0.startTimeSeconds), "end": Double($0.endTimeSeconds),
                 "emb": $0.embedding.map { Double($0) }] as [String: Any]
            }
            let speakers = Array(Set(result.segments.map { $0.speakerId })).sorted()
            // Per-speaker 256-dim voice embedding (WeSpeaker v2) for cross-session recognition.
            // Duration-weighted centroid of each speaker's segment embeddings, L2-normalized — the
            // representative voiceprint the Python side matches against ~/.heed-app/voices.json.
            var sums: [String: [Float]] = [:]
            var weights: [String: Float] = [:]
            for s in result.segments {
                let dur = max(0.0, s.endTimeSeconds - s.startTimeSeconds)
                if sums[s.speakerId] == nil { sums[s.speakerId] = [Float](repeating: 0, count: s.embedding.count) }
                for i in 0..<s.embedding.count { sums[s.speakerId]![i] += s.embedding[i] * dur }
                weights[s.speakerId, default: 0] += dur
            }
            var embeddings: [String: [Any]] = [:]
            for (sid, vec) in sums {
                var norm: Float = 0
                for v in vec { norm += v * v }
                norm = norm.squareRoot()
                guard norm > 0 else { continue }
                embeddings[sid] = vec.map { Double($0 / norm) }
            }
            emit(["ok": true, "speakers": speakers, "segments": segs, "embeddings": embeddings])
        case "stream-start":
            // Open/reset a live streaming session for this channel ("mic" | "sys").
            let lang = (req["language"] as? String) ?? "en"
            let channel = (req["channel"] as? String) ?? "mic"
            _ = try await ensureStream(channel, lang)
            emit(["ok": true])
        case "stream-feed":
            // Append the NEW audio segment; return the growing partial (confirmed prefix is stable).
            let channel = (req["channel"] as? String) ?? "mic"
            guard let wav = req["wav"] as? String, let m = streamMgrs[channel] else {
                emit(["ok": false, "error": "no stream session"]); continue
            }
            let samples = try converter.resampleAudioFile(path: wav)
            _ = try await m.process(samples: samples)
            let partial = await m.getPartialTranscript()
            emit(["ok": true, "partial": partial])
        case "stream-finish":
            // End the stream → final text (== what was on screen).
            let channel = (req["channel"] as? String) ?? "mic"
            guard let m = streamMgrs[channel] else { emit(["ok": false, "error": "no stream session"]); continue }
            let text = try await m.finish()
            await m.reset()
            emit(["ok": true, "text": text])
        case "diar-start":
            // Open/reset a live streaming diarization session (system channel).
            _ = try await ensureDiarStream()
            emit(["ok": true])
        case "diar-feed":
            // Append the NEW audio; return the LIVE speaker timeline. FINALIZED segments ONLY —
            // tentative segments are provisional (Sortformer revises them), so including them makes
            // speaker labels flip/mix in real time ("the diarization fails"). With the v2.1 fast
            // config the confirmation latency is ~1s, so finalized shows up fast AND stable. Names
            // for known voices are overlaid live by the periodic recognizer on the server side.
            guard let wav = req["wav"] as? String, let d = diarStream else {
                emit(["ok": false, "error": "no diar session"]); continue
            }
            let samples = try converter.resampleAudioFile(path: wav)
            d.addAudio(samples)
            _ = try d.process()
            let segs = d.timeline.speakers.values.flatMap { $0.finalizedSegments }
                .sorted { $0.startTime < $1.startTime }
                .map { ["speaker": $0.speakerIndex, "start": Double($0.startTime), "end": Double($0.endTime)] as [String: Any] }
            emit(["ok": true, "segments": segs])
        case "diar-finish":
            guard let d = diarStream else { emit(["ok": false, "error": "no diar session"]); continue }
            _ = try d.finalizeSession()
            let segs = d.timeline.speakers.values.flatMap { $0.finalizedSegments }
                .sorted { $0.startTime < $1.startTime }
                .map { ["speaker": $0.speakerIndex, "start": Double($0.startTime), "end": Double($0.endTime)] as [String: Any] }
            d.reset()
            emit(["ok": true, "segments": segs])
        case "ping":
            emit(["ok": true, "pong": true])
        default:
            emit(["ok": false, "error": "unknown cmd: \(cmd)"])
        }
    } catch {
        emit(["ok": false, "error": "\(error)"])
    }
}
