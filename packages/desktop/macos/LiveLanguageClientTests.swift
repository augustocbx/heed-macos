import Foundation

private final class LiveLanguageFixtureProtocol: URLProtocol {
    static var requests: [URLRequest] = []
    static var failSave = false
    static var failStart = false
    static var foreign = false
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.requests.append(request)
        let path = request.url!.path
        var status = 200
        var body = "{}"
        if path == "/.well-known/heed-service" {
            body = "{\"service\":\"\(Self.foreign ? "foreign-api" : "heed-api")\",\"protocolVersion\":1,\"pid\":123,\"checkoutRoot\":\"/synthetic/heed\"}"
        } else if path == "/api/recording/settings" {
            if request.httpMethod == "POST" && Self.failSave { status = 503; body = "{\"error\":\"disk unavailable\"}" }
            else { body = "{\"enabled\":false,\"liveLanguage\":\"pt\",\"activeLiveLanguage\":\"en\",\"liveLanguageState\":\"unsupported\"}" }
        } else if path == "/api/desktop/control/commands" && Self.failStart {
            status = 409; body = "{\"error\":\"unsupported\",\"code\":\"live-language-unsupported\"}"
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["Content-Type":"application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8)); client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

func liveLanguageClientSelfTests() throws {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [LiveLanguageFixtureProtocol.self]
    let session = URLSession(configuration: configuration)
    defer { session.invalidateAndCancel() }
    let data = Data("{\"api\":48100,\"ui\":48101,\"transcription\":48102,\"forbiddenRanges\":[[3000,3999],[5000,5999],[7000,7999],[8000,8999]]}".utf8)
    let endpoints = try ServiceEndpoints.resolve(configData: data, checkoutRoot: "/synthetic/heed", environment: [:])
    let client = LiveLanguageClient(session: session, endpoints: { endpoints })
    func reset() { LiveLanguageFixtureProtocol.requests = []; LiveLanguageFixtureProtocol.failSave = false; LiveLanguageFixtureProtocol.failStart = false; LiveLanguageFixtureProtocol.foreign = false }
    func awaitResult(_ call: (@escaping (Result<LiveLanguageAction,Error>) -> Void) -> Void) -> Result<LiveLanguageAction,Error> {
        var result: Result<LiveLanguageAction,Error>?
        call { result = $0 }; let deadline = Date().addingTimeInterval(3)
        while result == nil && Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.01)) }
        precondition(result != nil, "Bounded native speech action must finish")
        return result!
    }
    func writes() -> [URLRequest] { LiveLanguageFixtureProtocol.requests.filter { $0.httpMethod == "POST" } }
    func payload(_ request: URLRequest) -> [String:Any] {
        var bytes = request.httpBody
        if bytes == nil, let stream = request.httpBodyStream {
            stream.open(); defer { stream.close() }; var buffer = [UInt8](repeating:0,count:4096); var data = Data()
            while stream.hasBytesAvailable { let count = stream.read(&buffer,maxLength:buffer.count); if count <= 0 { break }; data.append(buffer,count:count) }; bytes = data
        }
        return (try! JSONSerialization.jsonObject(with: bytes!)) as! [String:Any]
    }
    for language in ["en","pt"] {
        reset(); _ = try awaitResult { client.save(language: language, completion: $0) }.get()
        precondition(writes().count == 1 && Set(payload(writes()[0]).keys) == ["liveLanguage"])
        precondition(payload(writes()[0])["liveLanguage"] as? String == language)
    }
    reset(); _ = try awaitResult { client.start(finalOnly:false, requestID:"start-1", completion:$0) }.get()
    precondition(writes().count == 1 && Set(payload(writes()[0]).keys) == ["action","requestId"])
    reset(); let action = try awaitResult { client.start(finalOnly:true, requestID:"start-2", completion:$0) }.get()
    precondition(action.persistedOff && writes().map { $0.url!.path } == ["/api/recording/settings","/api/desktop/control/commands"])
    precondition(payload(writes()[0])["enabled"] as? Bool == false && payload(writes()[1])["requestId"] as? String == "start-2")
    precondition(writes().allSatisfy { $0.timeoutInterval <= 6 })
    reset(); LiveLanguageFixtureProtocol.failSave = true
    if case .success = awaitResult({ client.start(finalOnly:true, completion:$0) }) { preconditionFailure("Failed preference write cannot start capture") }
    precondition(writes().count == 1)
    reset(); LiveLanguageFixtureProtocol.failStart = true
    if case .failure(let error) = awaitResult({ client.start(finalOnly:true, completion:$0) }) {
        precondition((error as? LiveLanguageClientError)?.persistedOff == true)
    } else { preconditionFailure("Admission failure must remain a failure") }
    reset(); LiveLanguageFixtureProtocol.foreign = true
    if case .success = awaitResult({ client.save(language:"pt",completion:$0) }) { preconditionFailure("Foreign API cannot accept language settings") }
    precondition(writes().isEmpty)
    for locale in ["pt-BR","fr","de"] {
        for key in ["Live speech language","Brazilian Portuguese","Record final-only (keeps real-time off)"] { precondition(MenuLocalization.text(key,locale:locale) != key) }
    }
}
