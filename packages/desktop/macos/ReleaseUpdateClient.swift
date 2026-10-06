import Foundation

struct UpdateManifest: Decodable { let version: String; let tag: String }
struct SelectedUpdateRelease: Decodable { let manifest: UpdateManifest; let notesURL: String }
struct UpdateProgress: Decodable { let asset: String; let completed: Int64; let total: Int64 }
struct UpdateSnapshot: Decodable {
    var schema: Int = 1
    var state: String = "notChecked"
    var phase: String? = nil
    var targetVersion: String? = nil
    var release: SelectedUpdateRelease? = nil
    var errorCode: String? = nil
    var recovery: String? = nil
    var logPath: String? = nil
    var permissionState: String? = nil
    var missingPermissions: [String]? = nil
    var optionalAccess: [String]? = nil
    var progress: UpdateProgress? = nil
    var lastAutomaticAttempt: Double? = nil
    var isInstalling: Bool { ["downloading","verifying","installing","restarting","checkingServices","checkingPermissions"].contains(phase ?? "") }
    var canInstall: Bool { state == "available" && release != nil && !isInstalling && recovery != "recoveryRequired" && phase != "completed" }
    // Defaults are also needed when an older status document lacks optional fields.
    enum CodingKeys: String, CodingKey {case schema,state,phase,targetVersion,release,errorCode,recovery,logPath,permissionState,missingPermissions,optionalAccess,progress,lastAutomaticAttempt}
    init() {}
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        schema = try c.decode(Int.self, forKey: .schema)
        guard schema == 1 else { throw DecodingError.dataCorruptedError(forKey: .schema, in: c, debugDescription: "Unsupported update schema") }
        state = try c.decodeIfPresent(String.self, forKey: .state) ?? "notChecked"
        phase = try c.decodeIfPresent(String.self, forKey: .phase)
        targetVersion = try c.decodeIfPresent(String.self, forKey: .targetVersion)
        release = try c.decodeIfPresent(SelectedUpdateRelease.self, forKey: .release)
        errorCode = try c.decodeIfPresent(String.self, forKey: .errorCode)
        recovery = try c.decodeIfPresent(String.self, forKey: .recovery)
        logPath = try c.decodeIfPresent(String.self, forKey: .logPath)
        permissionState = try c.decodeIfPresent(String.self, forKey: .permissionState)
        missingPermissions = try c.decodeIfPresent([String].self, forKey: .missingPermissions)
        optionalAccess = try c.decodeIfPresent([String].self, forKey: .optionalAccess)
        progress = try c.decodeIfPresent(UpdateProgress.self, forKey: .progress)
        lastAutomaticAttempt = try c.decodeIfPresent(Double.self, forKey: .lastAutomaticAttempt)
    }
}

