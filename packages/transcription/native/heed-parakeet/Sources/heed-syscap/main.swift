import AVFoundation
import CoreMedia
import Foundation
import ScreenCaptureKit

// heed-syscap — captures SYSTEM audio via ScreenCaptureKit and writes raw PCM
// (s16le, 16 kHz, mono) to stdout. heed (Node) merges it with the mic into the
// L/R stereo WAV the rest of the pipeline already expects.
//
// Why this exists: BlackHole only captures system audio if the user re-routes their
// macOS output INTO it (a Multi-Output Device). ScreenCaptureKit taps the system mix
// DIRECTLY from the OS — no driver, no routing, one Screen-Recording permission click,
// regardless of which output device is selected. This is the zero-friction path.
//
// Protocol (so Node can react without parsing audio):
//   stderr, one JSON line: {"ready":true,"sample_rate":16000,"channels":1}
//                       or {"ok":false,"error":"..."}  then exit 1
//   stdout: continuous raw s16le PCM. Killed by the parent (SIGINT/SIGTERM) on stop.

let SAMPLE_RATE = 16000.0

func emitErr(_ obj: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: obj),
        var s = String(data: data, encoding: .utf8) {
        s += "\n"
        FileHandle.standardError.write(s.data(using: .utf8)!)
    }
}

final class Capturer: NSObject, SCStreamOutput, SCStreamDelegate {
    var stream: SCStream?
    let stdout = FileHandle.standardOutput

    func start() async {
        do {
            // Pick a display to attach to (SCK requires a content filter; audio is system-wide).
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
            guard let display = content.displays.first else {
                emitErr(["ok": false, "error": "no display available for capture"]) ; exit(1)
            }
            let filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])

            let config = SCStreamConfiguration()
            config.capturesAudio = true
            config.sampleRate = Int(SAMPLE_RATE)   // ask SCK for 16 kHz directly
            config.channelCount = 1                // mono
            config.excludesCurrentProcessAudio = true   // never capture heed's own sound
            // Minimal video — SCK needs a video config even when we only want audio.
            config.width = 2
            config.height = 2
            config.minimumFrameInterval = CMTime(value: 1, timescale: 1)

            let s = SCStream(filter: filter, configuration: config, delegate: self)
            try s.addStreamOutput(self, type: .audio, sampleHandlerQueue: DispatchQueue(label: "heed.syscap.audio"))
            try await s.startCapture()
            self.stream = s
            emitErr(["ready": true, "sample_rate": Int(SAMPLE_RATE), "channels": 1])
        } catch {
            // Permission denied / unsupported → Node falls back to the BlackHole path.
            emitErr(["ok": false, "error": "\(error)"]) ; exit(1)
        }
    }

    // Receives system-audio buffers; converts Float32 → Int16 and writes to stdout.
    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio, sampleBuffer.isValid else { return }
        do {
            try sampleBuffer.withAudioBufferList { abl, _ in
                guard let buf = abl.first, let mData = buf.mData else { return }
                let floatCount = Int(buf.mDataByteSize) / MemoryLayout<Float>.size
                let floats = mData.bindMemory(to: Float.self, capacity: floatCount)
                var pcm = Data(capacity: floatCount * 2)
                for i in 0..<floatCount {
                    let clamped = max(-1.0, min(1.0, floats[i]))
                    var s = Int16(clamped * 32767.0)
                    withUnsafeBytes(of: &s) { pcm.append(contentsOf: $0) }
                }
                if !pcm.isEmpty { stdout.write(pcm) }
            }
        } catch { /* drop a bad buffer rather than crash the capture */ }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        emitErr(["ok": false, "error": "stream stopped: \(error)"]) ; exit(1)
    }
}

let cap = Capturer()
Task { await cap.start() }
// Clean exit when the parent stops us.
signal(SIGINT) { _ in exit(0) }
signal(SIGTERM) { _ in exit(0) }
RunLoop.main.run()
