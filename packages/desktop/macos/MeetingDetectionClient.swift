import Foundation

struct MeetingDetectionState: Decodable {
    struct Source: Decodable { let app: String; let state: String; let capability: String; let suppressed: Bool }
    let enabled: [String: Bool]
    let sources: [Source]
    let error: String?
    let ownerMeetingId: String?
    let reconnectSeconds: Int?
}

/// Transport retains monotonic sequence and call identity across menu restarts.
/// Reports contain only state enums and random opaque IDs.
final class MeetingDetectionClient {
    private let session: URLSession
    private let defaults: UserDefaults
    private var identities: [String: MeetingSignalIdentity] = [:]
    init(session: URLSession, defaults: UserDefaults = .standard) { self.session = session; self.defaults = defaults }
    func observation(app: String, signal: Bool?, capability: String) -> [String: Any] {
        let callKey = "HeedDetectionCall.\(app)", sequenceKey = "HeedDetectionSequence.\(app)"
        var identity = identities[app] ?? MeetingSignalIdentity(callId: defaults.string(forKey: callKey))
        let callId = identity.observe(signal, now: ProcessInfo.processInfo.systemUptime)
        identities[app] = identity
        defaults.set(identity.callId, forKey: callKey)
        let sequence = defaults.integer(forKey: sequenceKey) + 1
        defaults.set(sequence, forKey: sequenceKey)
        let body: [String: Any] = ["app": app, "detectorId": "native:\(app)", "sequence": sequence,
            "callId": callId as Any? ?? NSNull(), "state": signal == true ? "active" : signal == false ? "inactive" : "unknown", "capability": capability]
        return body
    }
    func report(app: String, signal: Bool?, capability: String) {
        let body = observation(app: app, signal: signal, capability: capability)
        var request = URLRequest(url: URL(string: "http://127.0.0.1:5001/api/meeting-detection/report")!)
        request.httpMethod = "POST"; request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        session.dataTask(with: request).resume()
    }
    func configure(app: String, enabled: Bool, completion: @escaping (Bool) -> Void) {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:5001/api/meeting-detection/settings")!)
        request.httpMethod = "POST"; request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: [app: enabled])
        session.dataTask(with: request) { _, response, _ in DispatchQueue.main.async { completion((response as? HTTPURLResponse)?.statusCode == 200) } }.resume()
    }
}

func meetingDetectionClientSelfTests() throws {
    let suite = "heed-detection-test-\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suite)!
    defer { defaults.removePersistentDomain(forName: suite) }
    let session = URLSession(configuration: .ephemeral)
    defer { session.invalidateAndCancel() }
    let first = MeetingDetectionClient(session: session, defaults: defaults)
    let initial = first.observation(app: "zoom", signal: true, capability: "ready")
    // Recreate both defaults and the client, as a fresh menu launch does.
    let restarted = MeetingDetectionClient(session: session, defaults: UserDefaults(suiteName: suite)!)
    let restored = restarted.observation(app: "zoom", signal: true, capability: "ready")
    precondition(initial["callId"] as? String == restored["callId"] as? String, "Menu restart must retain manual-stop call identity")
    precondition(initial["sequence"] as? Int == 1 && restored["sequence"] as? Int == 2, "Menu restart must advance the persisted sequence")
    precondition(Set(restored.keys) == ["app", "detectorId", "sequence", "callId", "state", "capability"], "Never transmit private meeting content")
}
