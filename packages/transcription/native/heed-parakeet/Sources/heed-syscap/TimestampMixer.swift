import Foundation

// Called only on the timeline queue. Absolute frame tags prevent stale ring data from leaking.
final class TimestampMixer {
    let channels: Int
    let capacity: Int
    private var samples: [[Int16]]
    private var tags: [[Int]]
    private(set) var nextFrame = 0
    private(set) var missingFrames: [Int]
    private(set) var lateFrames: [Int]
    init(channels: Int, capacity: Int = 32000) {
        self.channels = channels; self.capacity = capacity
        samples = Array(repeating: Array(repeating: 0, count: capacity), count: channels)
        tags = Array(repeating: Array(repeating: -1, count: capacity), count: channels)
        missingFrames = Array(repeating: 0, count: channels)
        lateFrames = Array(repeating: 0, count: channels)
    }
    func insert(_ input: [Int16], channel: Int, startFrame: Int) -> Bool {
        guard channel >= 0 && channel < channels else { return false }
        guard startFrame + input.count <= nextFrame + capacity else { return false }
        for i in input.indices {
            let frame = startFrame + i
            if frame < nextFrame { lateFrames[channel] += 1; continue }
            let slot = frame % capacity
            samples[channel][slot] = input[i]; tags[channel][slot] = frame
        }
        return true
    }
    func take(frames: Int) -> [Int16] {
        var result = [Int16](repeating: 0, count: frames * channels)
        for offset in 0..<frames {
            let frame = nextFrame + offset, slot = frame % capacity
            for ch in 0..<channels {
                if tags[ch][slot] == frame { result[offset * channels + ch] = samples[ch][slot] }
                else { missingFrames[ch] += 1 }
                tags[ch][slot] = -1
            }
        }
        nextFrame += frames
        return result
    }
}
