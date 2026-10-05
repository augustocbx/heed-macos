import Foundation

// Converter output is a continuous stream; its chunks need not match input buffer sizes.
// Source discontinuities are detected independently, so real gaps aren't compressed.
final class ResampledClock {
    private var anchor: Double?
    private var expectedSourceEnd: Double?
    private var outputFrames = 0
    func hasDiscontinuity(at time: Double) -> Bool {
        guard let expectedSourceEnd else { return false }
        return abs(time - expectedSourceEnd) > 0.002
    }
    func reset(at time: Double) { anchor = time; expectedSourceEnd = time; outputFrames = 0 }
    func beginInput(at time: Double, duration: Double) {
        if anchor == nil { reset(at: time) }
        expectedSourceEnd = (expectedSourceEnd ?? time) + duration
    }
    func placement(frames: Int) -> Double {
        let time = (anchor ?? 0) + Double(outputFrames) / 16000
        outputFrames += frames
        return time
    }
}
