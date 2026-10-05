import AVFoundation
import Foundation

final class MicrophoneConverter {
    let target = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16000, channels: 1, interleaved: false)!
    let converter: AVAudioConverter
    var framesWritten = 0
    init(source: AVAudioFormat) throws {
        guard let c = AVAudioConverter(from: source, to: target) else {
            throw NSError(domain: "miccap", code: 1, userInfo: [NSLocalizedDescriptionKey: "unsupported microphone format"])
        }
        converter = c
        converter.primeMethod = .none
    }
    func convert(_ source: AVAudioPCMBuffer) throws -> [Int16] {
        let capacity = AVAudioFrameCount(ceil(Double(source.frameLength) * 16000 / source.format.sampleRate) + 128)
        let output = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity)!
        var supplied = false
        var error: NSError?
        let status = converter.convert(to: output, error: &error) { _, state in
            if supplied { state.pointee = .noDataNow; return nil }
            supplied = true
            state.pointee = .haveData
            return source
        }
        if let error { throw error }
        if status == .error { throw NSError(domain: "miccap", code: 2) }
        return encode(output)
    }
    func flush() throws -> [Int16] {
        var result: [Int16] = []
        for _ in 0..<16 {
            let output = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: 4096)!
            var error: NSError?
            let status = converter.convert(to: output, error: &error) { _, state in
                state.pointee = .endOfStream; return nil
            }
            if let error { throw error }
            if status == .error { throw NSError(domain: "miccap", code: 3) }
            result.append(contentsOf: encode(output))
            if status == .endOfStream || output.frameLength == 0 { return result }
        }
        throw NSError(domain: "miccap", code: 4, userInfo: [NSLocalizedDescriptionKey: "microphone converter tail did not finish"])
    }
    private func encode(_ output: AVAudioPCMBuffer) -> [Int16] {
        guard let floats = output.floatChannelData?[0] else { return [] }
        var samples = [Int16](repeating: 0, count: Int(output.frameLength))
        for i in samples.indices {
            let sample = floats[i].isFinite ? max(-1, min(1, floats[i])) : 0
            samples[i] = Int16(sample * 32767)
        }
        framesWritten += samples.count
        return samples
    }
}

func copyAudioBuffer(_ original: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
    guard let copy = AVAudioPCMBuffer(pcmFormat: original.format, frameCapacity: original.frameLength) else { return nil }
    copy.frameLength = original.frameLength
    let source = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: original.audioBufferList))
    let destination = UnsafeMutableAudioBufferListPointer(copy.mutableAudioBufferList)
    guard source.count == destination.count else { return nil }
    for i in 0..<source.count {
        guard let src = source[i].mData, let dst = destination[i].mData,
              source[i].mDataByteSize <= destination[i].mDataByteSize else { return nil }
        memcpy(dst, src, Int(source[i].mDataByteSize))
        destination[i].mDataByteSize = source[i].mDataByteSize
    }
    return copy
}

