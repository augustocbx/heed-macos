import Foundation

struct LiveLanguageSettings: Decodable {
    let enabled: Bool
    let liveLanguage: String?
    let activeLiveLanguage: String?
    let liveLanguageState: String?
}
struct AdmittedLiveOptions: Decodable {
    let effectiveLanguage: String?
    let engine: String?
    let initialModel: String?
}
struct LiveLanguageAction { let settings: LiveLanguageSettings?; let persistedOff: Bool }
struct LiveLanguageClientError: LocalizedError {
    let message: String
    let code: String?
    var persistedOff = false
    var errorDescription: String? { message }
}

/** Native commands use the verified API directly; opening a browser is unnecessary. */
final class LiveLanguageClient {
    private let session: URLSession
    private let endpoints: () -> ServiceEndpoints?
    init(session: URLSession, endpoints: @escaping () -> ServiceEndpoints?) {
        self.session = session; self.endpoints = endpoints
    }
    private func request(_ path: String, body: [String:Any]? = nil, completion: @escaping (Result<Data,Error>) -> Void) {
        guard let endpoints = endpoints() else { completion(.failure(LiveLanguageClientError(message:"Service unavailable — open the interface",code:nil))); return }
        var request = URLRequest(url:endpoints.apiURL(path)); request.timeoutInterval = 6
        if let body = body {
            request.httpMethod = "POST"; request.setValue("application/json",forHTTPHeaderField:"Content-Type")
            request.httpBody = try? JSONSerialization.data(withJSONObject:body)
        }
        endpoints.perform(session:session,request:request) { data,response,error in
            DispatchQueue.main.async {
                guard error == nil, let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode), let data = data else {
                    let object = data.flatMap { try? JSONSerialization.jsonObject(with:$0) as? [String:Any] }
                    let code = object?["code"] as? String
                    let message = code == "live-language-unsupported" ? "The live model does not support this language. Choose a compatible model or record final-only." : code == "live-capabilities-unavailable" ? "Live language capabilities are unavailable. Retry when the service is ready or record final-only." : error?.localizedDescription ?? responseError(data,status:(response as? HTTPURLResponse)?.statusCode ?? 0)
                    completion(.failure(LiveLanguageClientError(message:message,code:code))); return
                }
                completion(.success(data))
            }
        }
    }
    func load(completion: @escaping (Result<LiveLanguageSettings,Error>) -> Void) {
        request("/api/recording/settings") { result in completion(result.flatMap { data in Result { try JSONDecoder().decode(LiveLanguageSettings.self,from:data) } }) }
    }
    func save(language: String, completion: @escaping (Result<LiveLanguageAction,Error>) -> Void) {
        guard ["en","pt"].contains(language) else { completion(.failure(LiveLanguageClientError(message:"Could not save live speech language. Try again.",code:nil))); return }
        settings(body:["liveLanguage":language],completion:completion)
    }
    private func settings(body:[String:Any], completion:@escaping (Result<LiveLanguageAction,Error>)->Void) {
        request("/api/recording/settings",body:body) { result in
            completion(result.flatMap { data in Result { LiveLanguageAction(settings:try JSONDecoder().decode(LiveLanguageSettings.self,from:data),persistedOff:body["enabled"] as? Bool == false) } })
        }
    }
    func start(finalOnly: Bool, requestID: String = UUID().uuidString, completion: @escaping (Result<LiveLanguageAction,Error>) -> Void) {
        let admit: (Bool) -> Void = { persistedOff in
            self.request("/api/desktop/control/commands",body:["action":"start","requestId":requestID]) { result in
                completion(result.map { _ in LiveLanguageAction(settings:nil,persistedOff:persistedOff) }.mapError { error in
                    var failure = error as? LiveLanguageClientError ?? LiveLanguageClientError(message:error.localizedDescription,code:nil)
                    failure.persistedOff = persistedOff; return failure
                })
            }
        }
        if finalOnly {
            settings(body:["enabled":false]) { result in
                switch result { case .success: admit(true); case .failure(let error): completion(.failure(error)) }
            }
        } else { admit(false) }
    }
}
