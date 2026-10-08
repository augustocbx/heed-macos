import AppKit
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
    try updateClientCheckingSelfTests()
}

func updateSelfTests() throws {
    installedVersionMenuSelfTests()
    updateMenuStateSelfTests()
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
    precondition(UpdatePresentation.status(UpdateSnapshot()) == "Updates not checked")
}

private func updateMenuStateSelfTests() {
    let fixtureHome = FileManager.default.temporaryDirectory.appendingPathComponent("heed-update-menu-" + UUID().uuidString)
    let previousHome = ProcessInfo.processInfo.environment["HEED_HOME"]
    setenv("HEED_HOME", fixtureHome.path, 1)
    defer {
        if let previousHome = previousHome { setenv("HEED_HOME", previousHome, 1) }
        else { unsetenv("HEED_HOME") }
    }
    let root = NSMenu()
    let updates = UpdateMenu()
    root.addItem(updates.item)
    let build = InstalledMenuBuild(version: "1.0.1", commit: String(repeating: "a", count: 40))
    var snapshot = UpdateSnapshot()
    func titles() -> [String] { updates.item.submenu?.items.filter { !$0.isSeparatorItem && !$0.isHidden }.map(\.title) ?? [] }
    func action(_ title: String) -> NSMenuItem? { updates.item.submenu?.items.first { !$0.isHidden && $0.title == title } }

    updates.render(snapshot, build: build, locale: "en")
    precondition(titles() == ["Updates not checked", "Check for updates…"], "An unchecked menu needs only its status and next action")
    let statusRow = updates.item.submenu!.items[0]
    let checkRow = action("Check for updates…")!
    let rowCount = updates.item.submenu!.numberOfItems
    updates.render(snapshot, build: build, locale: "en")
    precondition(updates.item.submenu!.items[0] === statusRow, "Unchanged refreshes must preserve menu navigation")

    snapshot.state = "checking"
    updates.render(snapshot, build: build, locale: "en")
    precondition(titles()[0] == "Checking for updates…" && action("Check for updates…")?.isEnabled == false)
    precondition(updates.item.submenu!.items[0] === statusRow, "Status changes must preserve the current menu row")
    precondition(action("Check for updates…") === checkRow && updates.item.submenu!.numberOfItems == rowCount,
                 "Checking must not replace a focused action or rebuild the native submenu")

    snapshot.state = "available"
    snapshot.release = SelectedUpdateRelease(manifest: UpdateManifest(version: "1.0.2", tag: "v1.0.2"), notesURL: "https://github.com/augustocbx/heed-macos/releases/tag/v1.0.2")
    updates.render(snapshot, build: build, locale: "en")
    precondition(titles().contains("Available version: 1.0.2") && action("Update…")?.isEnabled == true)
    precondition(action("Release notes")?.isEnabled == true)
    precondition(action("Check for updates…") === checkRow && updates.item.submenu!.numberOfItems == rowCount,
                 "Dynamic update rows must not retarget the check action")

    snapshot.phase = "installing"
    updates.render(snapshot, build: build, locale: "en")
    precondition(titles()[0] == "Preparing update…" && action("Update…") == nil, "An active install must show progress without a disabled install action")

    snapshot.phase = "completed"
    snapshot.release = SelectedUpdateRelease(manifest: UpdateManifest(version: "1.0.1", tag: "v1.0.1"), notesURL: "https://github.com/augustocbx/heed-macos/releases/tag/v1.0.1")
    updates.render(snapshot, build: build, locale: "en")
    precondition(titles()[0] == "Update installed")
    precondition(!titles().contains("Available version: 1.0.1") && action("Update…") == nil, "An installed release is not an available upgrade")
    precondition(action("Release notes")?.isEnabled == true, "Completed-release notes remain reachable")
    precondition(action("Check permissions again") == nil, "Ongoing permission controls belong in Settings, not Updates")

    snapshot.phase = "failed"
    snapshot.errorCode = "installation-failed"
    snapshot.release = SelectedUpdateRelease(manifest: UpdateManifest(version: "1.0.2", tag: "v1.0.2"), notesURL: "https://github.com/augustocbx/heed-macos/releases/tag/v1.0.2")
    snapshot.logPath = fixtureHome.appendingPathComponent("updates/fixture/update.log").path
    updates.render(snapshot, build: build, locale: "en")
    precondition(action("Retry update")?.isEnabled == true && action("View update log…")?.isEnabled == true)
    snapshot.logPath = fixtureHome.deletingLastPathComponent().appendingPathComponent("outside-updates/update.log").path
    updates.render(snapshot, build: build, locale: "en")
    precondition(action("View update log…") == nil, "Logs outside the configured Heed home must remain unavailable")
    snapshot.recovery = "recoveryRequired"
    updates.render(snapshot, build: build, locale: "en")
    precondition(action("Retry recovery")?.isEnabled == true && action("Retry update") == nil)
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

private func updateClientCheckingSelfTests() throws {
    let fixture = try UpdateHelperFixture(version: "1.0.1")
    try fixture.setSnapshot(#"{"schema":1,"state":"available","phase":"completed","release":{"manifest":{"version":"1.0.1","tag":"v1.0.1"},"notesURL":"https://github.com/augustocbx/heed-macos/releases/tag/v1.0.1"}}"#)
    let client = ReleaseUpdateClient(endpoints: { fixture.endpoints })
    client.refreshStatus(); awaitUpdateClient { !client.inFlight }
    try fixture.block()
    client.check(manual: true)
    precondition(client.snapshot.state == "checking" && client.snapshot.phase == nil, "A new check must not display the previous completed phase")
    try fixture.unblock(); awaitUpdateClient { !client.inFlight }
}


/// The installed build remains visible without opening the Updates submenu.
private func installedVersionMenuSelfTests() {
    let root = NSMenu()
    root.autoenablesItems = false
    let updates = UpdateMenu()
    root.addItem(updates.item)
    let installed = InstalledMenuBuild(version: "1.0.1", commit: String(repeating: "a", count: 40))
    var snapshot = UpdateSnapshot()
    snapshot.state = "available"
    snapshot.release = SelectedUpdateRelease(manifest: UpdateManifest(version: "2.0.0", tag: "v2.0.0"), notesURL: "https://github.com/augustocbx/heed-macos/releases/tag/v2.0.0")
    updates.render(snapshot, build: installed, locale: "en")
    precondition(root.items.first?.title == "Installed version: 1.0.1", "Installed version must be visible in the main menu, separate from the available update")
    precondition(root.items.first?.isEnabled == false)
    snapshot.state = "checkFailed"
    snapshot.errorCode = "helper-unavailable"
    updates.render(snapshot, build: installed, locale: "en")
    precondition(root.items.first?.title == "Installed version: 1.0.1", "An unavailable update helper must not hide the installed build")
    precondition(root.items.count == 2, "Refreshing status must not duplicate the installed version")
    let development = InstalledMenuBuild(version: "1.0.1", commit: nil)
    for (locale, expected) in [("en", "Installed version: 1.0.1 (development)"), ("pt-BR", "Versão instalada: 1.0.1 (desenvolvimento)"), ("fr", "Version installée : 1.0.1 (développement)"), ("de", "Installierte Version: 1.0.1 (Entwicklung)")] {
        updates.render(snapshot, build: development, locale: locale)
        precondition(root.items.first?.title == expected)
    }
    updates.render(snapshot, build: nil, locale: "en")
    precondition(root.items.first?.title == "Installed version: Unknown", "Missing installed metadata must not show the available release as installed")
}
