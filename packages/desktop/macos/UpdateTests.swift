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
