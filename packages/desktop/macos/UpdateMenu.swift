import AppKit

enum UpdatePresentation {
    static func status(_ s: UpdateSnapshot) -> String {
        if s.state == "checking" { return "Checking for updates…" }
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
}

/// The main-menu build header and Updates submenu share the installed identity and locale.
final class UpdateMenu: NSObject {
    let item = NSMenuItem(title: "Updates", action: nil, keyEquivalent: "")
    private let menu = NSMenu()
    private let installedVersionItem = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    private var rows: [String: NSMenuItem] = [:]
    var check: (() -> Void)?; var install: (() -> Void)?; var retry: (() -> Void)?
    private var snapshot = UpdateSnapshot()
    private var home = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".heed")
    func render(_ snapshot: UpdateSnapshot, build: InstalledMenuBuild?, locale: String) {
        self.snapshot = snapshot
        home = URL(fileURLWithPath: ProcessInfo.processInfo.environment["HEED_HOME"] ?? Bundle.main.url(forResource: "heed-home", withExtension: "txt").flatMap {try? String(contentsOf: $0, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)} ?? home.path).resolvingSymlinksInPath()
        menu.autoenablesItems = false; item.submenu = menu
        if rows.isEmpty {
            for key in ["status", "check", "progress", "available", "notes", "install", "recovery", "log"] {
                let entry = NSMenuItem(title: "", action: nil, keyEquivalent: "")
                menu.addItem(entry)
                rows[key] = entry
            }
        }
        for entry in rows.values { entry.isHidden = true }
        func text(_ key: String) -> String {MenuLocalization.text(key, locale: locale)}
        func row(_ key: String, _ title: String, _ selector: Selector? = nil, enabled: Bool = true) {
            guard let entry = rows[key] else { preconditionFailure("Unknown update menu row") }
            entry.title = title; entry.action = selector; entry.target = self
            entry.isEnabled = selector != nil && enabled
            entry.isHidden = false
        }
        item.title = text("Updates")
        let installedVersion = String(format: text("Installed version: %@"), build?.version ?? text("Unknown")) + (build?.development == true ? " (" + text("development") + ")" : "")
        installedVersionItem.title = installedVersion
        installedVersionItem.isEnabled = false
        if let mainMenu = item.menu, installedVersionItem.menu !== mainMenu {
            mainMenu.insertItem(installedVersionItem, at: 0)
        }
        row("status", text(UpdatePresentation.status(snapshot)))
        if !snapshot.isInstalling {
            row("check", text("Check for updates…"), #selector(checkAction),
                enabled: snapshot.state != "checking" && snapshot.recovery != "recoveryRequired")
        }
        if let p = snapshot.progress, snapshot.phase == "downloading", p.total > 0 {
            row("progress", "\(min(100, max(0, Int(Double(p.completed) / Double(p.total) * 100))))%")
        }
        let availableUpgrade = snapshot.state == "available" && !snapshot.isInstalling && snapshot.phase != "completed"
            && snapshot.release?.manifest.version != build?.version && snapshot.release != nil
        if availableUpgrade, let version = snapshot.release?.manifest.version {
            row("available", String(format: text("Available version: %@"), version))
        }
        if notesURL != nil {row("notes", text("Release notes"), #selector(notesAction))}
        if availableUpgrade && snapshot.canInstall {
            row("install", text(snapshot.phase == "waitingForIdle" || snapshot.phase == "failed" ? "Retry update" : "Update…"), #selector(installAction))
        }
        if snapshot.recovery == "recoveryRequired" {row("recovery", text("Retry recovery"), #selector(retryAction), enabled: !snapshot.isInstalling)}
        if validLog != nil {row("log", text("View update log…"), #selector(logAction))}
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
    @objc private func notesAction() {if let url = notesURL {NSWorkspace.shared.open(url)}}
    @objc private func logAction() {if let url = validLog {NSWorkspace.shared.open(url)}}
}
