import Foundation

/// Policy without network access. `nil` means Slack could not be observed.
struct SlackRecordingPolicy {
    struct Status {
        var recording: Bool
        var processing: Bool
        var pending: Bool
        var starting: Bool
        var ready: Bool
        var clientConnected: Bool
    }

    enum Effect: Equatable {
        case openInterface
        case start(callID: Int)
    }

    var enabled = true
    private(set) var callID = 0
    private var inCall = false
    private var trueSince: TimeInterval?
    private var consumed = false
    private var commandInFlight = false
    private var attempts = 0
    private var retryAfter: TimeInterval = 0
    private var openedAt: TimeInterval?

    /// Call on the same serial executor that receives command results.
    mutating func evaluate(signal: Bool?, status: Status?, now: TimeInterval) -> [Effect] {
        if signal == false {
            inCall = false
            trueSince = nil
            consumed = false
            commandInFlight = false
            attempts = 0
            retryAfter = 0
            openedAt = nil
            return []
        }
        guard signal == true else {
            // An unavailable observation does not end the call, but interrupts
            // start confirmation to avoid triggering with stale evidence.
            trueSince = nil
            return []
        }
        if !inCall {
            inCall = true
            callID += 1
        }
        if let status = status, status.recording || status.starting {
            // Also covers recordings started manually: do not restart after stopping.
            consumed = true
        }
        guard enabled else { trueSince = nil; return [] }
        if trueSince == nil { trueSince = now }
        guard let since = trueSince, now - since >= 3,
              !consumed, !commandInFlight, attempts < 3,
              now >= retryAfter, let status = status,
              !status.recording, !status.processing, !status.pending,
              !status.starting, status.ready else { return [] }
        guard status.clientConnected else {
            if openedAt == nil || now - openedAt! >= 15 {
                openedAt = now
                return [.openInterface]
            }
            return []
        }
        commandInFlight = true
        attempts += 1
        return [.start(callID: callID)]
    }

    /// An accepted HTTP request consumes the call even while its start is queued.
    /// Responses for older calls must not alter a new call.
    mutating func commandCompleted(callID completedID: Int, accepted: Bool, now: TimeInterval) {
        guard inCall, callID == completedID, commandInFlight else { return }
        commandInFlight = false
        if accepted { consumed = true }
        else { retryAfter = now + 5 }
    }
}

/// Runs without Slack, models or permissions through the menu app --self-test mode.
func slackRecordingPolicySelfTest() throws {
    struct Failure: Error { let message: String }
    func check(_ value: Bool, _ message: String) throws {
        if !value { throw Failure(message: message) }
    }
    let ready = SlackRecordingPolicy.Status(recording: false, processing: false,
        pending: false, starting: false, ready: true, clientConnected: true)
    var policy = SlackRecordingPolicy()
    try check(policy.evaluate(signal: true, status: ready, now: 0).isEmpty, "The start signal must be stable")
    try check(policy.evaluate(signal: true, status: ready, now: 2).isEmpty, "Do not start before three seconds")
    try check(policy.evaluate(signal: true, status: ready, now: 3) == [.start(callID: 1)], "Start a confirmed call")
    try check(policy.evaluate(signal: true, status: ready, now: 4).isEmpty, "Do not duplicate an in-flight command")
    policy.commandCompleted(callID: 1, accepted: true, now: 4)
    try check(policy.evaluate(signal: true, status: ready, now: 10).isEmpty, "Do not restart after a manual stop")
    _ = policy.evaluate(signal: nil, status: ready, now: 11)
    try check(policy.evaluate(signal: true, status: ready, now: 20).isEmpty, "An unknown observation must not end the call")
    _ = policy.evaluate(signal: false, status: ready, now: 21)
    _ = policy.evaluate(signal: true, status: ready, now: 22)
    try check(policy.evaluate(signal: true, status: ready, now: 25) == [.start(callID: 2)], "A new call may start")
    policy.commandCompleted(callID: 1, accepted: true, now: 26)
    policy.commandCompleted(callID: 2, accepted: false, now: 26)
    try check(policy.evaluate(signal: true, status: ready, now: 30).isEmpty, "Respect the retry interval")
    try check(policy.evaluate(signal: true, status: ready, now: 31) == [.start(callID: 2)], "Retry a transient failure")
    policy.commandCompleted(callID: 2, accepted: false, now: 32)
    try check(policy.evaluate(signal: true, status: ready, now: 37) == [.start(callID: 2)], "Allow a third attempt")
    policy.commandCompleted(callID: 2, accepted: false, now: 38)
    try check(policy.evaluate(signal: true, status: ready, now: 100).isEmpty, "Limit attempts")

    var waiting = SlackRecordingPolicy()
    var busy = ready
    busy.ready = false
    _ = waiting.evaluate(signal: true, status: busy, now: 0)
    try check(waiting.evaluate(signal: true, status: busy, now: 5).isEmpty, "Wait for the model")
    _ = waiting.evaluate(signal: false, status: busy, now: 6)
    try check(waiting.evaluate(signal: false, status: ready, now: 7).isEmpty, "Do not start a call that ended while waiting")
    var disconnected = ready
    disconnected.clientConnected = false
    _ = waiting.evaluate(signal: true, status: disconnected, now: 8)
    try check(waiting.evaluate(signal: true, status: disconnected, now: 11) == [.openInterface], "Open the interface before starting")
    try check(waiting.evaluate(signal: true, status: disconnected, now: 12).isEmpty, "Do not open multiple tabs")
    try check(waiting.evaluate(signal: true, status: ready, now: 13) == [.start(callID: 2)], "Start only after the interface connects")

    for field in 0..<3 {
        var blocked = ready
        if field == 0 { blocked.processing = true }
        if field == 1 { blocked.pending = true }
        if field == 2 { blocked.starting = true }
        var candidate = SlackRecordingPolicy()
        _ = candidate.evaluate(signal: true, status: blocked, now: 0)
        try check(candidate.evaluate(signal: true, status: blocked, now: 5).isEmpty, "Respect the busy state")
    }
    var manual = SlackRecordingPolicy()
    var recording = ready
    recording.recording = true
    _ = manual.evaluate(signal: true, status: recording, now: 0)
    try check(manual.evaluate(signal: true, status: ready, now: 5).isEmpty, "Respect manual recording")
    var disabled = SlackRecordingPolicy()
    disabled.enabled = false
    _ = disabled.evaluate(signal: true, status: ready, now: 0)
    try check(disabled.evaluate(signal: true, status: ready, now: 5).isEmpty, "Respect the disabled setting")
    disabled.enabled = true
    _ = disabled.evaluate(signal: true, status: ready, now: 6)
    try check(disabled.evaluate(signal: true, status: ready, now: 9) == [.start(callID: 1)], "Confirm the signal again after enabling")
}