struct InstalledMenuBuild {
    let version: String
    let commit: String?
    var development: Bool { commit == nil }
    static func load(root: String?) -> InstalledMenuBuild? {
        let resource = Bundle.main.url(forResource: "release", withExtension: "json")
        let metadata = resource.flatMap {try? Data(contentsOf: $0)}.flatMap {try? JSONSerialization.jsonObject(with: $0) as? [String:Any]}
        let fallback = root.flatMap {try? String(contentsOfFile: $0 + "/VERSION", encoding: .utf8)}?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? fallback,
              version.range(of: #"^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$"#, options: .regularExpression) != nil else {return nil}
        let commit = metadata?["version"] as? String == version ? metadata?["commit"] as? String : nil
        return InstalledMenuBuild(version: version, commit: commit?.range(of: #"^[a-f0-9]{40}$"#, options: .regularExpression) != nil ? commit : nil)
    }
}

/// Process I/O stays on a serial worker; callbacks and admission stay on the main thread.
final class ReleaseUpdateClient {
    var onChange: ((UpdateSnapshot) -> Void)?
    private(set) var snapshot = UpdateSnapshot()
    private(set) var inFlight = false
    private let queue = DispatchQueue(label: "local.heed.release-updates", qos: .utility)
    private let endpoints: ServiceEndpoints?
    let build: InstalledMenuBuild?
    private let home: String
    init(endpoints: ServiceEndpoints?) {
        self.endpoints = endpoints
        self.build = InstalledMenuBuild.load(root: endpoints?.checkoutRoot)
        home = ProcessInfo.processInfo.environment["HEED_HOME"] ?? Bundle.main.url(forResource: "heed-home", withExtension: "txt").flatMap {try? String(contentsOf: $0, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)} ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".heed").path
    }
    static func automaticCheckDue(lastAttempt: Double?, now: Double = Date().timeIntervalSince1970) -> Bool {
        lastAttempt == nil || now - lastAttempt! >= 86400
    }
    func check(manual: Bool) {
        guard !snapshot.isInstalling, snapshot.recovery != "recoveryRequired", manual || Self.automaticCheckDue(lastAttempt: snapshot.lastAutomaticAttempt) else { return }
        run("check", automatic: !manual)
    }
    func install() { guard snapshot.canInstall else {return}; run("install") }
    func retry() { snapshot.recovery == "recoveryRequired" ? run("recover") : install() }
    func refreshStatus() {run("status")}
    func checkPermissions() {guard snapshot.phase == "completed" else {return}; run("permissions")}
    private func run(_ command: String, automatic: Bool = false) {
        guard !inFlight else {return}
        inFlight = true
        if command == "check" {snapshot.state = "checking"; onChange?(snapshot)}
        let endpoints = endpoints, build = build, home = home
        queue.async { [weak self] in
            var result = UpdateSnapshot()
            do {
                guard let endpoints = endpoints, let build = build else {throw ServiceEndpointError.invalidConfiguration}
                let resource = Bundle.main.resourceURL?.appendingPathComponent("update-helper/scripts/release/update_transaction.py")
                let helper = resource.flatMap {FileManager.default.fileExists(atPath: $0.path) ? $0 : nil}
                    ?? URL(fileURLWithPath: endpoints.checkoutRoot).appendingPathComponent("scripts/release/update_transaction.py")
                guard FileManager.default.fileExists(atPath: helper.path) else {throw ServiceEndpointError.invalidConfiguration}
                let os = ProcessInfo.processInfo.operatingSystemVersion
                let process = Process(), pipe = Pipe()
                process.executableURL = URL(fileURLWithPath: "/usr/bin/python3")
                process.arguments = [helper.path, command, "--root", endpoints.checkoutRoot, "--home", home,
                                     "--version", build.version, "--macos", "\(os.majorVersion).\(os.minorVersion).\(os.patchVersion)"]
                if let appDirectory = Bundle.main.url(forResource: "heed-app-dir", withExtension: "txt").flatMap({try? String(contentsOf: $0, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)}) {
                    process.arguments! += ["--app-dir",appDirectory]
                } else if let appDirectory = ProcessInfo.processInfo.environment["HEED_APP_DIR"] {process.arguments! += ["--app-dir",appDirectory]}
                if let commit = build.commit {process.arguments! += ["--commit",commit]}
                if automatic {process.arguments!.append("--automatic")}
                process.environment = endpoints.launchEnvironment(base: ProcessInfo.processInfo.environment)
                process.standardOutput = pipe; process.standardError = FileHandle.nullDevice
                try process.run()
                let timeout = DispatchWorkItem {if process.isRunning {process.terminate()}}
                DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + (command == "check" || command == "permissions" || command == "recover" ? 90 : 20), execute: timeout)
                var data = Data()
                while true {
                    let chunk = pipe.fileHandleForReading.availableData
                    if chunk.isEmpty {break}
                    guard data.count + chunk.count <= 2 * 1024 * 1024 else {process.terminate(); throw ServiceEndpointError.invalidConfiguration}
                    data.append(chunk)
                }
                process.waitUntilExit(); timeout.cancel()
                result = try JSONDecoder().decode(UpdateSnapshot.self, from: data)
            } catch {
                result.state = "checkFailed"; result.phase = "failed"; result.errorCode = "helper-unavailable"
            }
            let completed = result
            DispatchQueue.main.async {
                guard let self = self else {return}
                self.inFlight = false; self.snapshot = completed; self.onChange?(completed)
            }
        }
    }
}
