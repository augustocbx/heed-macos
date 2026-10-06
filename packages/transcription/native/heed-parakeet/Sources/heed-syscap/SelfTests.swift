import AVFoundation
import Foundation

func runSelfTests() throws {
    runMicrophoneReadinessTests()
    let stereo = TimestampMixer(channels: 2, capacity: 640)
    precondition(stereo.insert([1, 2], channel: 0, startFrame: 0))
    precondition(stereo.insert([3, 4], channel: 0, startFrame: 4))
    precondition(stereo.insert([9, 8, 7, 6, 5, 4], channel: 1, startFrame: 0))
    precondition(stereo.take(frames: 6) == [1, 9, 2, 8, 0, 7, 0, 6, 3, 5, 4, 4], "timestamp gaps must remain silence, preserving both channel timelines")
    precondition(stereo.insert([99, 99], channel: 0, startFrame: 0))
    precondition(stereo.take(frames: 2) == [0, 0, 0, 0], "late samples must not overwrite emitted audio")
    precondition(!stereo.insert([1], channel: 0, startFrame: 648), "future data must be bounded")
    let mono = TimestampMixer(channels: 1, capacity: 8)
    precondition(mono.insert([11, 12, 13], channel: 0, startFrame: -1))
    precondition(mono.take(frames: 2) == [12, 13], "pre-origin samples must be clipped")
    precondition(mono.insert([21, 22], channel: 0, startFrame: 8))
    precondition(mono.take(frames: 8) == [0, 0, 0, 0, 0, 0, 21, 22], "ring wrap must retain exact timestamps")
    // AVAudioConverter emits variable-sized chunks for 100 ms hardware buffers.
    // They must form one continuous output stream, not be placed at each input PTS.
    let hardwareFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48000, channels: 1, interleaved: false)!
    let hardwareConverter = try MicrophoneConverter(source: hardwareFormat)
    let clock = ResampledClock()
    let hardwareTimeline = TimestampMixer(channels: 1, capacity: 130000)
    for block in 0..<80 {
        let buffer = AVAudioPCMBuffer(pcmFormat: hardwareFormat, frameCapacity: 4800)!
        buffer.frameLength = 4800
        clock.beginInput(at: Double(block) / 10, duration: 0.1)
        let pcm = try hardwareConverter.convert(buffer)
        let position = Int((clock.placement(frames: pcm.count) * 16000).rounded())
        precondition(hardwareTimeline.insert(pcm, channel: 0, startFrame: position))
    }
    let tail = try hardwareConverter.flush()
    precondition(hardwareTimeline.insert(tail, channel: 0, startFrame: Int((clock.placement(frames: tail.count) * 16000).rounded())))
    _ = hardwareTimeline.take(frames: 128000)
    precondition(hardwareTimeline.missingFrames[0] <= 1, "100 ms hardware buffers must not create resampler gaps")
    let gapClock = ResampledClock()
    gapClock.beginInput(at: 1, duration: 0.1)
    precondition(gapClock.placement(frames: 1600) == 1)
    precondition(gapClock.hasDiscontinuity(at: 1.3))
    gapClock.reset(at: 1.3)
    gapClock.beginInput(at: 1.3, duration: 0.1)
    precondition(gapClock.placement(frames: 1600) == 1.3, "actual source gaps must remain on the host-clock timeline")
    // Non-integral source/output block ratios must retain speech timing too.
    let irregularRate = 44100.0
    let irregularFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: irregularRate, channels: 1, interleaved: false)!
    let irregularConverter = try MicrophoneConverter(source: irregularFormat)
    let irregularTimeline = TimestampMixer(channels: 1)
    var converted = 0
    for block in 0..<86 {
        let buffer = AVAudioPCMBuffer(pcmFormat: irregularFormat, frameCapacity: 512)!
        buffer.frameLength = 512
        for i in 0..<512 { buffer.floatChannelData![0][i] = Float(0.25 * sin(2 * Double.pi * 440 * Double(block * 512 + i) / irregularRate)) }
        let pcm = try irregularConverter.convert(copyAudioBuffer(buffer)!)
        converted += pcm.count
        precondition(irregularTimeline.insert(pcm, channel: 0, startFrame: Int((Double(block * 512) * 16000 / irregularRate).rounded())))
    }
    let expected = Int(Double(86 * 512) * 16000 / irregularRate)
    precondition(abs(converted - expected) <= 1, "fractional resampling must retain source duration")
    _ = irregularTimeline.take(frames: expected)
    precondition(irregularTimeline.missingFrames[0] < expected / 100, "fractional timestamps must not create large gaps")
    for rate in [16000.0, 48000.0] {
        let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: rate, channels: 1, interleaved: false)!
        let converter = try MicrophoneConverter(source: format)
        let frames = AVAudioFrameCount(rate / 50)
        var output: [Int16] = []
        for block in 0..<50 {
            let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames)!
            buffer.frameLength = frames
            for i in 0..<Int(frames) {
                buffer.floatChannelData![0][i] = Float(0.25 * sin(2 * Double.pi * 440 * Double(block * Int(frames) + i) / rate))
            }
            let owned = copyAudioBuffer(buffer)!
            buffer.floatChannelData![0][0] = 1 // ensure callback ownership is independent
            output.append(contentsOf: try converter.convert(owned))
        }
        precondition(output.count == 16000, "resampling must preserve one second of audio")
        let energy = output.reduce(0.0) { $0 + Double($1) * Double($1) } / Double(output.count)
        precondition(energy > 20_000_000 && energy < 40_000_000, "resampling must preserve tone amplitude")
        let crossings = zip(output, output.dropFirst()).filter { $0 <= 0 && $1 > 0 }.count
        precondition(abs(crossings - 440) <= 2, "resampling must preserve tone pitch")
    }
}

