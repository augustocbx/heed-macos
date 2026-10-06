import AppKit
import Foundation
import AVFoundation
import CoreGraphics

struct PermissionRequest: Decodable { let id: String; let action: String }

struct MeetingStorageStatus: Decodable {let limitBytes: Int64;let usedBytes: Int64;let reservedBytes: Int64}
struct ControlStatus: Decodable {
    let recording: Bool
    let processing: Bool
    let seconds: Int
    let ready: Bool
    let clientConnected: Bool
    let error: String?
    let pending: Bool
    let starting: Bool?
    var storage: MeetingStorageStatus? = nil
    var uiLocale: String? = nil
    var permissionRequest: PermissionRequest? = nil
    var smbCommand: SmbDesktopCommand? = nil
    var meetingDetection: MeetingDetectionState? = nil
    var meetingId: String? = nil
    var state: String? = nil
    var maintenance: Bool? = nil
    var path: String? = nil
    var canStart: Bool { ready && !recording && !processing && !pending && starting != true && maintenance != true && (state != "failed" || path == nil) }
    var canStop: Bool { recording && !processing && !pending && starting != true && meetingId != nil }
    var canQuit: Bool { !recording && !processing && !pending && starting != true }
}
struct APIError: Decodable { let error: String }
func responseError(_ data: Data?, status: Int) -> String {
    if let data = data, let decoded = try? JSONDecoder().decode(APIError.self, from: data) { return decoded.error }
    return "Communication failed (HTTP \(status))"
}

func recordingStatusImage(_ recording: Bool, locale: String = "en") -> NSImage? {
    guard let image = NSImage(systemSymbolName: recording ? "record.circle.fill" : "waveform.circle",
                              accessibilityDescription: recording ? MenuLocalization.text("Heed recording", locale: locale) : "Heed") else { return nil }
    guard recording else { image.isTemplate = true; return image }
    // Bake the red palette into the symbol; a non-template image must not rely
    // on NSStatusBarButton applying contentTintColor.
    let colored = image.withSymbolConfiguration(NSImage.SymbolConfiguration(paletteColors: [.systemRed])) ?? image
    colored.isTemplate = false
    return colored
}

