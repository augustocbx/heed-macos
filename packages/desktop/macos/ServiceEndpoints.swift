import Foundation
import Darwin

private struct ServicePortDefaults: Decodable {
    let api: Int
    let ui: Int
    let transcription: Int
    let forbiddenRanges: [[Int]]
}

private struct HeedServiceIdentity: Decodable {
    let service: String
    let protocolVersion: Int
    let checkoutRoot: String
    let pid: Int
}

enum ServiceEndpointError: Error, LocalizedError {
    case invalidConfiguration
    case unverifiedService
    var errorDescription: String? { "Service unavailable — open the interface" }
}

private final class ServiceRedirectPolicy: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

/// Installed app resources and validated overrides are the only source of service addresses.
struct ServiceEndpoints {
    let apiPort: Int
    let uiPort: Int
    let transcriptionPort: Int
    let checkoutRoot: String
    var apiOrigin: String { "http://127.0.0.1:\(apiPort)" }
    var uiOrigin: String { "http://127.0.0.1:\(uiPort)" }

    func launchEnvironment(base: [String: String]) -> [String: String] {
        var environment = base
        environment["PORT"] = String(apiPort)
        environment["HEED_API_PORT"] = String(apiPort)
        environment["HEED_UI_PORT"] = String(uiPort)
        environment["HEED_TRANSCRIPTION_PORT"] = String(transcriptionPort)
        return environment
    }

    static func session(configuration: URLSessionConfiguration = .ephemeral) -> URLSession {
        configuration.timeoutIntervalForRequest = 6
        return URLSession(configuration: configuration, delegate: ServiceRedirectPolicy(), delegateQueue: nil)
    }

    static func resolve(configData: Data, checkoutRoot: String, environment: [String: String]) throws -> ServiceEndpoints {
        guard configData.count <= 16384, checkoutRoot.hasPrefix("/"), !checkoutRoot.isEmpty,
              let defaults = try? JSONDecoder().decode(ServicePortDefaults.self, from: configData),
              !defaults.forbiddenRanges.isEmpty,
              defaults.forbiddenRanges.allSatisfy({ $0.count == 2 && $0[0] > 0 && $0[0] <= $0[1] && $0[1] <= 65535 }) else {
            throw ServiceEndpointError.invalidConfiguration
        }
        func port(_ raw: String) throws -> Int {
            guard !raw.isEmpty, raw.utf8.allSatisfy({ (48...57).contains($0) }), let value = Int(raw),
                  (1...65535).contains(value), !defaults.forbiddenRanges.contains(where: { $0[0] <= value && value <= $0[1] }) else {
                throw ServiceEndpointError.invalidConfiguration
            }
            return value
        }
        if let api = environment["HEED_API_PORT"], let legacy = environment["PORT"], try port(api) != port(legacy) {
            throw ServiceEndpointError.invalidConfiguration
        }
        let api = try port(environment["HEED_API_PORT"] ?? environment["PORT"] ?? String(defaults.api))
        let ui = try port(environment["HEED_UI_PORT"] ?? String(defaults.ui))
        let transcription = try port(environment["HEED_TRANSCRIPTION_PORT"] ?? String(defaults.transcription))
        guard Set([api, ui, transcription]).count == 3 else { throw ServiceEndpointError.invalidConfiguration }
        // Foundation removes /private aliases on macOS; the Bun/Python identity
        // uses POSIX realpath. Resolve existing roots with the same operation.
        let root: String
        if let canonical = realpath(checkoutRoot, nil) {
            root = String(cString: canonical); free(canonical)
        } else {
            root = URL(fileURLWithPath: checkoutRoot).standardizedFileURL.path
        }
        return ServiceEndpoints(apiPort: api, uiPort: ui, transcriptionPort: transcription, checkoutRoot: root)
    }

