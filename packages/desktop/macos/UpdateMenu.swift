import AppKit

enum UpdatePresentation {
    static func status(_ s: UpdateSnapshot) -> String {
        if s.recovery == "recoveryRequired" && s.phase == "failed" { return "Update interrupted. Retry recovery or view the update log." }
        switch s.phase {
        case "downloading": return "Downloading update…"
        case "verifying": return "Verifying update…"
        case "installing": return "Preparing update…"
        case "restarting": return "Restarting Heed…"
        case "checkingServices": return "Verifying installed services…"
        case "checkingPermissions": return "Checking capture permissions…"
        case "waitingForIdle": return "Finish processing, then retry the update."
        case "completed": return "Update installed"
        case "failed": return failure(s.errorCode)
        default: break
        }
        switch s.state {
        case "checking": return "Checking for updates…"
        case "available": return "Update available"
        case "upToDate": return "Heed is up to date"
        case "checkFailed": return failure(s.errorCode)
        default: return "Updates not checked"
        }
    }
    static func failure(_ code: String?) -> String {
        switch code {
        case "busy": return "Finish processing, then retry the update."
        case "integrity-failed", "invalid-archive", "invalid-metadata", "invalid-url", "missing-artifact": return "Release verification failed. Check again or view the update log."
        case "unsupported-maintenance": return "Upgrade the installed API with the release installer before using menu updates."
        case "incompatible": return "This release requires a newer macOS or a compatible Mac."
        case "rate-limited": return "GitHub is limiting requests. Try again later."
        case "helper-unavailable": return "Update helper unavailable. Reinstall Heed or view the service status."
        case "installation-failed": return "Update failed. View the log and verify the retained version."
        default: return "Could not check or update Heed. Check the network and retry."
        }
    }
    static func permission(_ s: UpdateSnapshot) -> String {
        switch s.permissionState {
        case "authorized": return "Capture permissions allowed"
        case "attention": return "Permissions need attention"
        case "restricted": return "Microphone restricted by device policy"
        default: return "Could not verify permissions"
        }
    }
}

/// The main-menu build header and Updates submenu share the installed identity and locale.
final class UpdateMenu: NSObject {
    let item = NSMenuItem(title: "Updates", action: nil, keyEquivalent: "")
    private let menu = NSMenu()
    private let installedVersionItem = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    var check: (() -> Void)?; var install: (() -> Void)?; var retry: (() -> Void)?
    var permissions: (() -> Void)?; var settings: (() -> Void)?; var guidance: (() -> Void)?
    private var snapshot = UpdateSnapshot()
    private var home = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".heed")
    func render(_ snapshot: UpdateSnapshot, build: InstalledMenuBuild?, locale: String) {
        self.snapshot = snapshot
        home = URL(fileURLWithPath: ProcessInfo.processInfo.environment["HEED_HOME"] ?? Bundle.main.url(forResource: "heed-home", withExtension: "txt").flatMap {try? String(contentsOf: $0, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)} ?? home.path).resolvingSymlinksInPath()
        menu.removeAllItems(); menu.autoenablesItems = false; item.submenu = menu
        func text(_ key: String) -> String {MenuLocalization.text(key, locale: locale)}
        func row(_ title: String, _ selector: Selector? = nil, enabled: Bool = true) {
            let entry = NSMenuItem(title: title, action: selector, keyEquivalent: "")
            entry.target = self; entry.isEnabled = selector != nil && enabled; menu.addItem(entry)
        }
        item.title = text("Updates")
        let installedVersion = String(format: text("Installed version: %@"), build?.version ?? text("Unknown")) + (build?.development == true ? " (" + text("development") + ")" : "")
        installedVersionItem.title = installedVersion
        installedVersionItem.isEnabled = false
        if let mainMenu = item.menu, installedVersionItem.menu !== mainMenu {
            mainMenu.insertItem(installedVersionItem, at: 0)
        }
        row(installedVersion)
        row(text(UpdatePresentation.status(snapshot)))
        if let p = snapshot.progress, snapshot.phase == "downloading", p.total > 0 {
            row("\(min(100, max(0, Int(Double(p.completed) / Double(p.total) * 100))))%")
        }
        if let version = snapshot.release?.manifest.version {row(String(format: text("Available version: %@"), version))}
        row(text("Check for updates…"), #selector(checkAction), enabled: !snapshot.isInstalling && snapshot.recovery != "recoveryRequired")
        row(text("Release notes"), #selector(notesAction), enabled: notesURL != nil)
        row(text(snapshot.phase == "waitingForIdle" || snapshot.phase == "failed" ? "Retry update" : "Update…"), #selector(installAction), enabled: snapshot.canInstall)
        if snapshot.recovery == "recoveryRequired" {row(text("Retry recovery"), #selector(retryAction), enabled: !snapshot.isInstalling)}
        if validLog != nil {row(text("View update log…"), #selector(logAction))}
        if snapshot.phase == "completed" || snapshot.permissionVersion != nil && snapshot.permissionVersion == build?.version {
            menu.addItem(.separator()); row(text(UpdatePresentation.permission(snapshot)))
            for permission in snapshot.missingPermissions ?? [] {
                row(text(permission == "microphone" ? "Microphone permission needed" : "Screen & System Audio Recording permission needed"), permission == "microphone" ? #selector(microphoneSettings) : #selector(screenSettings))
            }
            if snapshot.optionalAccess?.contains("slackLogs") == true {row(text("Slack log access may need renewal"), #selector(settingsAction))}
            row(text("Settings and permissions…"), #selector(settingsAction))
            row(text("Check permissions again"), #selector(permissionAction))
            row(text("Permission help after updating…"), #selector(guidanceAction))
        }
    }
    private var notesURL: URL? {
        guard let release = snapshot.release, release.manifest.tag == "v" + release.manifest.version,
              release.notesURL == "https://github.com/augustocbx/heed-macos/releases/tag/" + release.manifest.tag else {return nil}
        return URL(string: release.notesURL)
    }
    private var validLog: URL? {
        guard let path = snapshot.logPath else {return nil}
        let url = URL(fileURLWithPath: path).resolvingSymlinksInPath()
        return url.path.hasPrefix(home.appendingPathComponent("updates").path + "/") && url.lastPathComponent == "update.log" ? url : nil
    }
    @objc private func checkAction() {check?()}
    @objc private func installAction() {install?()}
    @objc private func retryAction() {retry?()}
    @objc private func permissionAction() {permissions?()}
    @objc private func settingsAction() {settings?()}
    @objc private func guidanceAction() {guidance?()}
    @objc private func notesAction() {if let url = notesURL {NSWorkspace.shared.open(url)}}
    @objc private func logAction() {if let url = validLog {NSWorkspace.shared.open(url)}}
    @objc private func microphoneSettings() {NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone")!)}
    @objc private func screenSettings() {NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")!)}
}
