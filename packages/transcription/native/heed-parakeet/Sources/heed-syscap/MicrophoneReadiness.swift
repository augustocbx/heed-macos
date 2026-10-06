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
        let generation: Int
    }
    private let lock = NSLock()
    private var attempt = 0
    private var invalidated = false
    private var ready = false
    private var frames = 0
    private var first: Double?
    private var lastEnd: Double?
    private var generation = 0
    private var notBefore: Double?
    private var events: [[String: Any]] = []
    func begin() -> Int {
        lock.lock(); defer { lock.unlock() }
        attempt += 1; invalidated = false; ready = false; frames = 0; first = nil; lastEnd = nil; notBefore = nil
        return attempt
    }
    func isCurrent(_ value: Int) -> Bool {
        lock.lock(); defer { lock.unlock() }; return attempt == value
    }
    func note(attempt value: Int, time: Double, duration: Double, outputFrames: Int) {
        lock.lock(); defer { lock.unlock() }
        guard attempt == value, !invalidated, outputFrames > 0 else { return }
        if let notBefore, time < notBefore { return }
        if first == nil { first = time }; lastEnd = time + duration; frames += outputFrames
    }
    // Returns true only when a configuration change invalidates an already-ready recording.
    func configurationChanged(attempt value: Int, details: [String: Any]) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard attempt == value else { return false }
        events.append(details)
        // A healthy input can receive an output/profile notification during Bluetooth startup.
        // Require a fresh stability window without releasing the working default input route.
        if !ready, !invalidated, details["engine_running"] as? Bool == true,
           details["format_matches"] as? Bool == true,
           let time = details["host_time"] as? Double, time.isFinite {
            generation += 1; frames = 0; first = nil; lastEnd = nil; notBefore = time
        } else { invalidated = true }
        return ready
    }
    func snapshot() -> Snapshot {
        lock.lock(); defer { lock.unlock() }
        return Snapshot(attempt: attempt, invalidated: invalidated, ready: ready, outputFrames: frames, first: first, lastEnd: lastEnd, generation: generation)
    }
    func markReady(attempt value: Int, snapshot: Snapshot, now: Double) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard attempt == value, snapshot.attempt == value, generation == snapshot.generation,
              !invalidated, frames >= 8000, let first, let lastEnd,
              lastEnd - first >= 0.5, now - lastEnd < 0.2 else { return false }
        ready = true; return true
    }
    func diagnostics() -> [[String: Any]] { lock.lock(); defer { lock.unlock() }; return events }
}