    static func load(environment: [String: String] = ProcessInfo.processInfo.environment) throws -> ServiceEndpoints {
        if let resource = Bundle.main.url(forResource: "service-ports", withExtension: "json"),
           let rootResource = Bundle.main.url(forResource: "heed-root", withExtension: "txt") {
            let root = try String(contentsOf: rootResource, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
            return try resolve(configData: Data(contentsOf: resource), checkoutRoot: root, environment: environment)
        }
        // Compile-source fallback is for CLI development/self-tests only; installed apps fail closed.
        guard !Bundle.main.bundleURL.path.hasSuffix(".app") else { throw ServiceEndpointError.invalidConfiguration }
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        return try resolve(configData: Data(contentsOf: root.appendingPathComponent("config/service-ports.json")), checkoutRoot: root.path, environment: environment)
    }

    func apiURL(_ path: String) -> URL { URL(string: apiOrigin + path)! }
    func interfaceURL(settings: Bool = false) -> URL { URL(string: uiOrigin + (settings ? "/#settings" : "/"))! }

    func verifiesIdentity(_ data: Data?, service: String = "heed-api") -> Bool {
        guard let data = data, data.count <= 262144, let identity = try? JSONDecoder().decode(HeedServiceIdentity.self, from: data) else { return false }
        return identity.service == service && identity.protocolVersion == 1 && identity.checkoutRoot == checkoutRoot && identity.pid > 0
    }

    private func identityRequest(service: String) -> URLRequest {
        var request = URLRequest(url: URL(string: (service == "heed-ui" ? uiOrigin : apiOrigin) + "/.well-known/heed-service")!)
        request.timeoutInterval = 6
        return request
    }

    func verify(session: URLSession, service: String = "heed-api", completion: @escaping (Bool) -> Void) {
        let request = identityRequest(service: service)
        session.dataTask(with: request) { data, response, _ in
            completion((response as? HTTPURLResponse)?.statusCode == 200 && response?.url == request.url && self.verifiesIdentity(data, service: service))
        }.resume()
    }

    /// No command, permission, folder path or detector report is sent before a fresh identity check.
    func perform(session: URLSession, request: URLRequest, completion: @escaping (Data?, URLResponse?, Error?) -> Void) {
        guard request.url?.scheme == "http", request.url?.host == "127.0.0.1", request.url?.port == apiPort,
              request.url?.user == nil, request.url?.password == nil else {
            completion(nil, nil, ServiceEndpointError.unverifiedService); return
        }
        func execute() {
            session.dataTask(with: request) { data, response, error in
                guard response?.url == request.url else { completion(nil, nil, error ?? ServiceEndpointError.unverifiedService); return }
                if request.url?.path == "/api/desktop/control/status" && !self.verifiesIdentity(data) {
                    completion(nil, nil, ServiceEndpointError.unverifiedService); return
                }
                completion(data, response, error)
            }.resume()
        }
        if request.url?.path == "/api/desktop/control/status" && (request.httpMethod ?? "GET") == "GET" { execute(); return }
        verify(session: session) { valid in
            guard valid else { completion(nil, nil, ServiceEndpointError.unverifiedService); return }
            execute()
        }
    }
}

func serviceEndpointsSelfTests() throws {
    let config = Data("{\"api\":48100,\"ui\":48101,\"transcription\":48102,\"forbiddenRanges\":[[3000,3999],[5000,5999],[7000,7999],[8000,8999]]}".utf8)
    let endpoints = try ServiceEndpoints.resolve(configData: config, checkoutRoot: "/synthetic/heed", environment: [:])
    precondition(endpoints.apiURL("/api/desktop/control/status").absoluteString == "http://127.0.0.1:48100/api/desktop/control/status")
    precondition(endpoints.interfaceURL(settings: true).absoluteString == "http://127.0.0.1:48101/#settings")
    for value in ["", "0", "-1", "65536", "5001", "5170", "3000", "3999", "7000", "7999", "8000", "8999", "48100x", " 48100", "48e3"] {
        precondition((try? ServiceEndpoints.resolve(configData: config, checkoutRoot: "/synthetic/heed", environment: ["HEED_API_PORT": value])) == nil)
    }
    for environment in [["HEED_API_PORT": "48103", "PORT": "48104"], ["HEED_UI_PORT": "48100"], ["HEED_TRANSCRIPTION_PORT": "48101"]] {
        precondition((try? ServiceEndpoints.resolve(configData: config, checkoutRoot: "/synthetic/heed", environment: environment)) == nil)
    }
    let overridden = try ServiceEndpoints.resolve(configData: config, checkoutRoot: "/synthetic/heed", environment: ["HEED_API_PORT": "48103", "PORT": "48103", "HEED_UI_PORT": "48104", "HEED_TRANSCRIPTION_PORT": "48105"])
    precondition(overridden.apiPort == 48103 && overridden.uiPort == 48104 && overridden.transcriptionPort == 48105)
    let inherited = overridden.launchEnvironment(base: ["PORT":"5001"])
    precondition(inherited["PORT"] == "48103", "Resolved bootstrap API port must replace an unrelated inherited alias")
    let existingRoot = FileManager.default.temporaryDirectory.appendingPathComponent("heed-endpoints-" + UUID().uuidString)
    try FileManager.default.createDirectory(at: existingRoot, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: existingRoot) }
    let actualRoot = existingRoot.path.hasPrefix("/private/") ? existingRoot.path : "/private" + existingRoot.path
    let actual = try ServiceEndpoints.resolve(configData:config, checkoutRoot:actualRoot, environment:[:])
    precondition(actual.checkoutRoot == actualRoot, "Existing root identity must match Python/Bun POSIX realpath")
    precondition(overridden.launchEnvironment(base: ["LANG": "en_US.UTF-8"]) == ["LANG": "en_US.UTF-8", "PORT":"48103", "HEED_API_PORT": "48103", "HEED_UI_PORT": "48104", "HEED_TRANSCRIPTION_PORT": "48105"], "Finder-launched services must inherit the bundled configured ports")
    for body in ["{}", "{\"service\":\"foreign\",\"protocolVersion\":1,\"checkoutRoot\":\"/synthetic/heed\",\"pid\":1}", "{\"service\":\"heed-api\",\"protocolVersion\":2,\"checkoutRoot\":\"/synthetic/heed\",\"pid\":1}", "{\"service\":\"heed-api\",\"protocolVersion\":1,\"checkoutRoot\":\"/other\",\"pid\":1}", "{\"service\":\"heed-api\",\"protocolVersion\":1,\"checkoutRoot\":\"/synthetic/heed\",\"pid\":0}"] {
        precondition(!endpoints.verifiesIdentity(Data(body.utf8)))
    }
    let identity = Data("{\"service\":\"heed-api\",\"protocolVersion\":1,\"checkoutRoot\":\"/synthetic/heed\",\"pid\":123}".utf8)
    precondition(endpoints.verifiesIdentity(identity))
    precondition(!endpoints.verifiesIdentity(identity, service: "heed-ui"))
    try serviceEndpointsTransportSelfTests(endpoints)
}

