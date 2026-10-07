import Foundation

func screenCaptureGuideSelfTests() throws {
    precondition(ScreenCaptureActionRoute.forPreflight(true) == .directPane)
    precondition(ScreenCaptureActionRoute.forPreflight(false) == .guidedReplacement)
    precondition(UpdatePermissionHelpRoute.forMissing(["microphone"]) == .general)
    precondition(UpdatePermissionHelpRoute.forMissing(["screenCapture", "microphone"]) == .screenGuide)
    precondition(UpdatePermissionHelpRoute.forMissing(["screenCapture"]) == .screenGuide)
    precondition(UpdatePermissionHelpRoute.forMissing(nil) == .general)
    precondition(UpdatePermissionHelpRoute.forMissing([]) == .general)
    precondition(UpdatePermissionHelpRoute.forMissing(["slackLogs"]) == .general)
    precondition(UpdatePermissionHelpRoute.forHelp(screenAuthorized: false, missing: nil, reportVersion: nil, installedVersion: "0.1.5") == .screenGuide)
    precondition(UpdatePermissionHelpRoute.forHelp(screenAuthorized: true, missing: ["screenCapture"], reportVersion: "0.1.5", installedVersion: "0.1.5") == .screenGuide)
    precondition(UpdatePermissionHelpRoute.forHelp(screenAuthorized: true, missing: ["screenCapture"], reportVersion: "0.1.4", installedVersion: "0.1.5") == .general)
    precondition(UpdatePermissionHelpRoute.forHelp(screenAuthorized: true, missing: ["screenCapture"], reportVersion: nil, installedVersion: "0.1.5") == .general)
    for (key, translations) in ScreenCaptureGuideLocalization.translations {
        precondition(MenuLocalization.text(key, locale: "en") == key, "English remains the fallback for guide text")
        for locale in ["pt-BR", "fr", "de"] {
            precondition(translations[locale]?.isEmpty == false, "Missing \(locale) screen guide text: \(key)")
            precondition(MenuLocalization.text(key, locale: locale) == translations[locale], "Guide text must resolve in \(locale)")
        }
    }
    let manager = FileManager.default
    let home = manager.temporaryDirectory.appendingPathComponent("heed-screen-guide-\(UUID().uuidString)")
    defer { try? manager.removeItem(at: home) }
    let app = home.appendingPathComponent("Applications/Heed.app")
    let contents = app.appendingPathComponent("Contents")
    let executable = contents.appendingPathComponent("MacOS/Heed")

    // A missing or replaced app must never become a draggable file URL.
    precondition(InstalledHeedApp.resolve(home: home, runningApp: app) == nil)
    try manager.createDirectory(at: executable.deletingLastPathComponent(), withIntermediateDirectories: true)
    try Data("#!/bin/sh\n".utf8).write(to: executable)
    try manager.setAttributes([.posixPermissions: 0o755], ofItemAtPath: executable.path)
    func writeInfo(_ identifier: String) throws {
        let info: [String: Any] = ["CFBundleIdentifier": identifier, "CFBundleExecutable": "Heed", "CFBundlePackageType": "APPL", "CFBundleVersion": "0.1.5"]
        let data = try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0)
        try data.write(to: contents.appendingPathComponent("Info.plist"))
    }
    try writeInfo("another.application")
    precondition(InstalledHeedApp.resolve(home: home, runningApp: app) == nil)
    try writeInfo("local.heed.menubar")
    precondition(InstalledHeedApp.resolve(home: home, runningApp: app, runningVersion: "0.1.5")?.path == app.path)
    precondition(InstalledHeedApp.resolve(home: home, runningApp: app, runningVersion: "0.1.4") == nil,
                 "An app replaced after this process launched must not be offered")
    precondition(InstalledHeedApp.resolve(home: home, runningApp: home.appendingPathComponent("Applications/Older-Heed.app")) == nil,
                 "A plausible app at the expected path must not be offered if another bundle is running")

    var granted = false
    var state = ScreenCaptureGuideState(home: home, runningApp: app, preflight: { granted })
    precondition(state.appURL?.path == app.path && state.canOfferAddSteps && !state.authorized)
    precondition(state.statusKey == "Screen recording is still not allowed. Add or enable Heed in System Settings, follow any quit and reopen prompt, then check again.")
    granted = true
    state.refresh()
    precondition(state.authorized && state.statusKey == "Screen recording access is allowed.", "Recheck must sample a fresh permission result")
    granted = false
    state.refresh()
    precondition(!state.authorized && state.statusKey == "Screen recording is still not allowed. Add or enable Heed in System Settings, follow any quit and reopen prompt, then check again.", "A later denial must replace a prior allowed result")

    try manager.removeItem(at: executable)
    state.refresh()
    precondition(state.appURL == nil && !state.canOfferAddSteps, "A removed or invalid installed app must disable drag and + instructions")
    precondition(state.statusKey == "Reinstall and reopen Heed before checking screen recording access again.")
    try manager.removeItem(at: app)
    precondition(InstalledHeedApp.resolve(home: home, runningApp: app) == nil)
}
