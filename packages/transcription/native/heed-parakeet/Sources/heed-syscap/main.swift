import AVFoundation
import CoreMedia
import Foundation
import ScreenCaptureKit

// Native, timestamp-aligned 16 kHz PCM: stereo L=mic/R=system for --mode both.
let sampleRate = 16000.0
func emitErr(_ obj: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: obj) {
        FileHandle.standardError.write(data); FileHandle.standardError.write(Data([10]))
    }
}
func fail(_ message: String) { DispatchQueue.global().async { emitErr(["ok": false, "error": message]); exit(1) } }
func hostNow() -> Double { CMTimeGetSeconds(CMClockGetTime(CMClockGetHostTimeClock())) }
struct SourceMetrics {
    var first: Double?; var lastEnd: Double?; var frames = 0; var sourceFrames = 0; var sourceSeconds = 0.0; var largestGap = 0.0; var longestBuffer = 0.0; var maximumDeliveryAge = 0.0
    mutating func add(time: Double, count: Int, inputFrames: Int, inputRate: Double) {
        longestBuffer = max(longestBuffer, Double(inputFrames) / inputRate)
        maximumDeliveryAge = max(maximumDeliveryAge, hostNow() - time)
        if let end = lastEnd { largestGap = max(largestGap, time - end) }
        if first == nil { first = time }; lastEnd = time + Double(inputFrames) / inputRate; frames += count; sourceFrames += inputFrames; sourceSeconds += Double(inputFrames) / inputRate
    }
    func json(origin: Double) -> [String: Any] {
        let span = (lastEnd ?? origin) - (first ?? origin)
        return ["frames": frames, "audio_seconds": Double(frames) / sampleRate, "source_frames": sourceFrames, "source_audio_seconds": sourceSeconds, "timestamp_span_seconds": span,
                "coverage": span > 0 ? sourceSeconds / span : 0,
                "first_offset_seconds": (first ?? origin) - origin, "largest_gap_seconds": largestGap, "maximum_buffer_seconds": longestBuffer, "maximum_delivery_age_seconds": maximumDeliveryAge]
    }
}
final class Capturer: NSObject, SCStreamOutput, SCStreamDelegate {
    let mode: String
    let timeline = DispatchQueue(label: "heed.capture.timeline")
    let microphoneQueue = DispatchQueue(label: "heed.capture.microphone")
    let systemQueue = DispatchQueue(label: "heed.capture.system")
    let outputQueue = DispatchQueue(label: "heed.capture.stdout")
    let microphoneReadiness = MicrophoneReadiness()
    let microphoneSlots = DispatchSemaphore(value: 20)
    let outputSlots = DispatchSemaphore(value: 100)
    let mixer: TimestampMixer
    var stream: SCStream?; var engine: AVAudioEngine?; var timer: DispatchSourceTimer?
    var stopFrame: Int?
    var origin: Double?; var stopping = false; var stopRequested = false
    var configurationObserver: NSObjectProtocol?
    var microphoneConverter: MicrophoneConverter?
    var microphoneClock: ResampledClock?
    var metrics: [String: SourceMetrics] = [:]
    var sourceFormat: [String: Any] = [:]
    init(mode: String) { self.mode = mode; mixer = TimestampMixer(channels: mode == "both" ? 2 : 1) }
    func accept(_ samples: [Int16], source: String, at time: Double, inputFrames: Int? = nil, inputRate: Double = sampleRate, sourceTime: Double? = nil, recordSource: Bool = true) {
        guard time.isFinite else { fail("invalid \(source) capture timestamp"); return }
        timeline.async {
            guard !self.stopping, let origin = self.origin else { return }
            var metric = self.metrics[source] ?? SourceMetrics()
            if recordSource { metric.add(time: sourceTime ?? time, count: samples.count, inputFrames: inputFrames ?? samples.count, inputRate: inputRate) }
            else { metric.frames += samples.count }
            self.metrics[source] = metric
            let ch = self.mode == "both" && source == "sys" ? 1 : 0
            let start = Int(((time - origin) * sampleRate).rounded())
            if !self.mixer.insert(samples, channel: ch, startFrame: start) { fail("\(source) capture exceeded the two-second timeline buffer") }
        }
    }
    func startMicrophone(attempt: Int) throws {
        let e = AVAudioEngine(), input = e.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else { throw NSError(domain: "heed.capture", code: 1, userInfo: [NSLocalizedDescriptionKey: "microphone permission denied or no usable input device"]) }
        let converter = try MicrophoneConverter(source: format), clock = ResampledClock(); engine = e
        microphoneConverter = converter; microphoneClock = clock
        let a = format.streamDescription.pointee
        sourceFormat = ["mic_rate": a.mSampleRate, "mic_channels": a.mChannelsPerFrame, "mic_bits": a.mBitsPerChannel]
        configurationObserver = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: e, queue: .main) { _ in
            guard !self.stopRequested else { return }
            let actual = e.inputNode.outputFormat(forBus: 0)
            let runtime = self.microphoneReadiness.configurationChanged(attempt: attempt, details: ["attempt": attempt, "engine_running": e.isRunning, "actual_rate": actual.sampleRate, "actual_channels": actual.channelCount, "host_time": hostNow()])
            if runtime { fail("microphone device configuration changed during recording; start a new recording") }
        }
        input.installTap(onBus: 0, bufferSize: AVAudioFrameCount(format.sampleRate / 10), format: format) { buffer, time in
            guard self.microphoneReadiness.isCurrent(attempt) else { return }
            guard time.isHostTimeValid else { fail("microphone did not supply a host-clock timestamp"); return }
            guard self.microphoneSlots.wait(timeout: .now()) == .success else { fail("microphone processing queue overloaded"); return }
            guard let owned = copyAudioBuffer(buffer) else { self.microphoneSlots.signal(); fail("cannot copy microphone audio buffer"); return }
            let timestamp = AVAudioTime.seconds(forHostTime: time.hostTime)
            self.microphoneQueue.async {
                defer { self.microphoneSlots.signal() }
                do {
                    guard self.microphoneReadiness.isCurrent(attempt) else { return }
                    if clock.hasDiscontinuity(at: timestamp) {
                        let tail = try converter.flush()
                        self.accept(tail, source: "mic", at: clock.placement(frames: tail.count), recordSource: false)
                        converter.converter.reset(); clock.reset(at: timestamp)
                    }
                    clock.beginInput(at: timestamp, duration: Double(owned.frameLength) / owned.format.sampleRate)
                    let pcm = try converter.convert(owned)
                    self.microphoneReadiness.note(attempt: attempt, time: timestamp, duration: Double(owned.frameLength) / owned.format.sampleRate, outputFrames: pcm.count)
                    self.accept(pcm, source: "mic", at: clock.placement(frames: pcm.count), inputFrames: Int(owned.frameLength), inputRate: owned.format.sampleRate, sourceTime: timestamp)
                }
                catch { fail("microphone conversion failed: \(error)") }
            }
        }
        e.prepare(); try e.start()
    }
    func tearDownMicrophone() {
        if let configurationObserver { NotificationCenter.default.removeObserver(configurationObserver); self.configurationObserver = nil }
        if let engine { engine.stop(); engine.inputNode.removeTap(onBus: 0); self.engine = nil }
    }
    func stabilizeMicrophone() async throws {
        var lastError: Error?
        for _ in 0..<3 {
            let attempt = microphoneReadiness.begin()
            do {
                try startMicrophone(attempt: attempt)
                for _ in 0..<30 {
                    try await Task.sleep(nanoseconds: 50_000_000)
                    let state = microphoneReadiness.snapshot()
                    if state.invalidated || stopRequested { break }
                    if let first = state.first, let end = state.lastEnd, engine?.isRunning == true,
                       end - first >= 0.5, hostNow() - end < 0.2, state.outputFrames >= 8000,
                       microphoneReadiness.markReady(attempt: attempt) {
                        sourceFormat["startup_configuration_changes"] = microphoneReadiness.diagnostics()
                        sourceFormat["startup_mic_frames"] = state.outputFrames
                        return
                    }
                }
            } catch { lastError = error }
            tearDownMicrophone()
            try await Task.sleep(nanoseconds: 250_000_000)
        }
        throw lastError ?? NSError(domain: "heed.capture", code: 3, userInfo: [NSLocalizedDescriptionKey: "microphone did not deliver stable audio after three startup attempts: \(microphoneReadiness.diagnostics())"])
    }
    func start() async {
        do {
            if mode != "mic" {
                let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
                guard let display = content.displays.first else { throw NSError(domain: "heed.capture", code: 2, userInfo: [NSLocalizedDescriptionKey: "no display available for system audio capture"]) }
                let filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
                let config = SCStreamConfiguration()
                config.capturesAudio = true; config.sampleRate = Int(sampleRate); config.channelCount = 1; config.excludesCurrentProcessAudio = true
                let s = SCStream(filter: filter, configuration: config, delegate: self)
                try s.addStreamOutput(self, type: .audio, sampleHandlerQueue: systemQueue)
                stream = s; try await s.startCapture()
            }
            if mode != "system" { try await stabilizeMicrophone() }
            timeline.async {
                let start = hostNow(); self.origin = start
                let timer = DispatchSource.makeTimerSource(queue: self.timeline)
                timer.schedule(deadline: .now() + .milliseconds(500), repeating: .milliseconds(20), leeway: .milliseconds(1))
                timer.setEventHandler {
                    guard !self.stopping else { return }
                    let available = min(self.stopFrame ?? Int.max, Int(max(0, hostNow() - start - 0.5) * sampleRate))
                    while self.mixer.nextFrame + 320 <= available { if !self.write(frames: 320) { return } }
                }
                self.timer = timer; timer.resume()
                var ready: [String: Any] = ["ready": true, "sample_rate": Int(sampleRate), "channels": self.mixer.channels, "mode": self.mode]
                ready.merge(self.sourceFormat) { _, new in new }; emitErr(ready)
            }
        } catch { emitErr(["ok": false, "error": "capture could not start: \(error)"]); exit(1) }
    }
    func write(frames: Int) -> Bool {
        guard outputSlots.wait(timeout: .now()) == .success else { fail("audio output pipe stalled for more than two seconds"); return false }
        let samples = mixer.take(frames: frames), data = samples.withUnsafeBytes { Data($0) }
        outputQueue.async {
            defer { self.outputSlots.signal() }
            do { try FileHandle.standardOutput.write(contentsOf: data) } catch { fail("audio output pipe failed: \(error)") }
        }
        return true
    }
    func stream(_ stream: SCStream, didOutputSampleBuffer buffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio, buffer.isValid else { return }
        guard let format = CMSampleBufferGetFormatDescription(buffer), let description = CMAudioFormatDescriptionGetStreamBasicDescription(format) else { fail("system audio has no PCM format"); return }
        let a = description.pointee
        guard a.mSampleRate == sampleRate, a.mChannelsPerFrame == 1, a.mFormatID == kAudioFormatLinearPCM,
              a.mBitsPerChannel == 32, a.mBytesPerFrame == 4, a.mFormatFlags & kAudioFormatFlagIsFloat != 0 else { fail("system audio format changed unexpectedly"); return }
        let pts = CMSampleBufferGetPresentationTimeStamp(buffer), hostTime: CMTime
        if let clock = stream.synchronizationClock { hostTime = CMSyncConvertTime(pts, from: clock, to: CMClockGetHostTimeClock()) } else { hostTime = pts }
        guard hostTime.isValid, !hostTime.isIndefinite else { fail("invalid system audio clock"); return }
        let count = CMSampleBufferGetNumSamples(buffer)
        do {
            try buffer.withAudioBufferList { list, _ in
                guard list.count == 1, let audio = list.first, let data = audio.mData, Int(audio.mDataByteSize) >= count * 4 else { fail("invalid system PCM buffer"); return }
                let floats = data.bindMemory(to: Float.self, capacity: count)
                var samples = [Int16](repeating: 0, count: count)
                for i in 0..<count { let value = floats[i].isFinite ? max(-1, min(1, floats[i])) : 0; samples[i] = Int16(value * 32767) }
                accept(samples, source: "sys", at: CMTimeGetSeconds(hostTime))
            }
        } catch { fail("cannot read system audio buffer: \(error)") }
    }
    func stream(_ stream: SCStream, didStopWithError error: Error) { fail("system audio stream stopped: \(error)") }
    func stop() {
        guard !stopRequested else { return }; stopRequested = true
        let requestedEnd = hostNow()
        timeline.async { self.stopFrame = self.origin.map { Int(max(0, requestedEnd - $0) * sampleRate) } }
        if let configurationObserver { NotificationCenter.default.removeObserver(configurationObserver) }
        engine?.stop(); if let engine { engine.inputNode.removeTap(onBus: 0) }
        Task {
            if let stream { try? await stream.stopCapture() }
            systemQueue.async {
                self.microphoneQueue.async {
                    if let converter = self.microphoneConverter, let clock = self.microphoneClock {
                        do { let tail = try converter.flush(); self.accept(tail, source: "mic", at: clock.placement(frames: tail.count), recordSource: false) }
                        catch { fail("cannot flush microphone converter: \(error)"); return }
                    }
                self.timeline.async {
                    self.stopping = true; self.timer?.cancel()
                    let end = self.origin.map { Int(max(0, requestedEnd - $0) * sampleRate) } ?? 0
                    while self.mixer.nextFrame < end { if !self.write(frames: min(320, end - self.mixer.nextFrame)) { return } }
                    let origin = self.origin ?? hostNow(), stats = self.metrics.mapValues { $0.json(origin: origin) }
                    self.outputQueue.async {
                        emitErr(["stopped": true, "frames": self.mixer.nextFrame, "duration": Double(self.mixer.nextFrame) / sampleRate,
                                 "sources": stats, "missing_frames": self.mixer.missingFrames, "late_frames": self.mixer.lateFrames]); exit(0)
                    }
                }
                }
            }
        }
    }
}
if CommandLine.arguments.contains("--self-test") {
    do { try runSelfTests(); emitErr(["self_test": true, "ok": true]); exit(0) } catch { emitErr(["self_test": true, "ok": false, "error": String(describing: error)]); exit(1) }
}
let args = CommandLine.arguments
let mode: String
if let index = args.firstIndex(of: "--mode"), index + 1 < args.count { mode = args[index + 1] } else { mode = "system" }
guard ["system", "mic", "both"].contains(mode) else { emitErr(["ok": false, "error": "mode must be system, mic or both"]); exit(1) }
let capturer = Capturer(mode: mode)
var handlers: [DispatchSourceSignal] = []
for sig in [SIGINT, SIGTERM] {
    signal(sig, SIG_IGN); let handler = DispatchSource.makeSignalSource(signal: sig, queue: .main)
    handler.setEventHandler { capturer.stop() }; handler.resume(); handlers.append(handler)
}
Task { await capturer.start() }
RunLoop.main.run()