private final class EndpointFixtureProtocol: URLProtocol {
    static var requests: [URLRequest] = []
    static var service = "heed-api"
    static var root = "/synthetic/heed"
    static var pid = 42
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.requests.append(request)
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
        let body = try! JSONSerialization.data(withJSONObject: ["service": Self.service, "protocolVersion": 1, "checkoutRoot": Self.root, "pid": Self.pid])
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: body)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

private func serviceEndpointsTransportSelfTests(_ endpoints: ServiceEndpoints) throws {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [EndpointFixtureProtocol.self]
    let session = ServiceEndpoints.session(configuration: configuration)
    defer { session.invalidateAndCancel() }
    func awaitReply(_ read: () -> Bool) {
        let deadline = Date().addingTimeInterval(3)
        while !read() && Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.01)) }
        precondition(read(), "Native identity transport must complete")
    }
    for mode in ["foreign", "wrong-root", "zero-pid"] {
        EndpointFixtureProtocol.requests = []
        EndpointFixtureProtocol.service = mode == "foreign" ? "foreign-api" : "heed-api"
        EndpointFixtureProtocol.root = mode == "wrong-root" ? "/another/checkout" : "/synthetic/heed"
        EndpointFixtureProtocol.pid = mode == "zero-pid" ? 0 : 42
        for path in ["/api/desktop/control/commands", "/api/desktop/permissions/report", "/api/meeting-detection/report", "/api/smb", "/api/ui-locale"] {
            var request = URLRequest(url: endpoints.apiURL(path)); request.httpMethod = "POST"
            request.httpBody = Data("synthetic-private-payload".utf8)
            var done = false, rejected = false
            endpoints.perform(session: session, request: request) { data, response, error in
                DispatchQueue.main.async { rejected = data == nil && response == nil && error != nil; done = true }
            }
            awaitReply { done }; precondition(rejected)
        }
        precondition(EndpointFixtureProtocol.requests.count == 5 && EndpointFixtureProtocol.requests.allSatisfy { $0.httpMethod == "GET" && $0.url?.path == "/.well-known/heed-service" }, "Sensitive native payloads cannot reach an unrelated or wrong-checkout service")
    }
    EndpointFixtureProtocol.requests = []; EndpointFixtureProtocol.service = "heed-api"; EndpointFixtureProtocol.root = "/synthetic/heed"; EndpointFixtureProtocol.pid = 42
    var request = URLRequest(url: endpoints.apiURL("/api/ui-locale")); request.httpMethod = "POST"; request.httpBody = Data("{\"locale\":\"fr\"}".utf8)
    var done = false, accepted = false
    endpoints.perform(session: session, request: request) { _, response, error in DispatchQueue.main.async { accepted = error == nil && (response as? HTTPURLResponse)?.statusCode == 200; done = true } }
    awaitReply { done }; precondition(accepted)
    precondition(EndpointFixtureProtocol.requests.map { $0.httpMethod! } == ["GET", "POST"])
    precondition(EndpointFixtureProtocol.requests.map { $0.url!.absoluteString } == ["http://127.0.0.1:48100/.well-known/heed-service", "http://127.0.0.1:48100/api/ui-locale"])
    var verified: Bool?
    endpoints.verify(session: session, service: "heed-ui") { value in DispatchQueue.main.async { verified = value } }; awaitReply { verified != nil }; precondition(verified == false)
    EndpointFixtureProtocol.service = "heed-ui"; verified = nil
    endpoints.verify(session: session, service: "heed-ui") { value in DispatchQueue.main.async { verified = value } }; awaitReply { verified != nil }; precondition(verified == true)
    precondition(EndpointFixtureProtocol.requests.last?.url?.absoluteString == "http://127.0.0.1:48101/.well-known/heed-service")
}
