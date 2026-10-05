import AppKit
import Foundation

/// Permission limited to the log folder, granted through the macOS folder picker.
final class SlackLogAccess {
    private let home: URL
    private let defaults: UserDefaults
    private let key = "HeedSlackLogsBookmark"
    private var scopedURL: URL?
    private var scopeStarted = false
    private(set) var diagnostic: String?

    init(home: URL = FileManager.default.homeDirectoryForCurrentUser, defaults: UserDefaults = .standard) {
        self.home = home
        self.defaults = defaults
    }

    var expectedRoots: [URL] {
        [home.appendingPathComponent("Library/Containers/com.tinyspeck.slackmacgap/Data/Library/Application Support/Slack/logs"),
         home.appendingPathComponent("Library/Application Support/Slack/logs")]
    }

    func isAllowed(_ url: URL) -> Bool {
        let normalized = url.standardizedFileURL.resolvingSymlinksInPath()
        return expectedRoots.contains { $0.standardizedFileURL.resolvingSymlinksInPath() == normalized }
    }

    private func retainScope(_ url: URL) {
        if scopeStarted { scopedURL?.stopAccessingSecurityScopedResource() }
        scopedURL = url
        scopeStarted = url.startAccessingSecurityScopedResource()
        // Apps without a sandbox may receive false even when access was granted
        // through the picker. The detector checks actual readability instead of rejecting access.
    }

    func restore() -> URL? {
        guard let data = defaults.data(forKey: key) else { return nil }
        do {
            var stale = false
            let url = try URL(resolvingBookmarkData: data, options: [.withSecurityScope, .withoutUI], relativeTo: nil, bookmarkDataIsStale: &stale)
            guard isAllowed(url) else { diagnostic = "The saved authorization does not match the Slack log folder."; return nil }
            retainScope(url)
            if stale {
                let renewed = try url.bookmarkData(options: [.withSecurityScope, .securityScopeAllowOnlyReadAccess], includingResourceValuesForKeys: nil, relativeTo: nil)
                defaults.set(renewed, forKey: key)
            }
            diagnostic = nil
            return url
        } catch {
            diagnostic = "Could not restore Slack log authorization (code \((error as NSError).code))."
            return nil
        }
    }

    func request(locale: String = "en", completion: @escaping (URL?) -> Void) {
        let panel = NSOpenPanel()
        panel.title = MenuLocalization.text("Allow Slack meeting detection", locale: locale)
        panel.message = MenuLocalization.text("Select the Slack logs folder. Heed only reads logs to detect when a meeting starts or ends.", locale: locale)
        panel.prompt = MenuLocalization.text("Allow log access", locale: locale)
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = false
        panel.allowsMultipleSelection = false
        panel.showsHiddenFiles = true
        panel.directoryURL = expectedRoots.first { FileManager.default.fileExists(atPath: $0.path) } ?? expectedRoots[0]
        NSApp.activate(ignoringOtherApps: true)
        panel.begin { [weak self] response in
            guard let self = self else { completion(nil); return }
            guard response == .OK, let url = panel.url else {
                self.diagnostic = "Slack log authorization was canceled."
                completion(nil)
                return
            }
            guard self.isAllowed(url) else {
                self.diagnostic = "Select the exact Slack logs folder; access to other folders will not be granted."
                completion(nil)
                return
            }
            self.retainScope(url)
            do {
                let data = try url.bookmarkData(options: [.withSecurityScope, .securityScopeAllowOnlyReadAccess], includingResourceValuesForKeys: nil, relativeTo: nil)
                self.defaults.set(data, forKey: self.key)
                self.diagnostic = nil
                completion(url)
            } catch {
                // The selection already granted access for this launch, even if the
                // bookmark cannot be saved for the next launch.
                self.diagnostic = "Access is allowed for this launch; could not save the authorization (code \((error as NSError).code))."
                completion(url)
            }
        }
    }

    deinit { if scopeStarted { scopedURL?.stopAccessingSecurityScopedResource() } }
}

func slackLogAccessSelfTests() throws {
    let home = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    let defaults = UserDefaults(suiteName: "heed-slack-access-test-\(UUID().uuidString)")!
    let access = SlackLogAccess(home: home, defaults: defaults)
    func check(_ value: Bool, _ message: String) throws {
        if !value { throw NSError(domain: "SlackLogAccess", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
    }
    try check(access.expectedRoots.allSatisfy { access.isAllowed($0) }, "Accept only the expected roots")
    try check(!access.isAllowed(home), "Do not authorize the home folder")
    try check(!access.isAllowed(access.expectedRoots[0].deletingLastPathComponent()), "Do not authorize all Slack data")
    try check(!access.isAllowed(access.expectedRoots[0].appendingPathComponent("default")), "Select the exact logs folder")
    try check(!access.isAllowed(home.appendingPathComponent("Library/Application Support/Other/logs")), "Do not authorize another app")
    try check(access.restore() == nil, "Do not restore without a bookmark")
}