func runMicrophoneReadinessTests() {
    let readiness = MicrophoneReadiness()
    let attempt = readiness.begin()
    readiness.note(attempt: attempt, time: 1, duration: 0.5, outputFrames: 8000)
    let beforeChange = readiness.snapshot()
    let matchingChange: [String: Any] = ["engine_running": true, "format_matches": true, "host_time": 2.0]
    precondition(!readiness.configurationChanged(attempt: attempt, details: matchingChange))
    precondition(!readiness.snapshot().invalidated, "a running engine with the installed format must be allowed to settle")
    precondition(readiness.snapshot().outputFrames == 0, "a startup change must discard previous stability evidence")
    readiness.note(attempt: attempt, time: 1.9, duration: 0.1, outputFrames: 1600)
    precondition(readiness.snapshot().outputFrames == 0, "queued pre-change audio must not qualify a new stability window")
    readiness.note(attempt: attempt, time: 2.1, duration: 0.1, outputFrames: 1600)
    precondition(!readiness.markReady(attempt: attempt, snapshot: beforeChange, now: 2.2), "a stale qualifying snapshot must not mark a reset window ready")
    readiness.note(attempt: attempt, time: 2.2, duration: 0.4, outputFrames: 6400)
    precondition(!readiness.markReady(attempt: attempt, snapshot: beforeChange, now: 2.6), "a configuration change between snapshot and commit must restart qualification")
    precondition(!readiness.markReady(attempt: attempt, snapshot: readiness.snapshot(), now: 3), "stale audio must not qualify startup")
    precondition(readiness.markReady(attempt: attempt, snapshot: readiness.snapshot(), now: 2.6), "fresh stable audio must recover without recreating the engine")
    precondition(readiness.configurationChanged(attempt: attempt, details: matchingChange), "configuration changes during recording must still fail")
    precondition(readiness.snapshot().invalidated)

    for details: [String: Any] in [
        ["engine_running": false, "format_matches": true, "host_time": 2.0],
        ["engine_running": true, "format_matches": false, "host_time": 2.0],
    ] {
        let failed = readiness.begin()
        precondition(!readiness.configurationChanged(attempt: failed, details: details))
        precondition(readiness.snapshot().invalidated, "a stopped engine or incompatible format must require a new attempt")
        _ = readiness.configurationChanged(attempt: failed, details: matchingChange)
        readiness.note(attempt: failed, time: 3, duration: 0.5, outputFrames: 8000)
        precondition(!readiness.markReady(attempt: failed, snapshot: readiness.snapshot(), now: 3.5), "later matching events must not resurrect an invalidated attempt")
    }
    let latest = readiness.begin()
    _ = readiness.configurationChanged(attempt: attempt, details: matchingChange)
    readiness.note(attempt: attempt, time: 3, duration: 0.5, outputFrames: 8000)
    precondition(!readiness.snapshot().invalidated && readiness.snapshot().outputFrames == 0, "old attempts must not affect current readiness")
    readiness.note(attempt: latest, time: 4, duration: 0.5, outputFrames: 8000)
    precondition(readiness.markReady(attempt: latest, snapshot: readiness.snapshot(), now: 4.5))
}
