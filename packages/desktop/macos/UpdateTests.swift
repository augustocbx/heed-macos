import Foundation

/// Local fixtures require a separate QA bundle and an explicit argument.
func updateQARoot() -> URL? {
    guard Bundle.main.bundleIdentifier?.hasPrefix("local.heed.menu-qa.") == true,
          let index = CommandLine.arguments.firstIndex(of: "--update-qa"), index + 1 < CommandLine.arguments.count else {return nil}
    let root = URL(fileURLWithPath: CommandLine.arguments[index + 1]).resolvingSymlinksInPath()
    guard root.lastPathComponent.hasPrefix("heed-menu-qa-"),
          let data = try? Data(contentsOf: root.appendingPathComponent("fixture.json")), data.count < 16384,
          let marker = try? JSONSerialization.jsonObject(with: data) as? [String:Any], marker["fixtureOnly"] as? Bool == true else {return nil}
    return root
}


/// Subprocess fixtures run only in explicit developer/CI validation.
func updateClientSelfTests() throws {
    try updateClientConfigurationSelfTests()
    try updateClientPollingSelfTests()
    try updateClientForcedRefreshSelfTests()
}

func updateSelfTests() throws {
    let available = try JSONDecoder().decode(UpdateSnapshot.self, from: Data(#"{"schema":1,"state":"available","targetVersion":"1.2.0","release":{"manifest":{"version":"1.2.0","tag":"v1.2.0"},"notesURL":"https://github.com/augustocbx/heed-macos/releases/tag/v1.2.0"}}"#.utf8))
    precondition(UpdatePresentation.status(available) == "Update available")
    precondition(available.canInstall)
    precondition(available.release?.notesURL == "https://github.com/augustocbx/heed-macos/releases/tag/v1.2.0")
    for phase in ["downloading", "verifying", "installing", "restarting", "checkingServices", "checkingPermissions"] {
        var active = available; active.phase = phase
        precondition(active.isInstalling && !active.canInstall)
    }
    var busy = available; busy.phase = "waitingForIdle"
    precondition(UpdatePresentation.status(busy) == "Finish processing, then retry the update.")
    precondition(busy.canInstall)
    var failed = available; failed.phase = "failed"; failed.errorCode = "integrity-failed"
    precondition(UpdatePresentation.status(failed) == "Release verification failed. Check again or view the update log.")
    failed.recovery = "recoveryRequired"
    precondition(!failed.canInstall)
    precondition(!ReleaseUpdateClient.automaticCheckDue(lastAttempt: 1000, now: 1001))
    precondition(ReleaseUpdateClient.automaticCheckDue(lastAttempt: 1000, now: 87400))
    precondition(ReleaseUpdateClient.automaticCheckDue(lastAttempt: nil, now: 1000))
    for permission in ["unknown", "attention", "restricted", "authorized"] {
        var snapshot = available; snapshot.permissionState = permission
        precondition(!UpdatePresentation.permission(snapshot).isEmpty)
    }
    precondition(UpdatePresentation.status(UpdateSnapshot()) == "Updates not checked")
}


private final class UpdateHelperFixture {
    let root: URL
    var endpoints: ServiceEndpoints {
        ServiceEndpoints(apiPort: 48103, uiPort: 48104, transcriptionPort: 48105, checkoutRoot: root.path)
    }
    init(version: String) throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("heed-update-client-" + UUID().uuidString)
        let scripts = root.appendingPathComponent("scripts/release")
        try FileManager.default.createDirectory(at: scripts, withIntermediateDirectories: true)
        try Data(version.utf8).write(to: root.appendingPathComponent("VERSION"))
        let helper = #"""
        import json, os, pathlib, sys, time
        root = pathlib.Path(__file__).parents[2]
        args = sys.argv[1:]
        with (root / 'requests.jsonl').open('a') as output:
            output.write(json.dumps({'args': args, 'api': os.environ['HEED_API_PORT']}) + '\n')
        while (root / 'blocked').exists():
            time.sleep(0.01)
        result = json.loads((root / 'snapshot.json').read_text())
        result['targetVersion'] = args[args.index('--version') + 1]
        print(json.dumps(result))
        """#
        try Data(helper.utf8).write(to: scripts.appendingPathComponent("update_transaction.py"))
        try setSnapshot(#"{"schema":1,"state":"upToDate"}"#)
    }
    func setSnapshot(_ json: String) throws { try Data(json.utf8).write(to: root.appendingPathComponent("snapshot.json")) }
    var requests: [[String: Any]] {
        guard let contents = try? String(contentsOf: root.appendingPathComponent("requests.jsonl"), encoding: .utf8) else { return [] }
        return contents.split(separator: "\n").compactMap { try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any] }
    }
    func block() throws { try Data().write(to: root.appendingPathComponent("blocked")) }
    func unblock() throws { try FileManager.default.removeItem(at: root.appendingPathComponent("blocked")) }
    deinit { try? FileManager.default.removeItem(at: root) }
}

private func awaitUpdateClient(_ done: () -> Bool) {
    let deadline = Date().addingTimeInterval(5)
    while !done() && Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.01)) }
    precondition(done(), "Update helper fixture did not finish")
}

private func updateClientConfigurationSelfTests() throws {
    let first = try UpdateHelperFixture(version: "1.0.1")
    let second = try UpdateHelperFixture(version: "1.0.2")
    try first.setSnapshot(#"{"schema":1,"state":"available","release":{"manifest":{"version":"1.1.0","tag":"v1.1.0"},"notesURL":"https://github.com/augustocbx/heed-macos/releases/tag/v1.1.0"}}"#)
    var endpoints: ServiceEndpoints? = nil
    let client = ReleaseUpdateClient(endpoints: { endpoints })
    client.refreshStatus(); awaitUpdateClient { !client.inFlight }
    precondition(client.snapshot.errorCode == "helper-unavailable")
    endpoints = first.endpoints
    client.refreshStatus(force: true); awaitUpdateClient { !client.inFlight }
    precondition(client.snapshot.targetVersion == "1.0.1", "Corrected endpoints must reach an updater initialized without configuration")
    precondition(first.requests.first?["api"] as? String == "48103")
    try first.block()
    client.install()
    awaitUpdateClient { first.requests.count == 2 }
    precondition((first.requests.last?["args"] as? [String])?.first == "install")
    endpoints = ServiceEndpoints(apiPort: 48113, uiPort: 48114, transcriptionPort: 48115, checkoutRoot: second.root.path)
    try first.unblock(); awaitUpdateClient { !client.inFlight }
    precondition(client.snapshot.targetVersion == "1.0.1", "In-flight requests must retain their admitted configuration")
    client.check(manual: true); awaitUpdateClient { !client.inFlight }
    precondition(client.snapshot.targetVersion == "1.0.2", "Subsequent requests must use the reloaded build and root")
    precondition(client.build?.version == "1.0.2")
    let request = second.requests.first!
    precondition(request["api"] as? String == "48113")
    let args = request["args"] as! [String]
    precondition(args.first == "check" && args[args.firstIndex(of: "--root")! + 1] == second.root.path)
}

private func updateClientPollingSelfTests() throws {
    let fixture = try UpdateHelperFixture(version: "1.0.1")
    var time = 1000.0
    let client = ReleaseUpdateClient(endpoints: { fixture.endpoints }, now: { time })
    client.refreshStatus(); awaitUpdateClient { !client.inFlight }
    for elapsed in stride(from: 2, through: 58, by: 2) {
        time = 1000 + Double(elapsed)
        client.refreshStatus(); awaitUpdateClient { !client.inFlight }
    }
    precondition(fixture.requests.count == 1, "Idle status must not launch a Python helper on every service poll")
    time = 1060; client.refreshStatus(); awaitUpdateClient { !client.inFlight }
    precondition(fixture.requests.count == 2, "Skipped polls must not postpone the next idle read")
    try fixture.setSnapshot(#"{"schema":1,"state":"available","phase":"downloading"}"#)
    time = 1061; client.refreshStatus(force: true); awaitUpdateClient { !client.inFlight }
    precondition(fixture.requests.count == 3)
    time = 1062; client.refreshStatus(); awaitUpdateClient { !client.inFlight }
    precondition(fixture.requests.count == 3)
    time = 1063; client.refreshStatus(); awaitUpdateClient { !client.inFlight }
    precondition(fixture.requests.count == 4, "Active update progress must refresh promptly")
    try fixture.setSnapshot(#"{"schema":1,"state":"upToDate"}"#)
    time = 1065; client.refreshStatus(); awaitUpdateClient { !client.inFlight }
    precondition(fixture.requests.count == 5)
    try fixture.block()
    time = 1125; client.refreshStatus()
    awaitUpdateClient { fixture.requests.count == 6 }
    client.check(manual: true)
    try fixture.unblock(); awaitUpdateClient { !client.inFlight }
    precondition(fixture.requests.count == 7, "A manual check during a status read must run after the read")
    precondition((fixture.requests.last?["args"] as? [String])?.first == "check")
}


private func updateClientForcedRefreshSelfTests() throws {
    let first = try UpdateHelperFixture(version: "1.0.1")
    let replacement = try UpdateHelperFixture(version: "1.0.2")
    try replacement.setSnapshot(#"{"schema":1,"state":"checkFailed","phase":"failed","recovery":"recoveryRequired"}"#)
    var endpoints = first.endpoints
    let client = ReleaseUpdateClient(endpoints: { endpoints }, now: { 1000 })
    try first.block()
    client.refreshStatus()
    awaitUpdateClient { first.requests.count == 1 }
    endpoints = replacement.endpoints
    client.refreshStatus(force: true)
    client.refreshStatus(force: true)
    try first.unblock(); awaitUpdateClient { !client.inFlight }
    precondition(replacement.requests.count == 1, "Service retries during a request must preserve and coalesce a forced status refresh")
    precondition(client.snapshot.targetVersion == "1.0.2" && client.snapshot.recovery == "recoveryRequired", "Forced retry must promptly discover recovery with the new configuration")
}
