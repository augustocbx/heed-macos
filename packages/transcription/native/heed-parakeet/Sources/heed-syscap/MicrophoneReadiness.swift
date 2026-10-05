import Foundation

// Startup profile transitions must settle while real converted buffers are arriving.
// The small lock protects metadata only; capture never waits on conversion or stdout.
final class MicrophoneReadiness {
    struct Snapshot {
        let attempt: Int
        let invalidated: Bool
        let ready: Bool
        let outputFrames: Int
        let first: Double?
        let lastEnd: Double?
    }
    private let lock = NSLock()
    private var attempt = 0
    private var invalidated = false
    private var ready = false
    private var frames = 0
    private var first: Double?
    private var lastEnd: Double?
    private var events: [[String: Any]] = []
    func begin() -> Int {
        lock.lock(); defer { lock.unlock() }
        attempt += 1; invalidated = false; ready = false; frames = 0; first = nil; lastEnd = nil
        return attempt
    }
    func isCurrent(_ value: Int) -> Bool {
        lock.lock(); defer { lock.unlock() }; return attempt == value
    }
    func note(attempt value: Int, time: Double, duration: Double, outputFrames: Int) {
        lock.lock(); defer { lock.unlock() }
        guard attempt == value, !invalidated, outputFrames > 0 else { return }
        if first == nil { first = time }; lastEnd = time + duration; frames += outputFrames
    }
    // Returns true only when a configuration change invalidates an already-ready recording.
    func configurationChanged(attempt value: Int, details: [String: Any]) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard attempt == value else { return false }
        events.append(details); invalidated = true
        return ready
    }
    func snapshot() -> Snapshot {
        lock.lock(); defer { lock.unlock() }
        return Snapshot(attempt: attempt, invalidated: invalidated, ready: ready, outputFrames: frames, first: first, lastEnd: lastEnd)
    }
    func markReady(attempt value: Int) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard attempt == value, !invalidated, frames > 0 else { return false }
        ready = true; return true
    }
    func diagnostics() -> [[String: Any]] { lock.lock(); defer { lock.unlock() }; return events }
}
