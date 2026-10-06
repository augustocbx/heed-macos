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
    private let endpoints: ServiceEndpoints?
    private var identities: [String: MeetingSignalIdentity] = [:]
    init(session: URLSession, defaults: UserDefaults = .standard, endpoints: ServiceEndpoints? = try? ServiceEndpoints.load()) {
        self.session = session; self.defaults = defaults; self.endpoints = endpoints
    }
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
        guard let endpoints = endpoints else { return }
        let body = observation(app: app, signal: signal, capability: capability)
        var request = URLRequest(url: endpoints.apiURL("/api/meeting-detection/report"))
        request.httpMethod = "POST"; request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        endpoints.perform(session: session, request: request) { _, _, _ in }
    }
    func configure(app: String, enabled: Bool, completion: @escaping (Bool) -> Void) {
        guard let endpoints = endpoints else { completion(false); return }
        var request = URLRequest(url: endpoints.apiURL("/api/meeting-detection/settings"))
        request.httpMethod = "POST"; request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: [app: enabled])
        endpoints.perform(session: session, request: request) { _, response, _ in DispatchQueue.main.async { completion((response as? HTTPURLResponse)?.statusCode == 200) } }
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
    try meetingDetectionForeignServiceSelfTest()
}

private final class ForeignMeetingServiceProtocol: URLProtocol {
    static var requests: [URLRequest] = []
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.requests.append(request)
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data("{\"service\":\"foreign-api\",\"protocolVersion\":1,\"pid\":123,\"checkoutRoot\":\"/synthetic/foreign\"}".utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

private func meetingDetectionForeignServiceSelfTest() throws {
    ForeignMeetingServiceProtocol.requests = []
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [ForeignMeetingServiceProtocol.self]
    let session = URLSession(configuration: configuration)
    defer { session.invalidateAndCancel() }
    let suite = "heed-foreign-detection-\(UUID().uuidString)", defaults = UserDefaults(suiteName: suite)!
    defer { defaults.removePersistentDomain(forName: suite) }
    let client = MeetingDetectionClient(session: session, defaults: defaults,
        endpoints: ServiceEndpoints(apiPort: 48100, uiPort: 48101, transcriptionPort: 48102, checkoutRoot: "/synthetic/heed"))
    var accepted: Bool?
    client.configure(app: "zoom", enabled: true) { accepted = $0 }
    let deadline = Date().addingTimeInterval(3)
    while accepted == nil && Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.01)) }
    precondition(accepted == false, "A foreign service cannot acknowledge detection configuration")
    precondition(!ForeignMeetingServiceProtocol.requests.isEmpty && ForeignMeetingServiceProtocol.requests.allSatisfy { $0.httpMethod == "GET" && $0.url?.path == "/.well-known/heed-service" }, "Never send detection reports or settings to an unverified service")
}