final class MenuController: NSObject, NSApplicationDelegate {
    private var item: NSStatusItem!
    private let storageMenu = NSMenuItem(title: "Local meeting storage", action: nil, keyEquivalent: "")
    private let statusMenu = NSMenuItem(title: "Preparing services…", action: nil, keyEquivalent: "")
    private let startMenu = NSMenuItem(title: "Start recording", action: #selector(startRecording), keyEquivalent: "")
    private let stopMenu = NSMenuItem(title: "Stop recording", action: #selector(stopRecording), keyEquivalent: "")
    private var locale = "en"
    private var localizedItems: [(NSMenuItem, String)] = []
    private var localeItems: [NSMenuItem] = []
    private func text(_ key: String) -> String { MenuLocalization.text(key, locale: locale) }
    private var state: ControlStatus?
    private var sending = false
    private var polling = false
    private var timer: Timer?
    private var slackDetector = SlackHuddleDetector()
    private lazy var detectionClient = MeetingDetectionClient(session: session)
    private let zoomDetector = AccessibleMeetingDetector(bundleIdentifiers: ["us.zoom.xos"])
    private let teamsDetector = AccessibleMeetingDetector(bundleIdentifiers: ["com.microsoft.teams2", "com.microsoft.teams"])
    private var detectionMenus: [String: NSMenuItem] = [:]
    private var detectionStates: [String: NSMenuItem] = [:]
    private let accessibilityMenu = NSMenuItem(title: "Authorize Accessibility", action: #selector(authorizeAccessibility), keyEquivalent: "")
    private let slackAutoMenu = NSMenuItem(title: "Automatically record Slack meetings", action: #selector(toggleSlackAuto), keyEquivalent: "")
    private let slackStateMenu = NSMenuItem(title: "Slack: waiting for the next meeting", action: nil, keyEquivalent: "")
    private var lastSlackObservation: String?
    private let slackLogAccess = SlackLogAccess()
    private let smbFolderAccess = SmbFolderAccess()
    private var requestingSlackAccess = false
    private var promptedForSlackAccess = false
    private var permissionCommandID: String?
    private var lastPermissionCommandID: String?
    private var reportingPermissions = false
    private let slackAccessMenu = NSMenuItem(title: "Allow Slack log access…", action: #selector(authorizeSlackLogs), keyEquivalent: "")
    private let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 6
        return URLSession(configuration: config)
    }()
    func applicationDidFinishLaunching(_ notification: Notification) {
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        let menu = NSMenu()
        menu.autoenablesItems = false
        statusMenu.isEnabled = false
        menu.addItem(statusMenu)
        storageMenu.isEnabled = false;menu.addItem(storageMenu)
        menu.addItem(NSMenuItem.separator())
        for entry in [startMenu, stopMenu] { entry.target = self; entry.isEnabled = false; menu.addItem(entry) }
        let open = NSMenuItem(title: "Open interface", action: #selector(openInterface), keyEquivalent: "")
        open.target = self; menu.addItem(open)
        let settings = NSMenuItem(title: "Settings and permissions…", action: #selector(openSettings), keyEquivalent: "")
        settings.target = self; menu.addItem(settings)
        slackAutoMenu.target = self; menu.addItem(slackAutoMenu)
        slackStateMenu.isEnabled = false; menu.addItem(slackStateMenu)
        slackAccessMenu.target = self; menu.addItem(slackAccessMenu)
        for app in ["zoom", "teams", "meet"] {
            let key = app == "zoom" ? "Automatically record Zoom meetings" : app == "teams" ? "Automatically record Teams meetings" : "Automatically record Google Meet meetings"
            let toggle = NSMenuItem(title: key, action: #selector(toggleMeetingAuto(_:)), keyEquivalent: "")
            toggle.target = self; toggle.representedObject = app; menu.addItem(toggle); detectionMenus[app] = toggle
            let status = NSMenuItem(title: "", action: nil, keyEquivalent: ""); status.isEnabled = false; menu.addItem(status); detectionStates[app] = status
        }
        accessibilityMenu.target = self; menu.addItem(accessibilityMenu)
        menu.addItem(NSMenuItem.separator())
        let quit = NSMenuItem(title: "Quit menu app", action: #selector(quitApp), keyEquivalent: "")
        quit.target = self; menu.addItem(quit)
        localizedItems = [(startMenu, "Start recording"), (stopMenu, "Stop recording"),
            (open, "Open interface"), (settings, "Settings and permissions…"),
            (slackAutoMenu, "Automatically record Slack meetings"),
            (slackAccessMenu, "Allow Slack log access…"), (quit, "Quit menu app")]
        let languageMenu = NSMenu()
        for (title, code) in [("English", "en"), ("Português (Brasil)", "pt-BR"), ("Français", "fr"), ("Deutsch", "de")] {
            let entry = NSMenuItem(title: title, action: #selector(selectLocale(_:)), keyEquivalent: "")
            entry.target = self; entry.representedObject = code
            languageMenu.addItem(entry); localeItems.append(entry)
        }
        let language = NSMenuItem(title: "Interface language", action: nil, keyEquivalent: "")
        language.submenu = languageMenu; menu.insertItem(language, at: 6)
        localizedItems.append((language, "Interface language"))
        localizedItems.append((accessibilityMenu, "Authorize Accessibility"))
        for (app, entry) in detectionMenus { localizedItems.append((entry, app == "zoom" ? "Automatically record Zoom meetings" : app == "teams" ? "Automatically record Teams meetings" : "Automatically record Google Meet meetings")) }
        item.menu = menu
        if let folder = slackLogAccess.restore() { slackDetector.setAuthorizedLogRoot(folder) }
        smbFolderAccess.restore()
        updateMenu(); bootServices(); poll()
        timer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in self?.poll() }
    }
    private func bootServices() {
        guard let script = Bundle.main.path(forResource: "start-services", ofType: "sh") else { return }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/bash")
        process.arguments = [script]
        try? process.run()
    }
    private func poll() {
        guard !polling else { return }
        polling = true
        let url = URL(string: "http://127.0.0.1:5001/api/desktop/control/status")!
        session.dataTask(with: url) { [weak self] data, response, error in
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.polling = false
                if let data = data, (response as? HTTPURLResponse)?.statusCode == 200,
                   let state = try? JSONDecoder().decode(ControlStatus.self, from: data) {
                    self.state = state
                    self.locale = MenuLocalization.normalize(state.uiLocale)
                    self.statusMenu.title = state.error.map { MenuLocalization.message($0, locale: self.locale) } ?? (state.recording ? "\(self.text("Recording")) • \(state.seconds / 60):\(String(format: "%02d", state.seconds % 60))" : state.processing ? self.text("Processing meeting…") : state.pending ? self.text("Waiting for the interface…") : state.ready ? self.text("Ready to record") : self.text("Preparing services…"))
                } else {
                    self.state = nil
                    self.statusMenu.title = self.text("Service unavailable — open the interface")
                }
                self.updateMenu()
                if let request = self.state?.permissionRequest { self.executePermissionRequest(request) }
                if let command = self.state?.smbCommand { self.smbFolderAccess.execute(command, locale: self.locale) }
                self.checkMeetings()
                self.reportPermissions()
            }
        }.resume()
    }
    private func updateMenu() {
        if let storage = state?.storage {
            let number = NumberFormatter();number.locale = Locale(identifier: locale);number.maximumFractionDigits = 3
            let used = number.string(from: NSNumber(value: Double(storage.usedBytes) / 1_000_000_000)) ?? "?"
            let limit = number.string(from: NSNumber(value: Double(storage.limitBytes) / 1_000_000_000)) ?? "?"
            storageMenu.title = "\(text("Local meeting storage")): \(used) / \(limit) GB"
        } else { storageMenu.title = text("Local meeting storage") }
        for (entry, key) in localizedItems { entry.title = text(key) }
        for entry in localeItems { entry.state = (entry.representedObject as? String) == locale ? .on : .off }
        slackAutoMenu.state = slackAutoEnabled ? .on : .off
        slackAutoMenu.isEnabled = state?.meetingDetection != nil
        for (app, entry) in detectionMenus {
            entry.state = state?.meetingDetection?.enabled[app] == true ? .on : .off
            entry.isEnabled = state?.meetingDetection != nil
        }
        startMenu.isEnabled = !sending && (state?.canStart ?? false) && captureAuthorized
        stopMenu.isEnabled = !sending && (state?.canStop ?? false)
        let recording = state?.recording ?? false
        item.button?.image = recordingStatusImage(recording, locale: locale)
        item.button?.contentTintColor = recording ? .systemRed : nil
        item.button?.toolTip = "Heed — \(statusMenu.title)"
    }
    private var slackAutoEnabled: Bool {
        if !UserDefaults.standard.bool(forKey: "HeedDetectionSettingsMigrated"), UserDefaults.standard.object(forKey: "HeedSlackAutoRecord") != nil { return UserDefaults.standard.bool(forKey: "HeedSlackAutoRecord") }
        return state?.meetingDetection?.enabled["slack"] ?? false
    }
    private func checkMeetings() {
        guard let detection = state?.meetingDetection else { return }
        if !UserDefaults.standard.bool(forKey: "HeedDetectionSettingsMigrated"), UserDefaults.standard.object(forKey: "HeedSlackAutoRecord") != nil {
            detectionClient.configure(app: "slack", enabled: UserDefaults.standard.bool(forKey: "HeedSlackAutoRecord")) { accepted in
                if accepted { UserDefaults.standard.set(true, forKey: "HeedDetectionSettingsMigrated") }
            }
        } else { UserDefaults.standard.set(true, forKey: "HeedDetectionSettingsMigrated") }
        let slackRunning = NSWorkspace.shared.runningApplications.contains { $0.bundleIdentifier == "com.tinyspeck.slackmacgap" }
        var slackSignal: Bool? = nil
        if slackAutoEnabled {
            slackSignal = slackDetector.poll(slackRunning: slackRunning)
            if slackRunning && !slackDetector.hasObservedState { slackSignal = nil }
        }
        let slackCapability = !slackAutoEnabled ? "degraded" : slackSignal != nil ? "ready" : slackDetector.canReadLogs ? "degraded" : "permission-required"
        detectionClient.report(app: "slack", signal: slackSignal, capability: slackCapability)
        let observation = !slackAutoEnabled ? "disabled" : !slackRunning ? "closed" : slackSignal == nil ? "unavailable" : slackSignal == true ? "meeting detected" : "waiting for the next meeting"
        slackStateMenu.title = "Slack: \(text(observation))"
        if lastSlackObservation != observation { logSlack(observation); lastSlackObservation = observation }
        if slackAutoEnabled && slackRunning && !slackDetector.canReadLogs && !promptedForSlackAccess { authorizeSlackLogs() }
        for (app, detector) in [("zoom", zoomDetector), ("teams", teamsDetector)] {
            let enabled = detection.enabled[app] == true
            let result = enabled ? detector.poll() : (nil, "degraded")
            detectionClient.report(app: app, signal: result.0, capability: result.1)
        }
        for (app, entry) in detectionStates {
            let sources = detection.sources.filter { $0.app == app }
            let key = detection.enabled[app] != true ? "disabled" : sources.contains(where: { $0.suppressed }) ? "Paused for this call" : sources.contains(where: { $0.capability == "permission-required" }) ? "Accessibility permission needed" : sources.contains(where: { $0.capability != "ready" }) ? "Detection unavailable — use manual recording" : sources.contains(where: { $0.state == "active" }) ? "meeting detected" : sources.isEmpty ? "Not checked" : "waiting for the next meeting"
            entry.title = "\(app == "meet" ? "Google Meet" : app == "teams" ? "Teams" : "Zoom"): \(text(key))"
        }
        if let seconds = detection.reconnectSeconds, seconds > 0 { statusMenu.title = MenuLocalization.format("Waiting for reconnect — %@s", locale: locale, value: String(seconds)) }
        if let error = detection.error { statusMenu.title = MenuLocalization.message(error, locale: locale) }
    }
    private var microphonePermission: String {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: return "authorized"
        case .denied: return "denied"
        case .restricted: return "restricted"
        case .notDetermined: return "notDetermined"
        @unknown default: return "unknown"
        }
    }
    private var captureAuthorized: Bool { microphonePermission == "authorized" && CGPreflightScreenCaptureAccess() }
    private func reportPermissions(commandID: String? = nil, error: String? = nil) {
        guard !reportingPermissions || commandID != nil else { return }
        reportingPermissions = true
        var payload: [String: Any] = ["permissions": ["microphone": microphonePermission,
            "screenCapture": CGPreflightScreenCaptureAccess(), "slackLogs": slackAutoEnabled ? slackDetector.canReadLogs as Any : NSNull(),
            "slackAutoRecord": slackAutoEnabled]]
        if let commandID = commandID { payload["commandId"] = commandID }
        if let error = error { payload["error"] = error }
        var request = URLRequest(url: URL(string: "http://127.0.0.1:5001/api/desktop/permissions/report")!)
        request.httpMethod = "POST"; request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: payload)
        session.dataTask(with: request) { [weak self] _, _, _ in
            DispatchQueue.main.async { self?.reportingPermissions = false }
        }.resume()
    }
    private func executePermissionRequest(_ request: PermissionRequest) {
        guard permissionCommandID == nil, lastPermissionCommandID != request.id else { return }
        permissionCommandID = request.id; lastPermissionCommandID = request.id
        let finish: (String?) -> Void = { [weak self] error in
            guard let self = self else { return }
            self.permissionCommandID = nil
            self.reportPermissions(commandID: request.id, error: error)
        }
        switch request.action {
        case "microphone":
            if microphonePermission == "notDetermined" {
                AVCaptureDevice.requestAccess(for: .audio) { granted in
                    DispatchQueue.main.async { finish(granted ? nil : self.text("Allow microphone access for Heed in System Settings.")) }
                }
            } else { openPrivacyPane("Privacy_Microphone"); finish(nil) }
        case "screenCapture":
            if !CGPreflightScreenCaptureAccess() { _ = CGRequestScreenCaptureAccess() }
            openPrivacyPane("Privacy_ScreenCapture"); finish(nil)
        case "slackLogs":
            requestSlackLogFolder(completion: finish)
        case "accessibility":
            authorizeAccessibility(); finish(nil)
        default: finish(text("Unknown authorization request."))
        }
    }
    private func openPrivacyPane(_ pane: String) {
        NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?\(pane)")!)
    }
    private func logSlack(_ message: String) {
        let root = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/Heed")
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let file = root.appendingPathComponent("slack-auto.log")
        let line = Data("\(ISO8601DateFormatter().string(from: Date())) \(message)\n".utf8)
        if let size = (try? FileManager.default.attributesOfItem(atPath: file.path)[.size]) as? NSNumber, size.intValue > 262_144 {
            try? line.write(to: file, options: .atomic)
        } else if let handle = try? FileHandle(forWritingTo: file) {
            defer { try? handle.close() }
            _ = try? handle.seekToEnd(); try? handle.write(contentsOf: line)
        } else { try? line.write(to: file, options: .atomic) }
    }
    private func command(_ action: String) {
        guard !sending else { return }
        sending = true; updateMenu()
        var request = URLRequest(url: URL(string: "http://127.0.0.1:5001/api/desktop/control/commands")!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 600
        var payload: [String: Any] = ["action": action, "language": "en", "requestId": UUID().uuidString]
        if action == "stop", let meetingId = state?.meetingId { payload["meetingId"] = meetingId }
        request.httpBody = try? JSONSerialization.data(withJSONObject: payload)
        session.dataTask(with: request) { [weak self] data, response, error in
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.sending = false
                let accepted = (response as? HTTPURLResponse).map { (200..<300).contains($0.statusCode) } ?? false
                if accepted {
                    self.poll()
                } else {
                    self.statusMenu.title = MenuLocalization.message(error?.localizedDescription ?? responseError(data, status: (response as? HTTPURLResponse)?.statusCode ?? 0), locale: self.locale)
                    self.updateMenu()
                }
            }
        }.resume()
    }
    @objc private func selectLocale(_ sender: NSMenuItem) {
        guard let selected = sender.representedObject as? String, MenuLocalization.locales.contains(selected) else { return }
        var request = URLRequest(url: URL(string: "http://127.0.0.1:5001/api/ui-locale")!)
        request.httpMethod = "POST"; request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["locale": selected])
        session.dataTask(with: request) { [weak self] data, response, _ in
            DispatchQueue.main.async {
                guard let self = self else { return }
                if (response as? HTTPURLResponse)?.statusCode == 200,
                   let data = data, let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                   let saved = body["locale"] as? String {
                    self.locale = MenuLocalization.normalize(saved); self.updateMenu(); self.poll()
                } else { self.statusMenu.title = self.text("Could not save the interface language. Try again.") }
            }
        }.resume()
    }
    @objc private func startRecording() { command("start") }
    @objc private func stopRecording() { command("stop") }
    @objc private func openInterface() { bootServices(); NSWorkspace.shared.open(URL(string: "http://localhost:5170")!) }
    @objc private func openSettings() { bootServices(); NSWorkspace.shared.open(URL(string: "http://localhost:5170/#settings")!) }
    @objc private func toggleSlackAuto() { configureDetection(app: "slack", enabled: !slackAutoEnabled) }
    @objc private func toggleMeetingAuto(_ sender: NSMenuItem) {
        guard let app = sender.representedObject as? String else { return }
        configureDetection(app: app, enabled: state?.meetingDetection?.enabled[app] != true)
    }
    private func configureDetection(app: String, enabled: Bool) {
        detectionClient.configure(app: app, enabled: enabled) { [weak self] accepted in
            guard let self = self else { return }
            if accepted {
                if app == "slack" { UserDefaults.standard.set(enabled, forKey: "HeedSlackAutoRecord") }
                self.poll()
            } else { self.statusMenu.title = self.text("Could not save meeting detection settings.") }
        }
    }
    @objc private func authorizeAccessibility() { AccessibleMeetingDetector.requestAccess(); openPrivacyPane("Privacy_Accessibility") }
    @objc private func authorizeSlackLogs() { requestSlackLogFolder(completion: nil) }
    private func requestSlackLogFolder(completion: ((String?) -> Void)?) {
        guard !requestingSlackAccess else { completion?(text("The Slack log authorization dialog is already open.")); return }
        requestingSlackAccess = true; promptedForSlackAccess = true
        slackAccessMenu.isEnabled = false
        slackLogAccess.request(locale: locale) { [weak self] folder in
            guard let self = self else { return }
            self.requestingSlackAccess = false; self.slackAccessMenu.isEnabled = true
            if let folder = folder { self.slackDetector.setAuthorizedLogRoot(folder); self.logSlack("log folder authorized") }
            else { self.logSlack("folder authorization was not completed") }
            if let diagnostic = self.slackLogAccess.diagnostic { self.logSlack(diagnostic) }
            completion?(folder == nil ? self.slackLogAccess.diagnostic.map { MenuLocalization.message($0, locale: self.locale) } : nil)
            self.poll()
        }
    }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        // Fresh backend state covers capture/finalization started from another tab or menu.
        session.dataTask(with: URL(string: "http://127.0.0.1:5001/api/desktop/control/status")!) { [weak self] data, response, error in
            DispatchQueue.main.async {
                guard let self = self else { sender.reply(toApplicationShouldTerminate: false); return }
                let latest = data.flatMap { try? JSONDecoder().decode(ControlStatus.self, from: $0) }
                let allowed = (response as? HTTPURLResponse)?.statusCode == 200 && latest?.canQuit == true
                if !allowed {
                    self.statusMenu.title = self.text(latest == nil ? "Could not check recording status. Try again before quitting." : "Finish the active meeting before quitting Heed.")
                    self.updateMenu()
                }
                sender.reply(toApplicationShouldTerminate: allowed)
            }
        }.resume()
        return .terminateLater
    }
    @objc private func quitApp() { NSApplication.shared.terminate(nil) }
}

if CommandLine.arguments.contains("--self-test") {
    func status(_ recording: Bool = false, _ processing: Bool = false, _ ready: Bool = true, _ pending: Bool = false) -> ControlStatus {
        ControlStatus(recording: recording, processing: processing, seconds: 0, ready: ready, clientConnected: true, error: nil, pending: pending, starting: false, meetingId: recording ? "fixture" : nil)
    }
    precondition(recordingStatusImage(false)?.isTemplate == true)
    precondition(recordingStatusImage(true)?.isTemplate == false)
    if let data = recordingStatusImage(true)?.tiffRepresentation,
       let bitmap = NSBitmapImageRep(data: data) {
        var redPixelFound = false
        for y in 0..<bitmap.pixelsHigh {
            for x in 0..<bitmap.pixelsWide {
                if let color = bitmap.colorAt(x: x, y: y)?.usingColorSpace(.deviceRGB),
                   color.alphaComponent > 0.5, color.redComponent > color.greenComponent * 1.5,
                   color.redComponent > color.blueComponent * 1.5 { redPixelFound = true }
            }
        }
        precondition(redPixelFound, "The recording symbol must render red pixels")
    } else { preconditionFailure("The recording symbol must be renderable") }
    precondition(status().canStart && !status().canStop)
    precondition(!status(true).canStart && status(true).canStop)
    precondition(!status(false, true).canStart)
    precondition(!status(true).canQuit && !status(false, true).canQuit && status().canQuit)
    precondition(!status(false, false, false).canStart)
    precondition(!status(true, false, true, true).canStop)
    var retryable = status(); retryable.state = "failed"; precondition(retryable.canStart)
    retryable.path = "/synthetic/retained.wav"; precondition(!retryable.canStart)
    var untargeted = status(true); untargeted.meetingId = nil; precondition(!untargeted.canStop)
    precondition(responseError(Data("{\"error\":\"Permission required\"}".utf8), status: 409) == "Permission required")
    precondition(responseError(nil, status: 500).contains("500"))
    menuInstanceLockSelfTests()
    menuLocalizationSelfTests()
    try slackRecordingPolicySelfTest()
    try slackHuddleDetectorSelfTests()
    try slackLogAccessSelfTests()
    try accessibleMeetingDetectorSelfTests()
    try meetingDetectionClientSelfTests()
    try smbFolderAccessSelfTests()
    print("Heed menubar self-tests passed")
} else {
    let lockURL = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Application Support/Heed/menubar.lock")
    guard let instanceLock = MenuInstanceLock(url: lockURL) else { exit(0) }
    // During an upgrade an older app may not yet hold this lock. Retain the
    // earliest process rather than creating another menu icon beside it.
    if let bundleID = Bundle.main.bundleIdentifier,
       NSRunningApplication.runningApplications(withBundleIdentifier: bundleID)
        .contains(where: { $0.processIdentifier < getpid() && !$0.isTerminated }) { exit(0) }
    let app = NSApplication.shared
    let controller = MenuController()
    app.delegate = controller
    app.setActivationPolicy(.accessory)
    withExtendedLifetime(instanceLock) { app.run() }
}
