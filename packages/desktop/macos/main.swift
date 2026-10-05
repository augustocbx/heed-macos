import AppKit
import Foundation
import AVFoundation
import CoreGraphics

struct PermissionRequest: Decodable { let id: String; let action: String }

struct ControlStatus: Decodable {
    let recording: Bool
    let processing: Bool
    let seconds: Int
    let ready: Bool
    let clientConnected: Bool
    let error: String?
    let pending: Bool
    let starting: Bool?
    var permissionRequest: PermissionRequest? = nil
    var canStart: Bool { ready && !recording && !processing && !pending && starting != true }
    var canStop: Bool { recording && !pending }
}
struct APIError: Decodable { let error: String }
func responseError(_ data: Data?, status: Int) -> String {
    if let data = data, let decoded = try? JSONDecoder().decode(APIError.self, from: data) { return decoded.error }
    return "Communication failed (HTTP \(status))"
}

func recordingStatusImage(_ recording: Bool) -> NSImage? {
    guard let image = NSImage(systemSymbolName: recording ? "record.circle.fill" : "waveform.circle",
                              accessibilityDescription: recording ? "Heed recording" : "Heed") else { return nil }
    guard recording else { image.isTemplate = true; return image }
    // Bake the red palette into the symbol; a non-template image must not rely
    // on NSStatusBarButton applying contentTintColor.
    let colored = image.withSymbolConfiguration(NSImage.SymbolConfiguration(paletteColors: [.systemRed])) ?? image
    colored.isTemplate = false
    return colored
}

final class MenuController: NSObject, NSApplicationDelegate {
    private var item: NSStatusItem!
    private let statusMenu = NSMenuItem(title: "Preparing services…", action: nil, keyEquivalent: "")
    private let startMenu = NSMenuItem(title: "Start recording", action: #selector(startRecording), keyEquivalent: "")
    private let stopMenu = NSMenuItem(title: "Stop recording", action: #selector(stopRecording), keyEquivalent: "")
    private var state: ControlStatus?
    private var sending = false
    private var polling = false
    private var timer: Timer?
    private var slackDetector = SlackHuddleDetector()
    private var slackPolicy = SlackRecordingPolicy()
    private let slackAutoMenu = NSMenuItem(title: "Automatically record Slack meetings", action: #selector(toggleSlackAuto), keyEquivalent: "")
    private let slackStateMenu = NSMenuItem(title: "Slack: waiting for the next meeting", action: nil, keyEquivalent: "")
    private var lastSlackObservation: String?
    private let slackLogAccess = SlackLogAccess()
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
        menu.addItem(NSMenuItem.separator())
        for entry in [startMenu, stopMenu] { entry.target = self; entry.isEnabled = false; menu.addItem(entry) }
        let open = NSMenuItem(title: "Open interface", action: #selector(openInterface), keyEquivalent: "")
        open.target = self; menu.addItem(open)
        let settings = NSMenuItem(title: "Settings and permissions…", action: #selector(openSettings), keyEquivalent: "")
        settings.target = self; menu.addItem(settings)
        slackAutoMenu.target = self; menu.addItem(slackAutoMenu)
        slackStateMenu.isEnabled = false; menu.addItem(slackStateMenu)
        slackAccessMenu.target = self; menu.addItem(slackAccessMenu)
        menu.addItem(NSMenuItem.separator())
        let quit = NSMenuItem(title: "Quit menu app", action: #selector(quitApp), keyEquivalent: "")
        quit.target = self; menu.addItem(quit)
        item.menu = menu
        if let folder = slackLogAccess.restore() { slackDetector.setAuthorizedLogRoot(folder) }
        _ = slackDetector.poll(slackRunning: NSWorkspace.shared.runningApplications.contains { $0.bundleIdentifier == "com.tinyspeck.slackmacgap" })
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
                    self.statusMenu.title = state.error ?? (state.recording ? "Recording • \(state.seconds / 60):\(String(format: "%02d", state.seconds % 60))" : state.processing ? "Processing meeting…" : state.pending ? "Waiting for the interface…" : state.ready ? "Ready to record" : "Preparing services…")
                } else {
                    self.state = nil
                    self.statusMenu.title = "Service unavailable — open the interface"
                }
                self.updateMenu()
                if let request = self.state?.permissionRequest { self.executePermissionRequest(request) }
                self.checkSlackMeeting()
                self.reportPermissions()
            }
        }.resume()
    }
    private func updateMenu() {
        slackAutoMenu.state = slackAutoEnabled ? .on : .off
        startMenu.isEnabled = !sending && (state?.canStart ?? false) && captureAuthorized
        stopMenu.isEnabled = !sending && (state?.canStop ?? false)
        let recording = state?.recording ?? false
        item.button?.image = recordingStatusImage(recording)
        item.button?.contentTintColor = recording ? .systemRed : nil
        item.button?.toolTip = "Heed — \(statusMenu.title)"
    }
    private var slackAutoEnabled: Bool {
        UserDefaults.standard.object(forKey: "HeedSlackAutoRecord") == nil || UserDefaults.standard.bool(forKey: "HeedSlackAutoRecord")
    }
    private func checkSlackMeeting() {
        slackPolicy.enabled = slackAutoEnabled
        let status = state.map { SlackRecordingPolicy.Status(recording: $0.recording, processing: $0.processing,
            pending: $0.pending || sending || permissionCommandID != nil, starting: $0.starting == true,
            ready: $0.ready && captureAuthorized, clientConnected: $0.clientConnected) }
        let slackRunning = NSWorkspace.shared.runningApplications.contains { $0.bundleIdentifier == "com.tinyspeck.slackmacgap" }
        let signal = slackDetector.poll(slackRunning: slackRunning)
        let observation = !slackAutoEnabled ? "disabled" : !slackRunning ? "closed" : signal == nil ? "unavailable" : signal == true ? "meeting detected" : "waiting for the next meeting"
        slackStateMenu.title = "Slack: \(observation)"
        if lastSlackObservation != observation { logSlack(observation); lastSlackObservation = observation }
        let effects = slackPolicy.evaluate(signal: signal, status: status, now: ProcessInfo.processInfo.systemUptime)
        if slackAutoEnabled && slackRunning && signal == nil && !promptedForSlackAccess { authorizeSlackLogs() }
        for effect in effects {
            switch effect {
            case .openInterface: openInterface()
            case .start(let callID): command("start", slackCallID: callID)
            case .stop(let callID): command("stop", slackCallID: callID)
            }
        }
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
            "screenCapture": CGPreflightScreenCaptureAccess(), "slackLogs": slackDetector.canReadLogs,
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
                    DispatchQueue.main.async { finish(granted ? nil : "Allow microphone access for Heed in System Settings.") }
                }
            } else { openPrivacyPane("Privacy_Microphone"); finish(nil) }
        case "screenCapture":
            if !CGPreflightScreenCaptureAccess() { _ = CGRequestScreenCaptureAccess() }
            openPrivacyPane("Privacy_ScreenCapture"); finish(nil)
        case "slackLogs":
            requestSlackLogFolder(completion: finish)
        default: finish("Unknown authorization request.")
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
    private func command(_ action: String, slackCallID: Int? = nil) {
        guard !sending else { return }
        sending = true; updateMenu()
        var request = URLRequest(url: URL(string: "http://127.0.0.1:5001/api/desktop/control/commands")!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["action": action, "language": "en"])
        session.dataTask(with: request) { [weak self] data, response, error in
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.sending = false
                let accepted = (response as? HTTPURLResponse).map { (200..<300).contains($0.statusCode) } ?? false
                if let callID = slackCallID {
                    if action == "start" {
                        self.slackPolicy.commandCompleted(callID: callID, accepted: accepted, now: ProcessInfo.processInfo.systemUptime)
                    } else {
                        self.slackPolicy.stopCommandCompleted(callID: callID, accepted: accepted, now: ProcessInfo.processInfo.systemUptime)
                    }
                    self.logSlack(accepted ? "automatic \(action) accepted" : "automatic \(action) request failed")
                }
                if accepted {
                    if slackCallID == nil { self.openInterface() }
                    self.poll()
                } else {
                    self.statusMenu.title = error?.localizedDescription ?? responseError(data, status: (response as? HTTPURLResponse)?.statusCode ?? 0)
                    self.updateMenu()
                }
            }
        }.resume()
    }
    @objc private func startRecording() { command("start") }
    @objc private func stopRecording() { command("stop") }
    @objc private func openInterface() { bootServices(); NSWorkspace.shared.open(URL(string: "http://localhost:5170")!) }
    @objc private func openSettings() { bootServices(); NSWorkspace.shared.open(URL(string: "http://localhost:5170/#settings")!) }
    @objc private func toggleSlackAuto() { UserDefaults.standard.set(!slackAutoEnabled, forKey: "HeedSlackAutoRecord"); updateMenu() }
    @objc private func authorizeSlackLogs() { requestSlackLogFolder(completion: nil) }
    private func requestSlackLogFolder(completion: ((String?) -> Void)?) {
        guard !requestingSlackAccess else { completion?("The Slack log authorization dialog is already open."); return }
        requestingSlackAccess = true; promptedForSlackAccess = true
        slackAccessMenu.isEnabled = false
        slackLogAccess.request { [weak self] folder in
            guard let self = self else { return }
            self.requestingSlackAccess = false; self.slackAccessMenu.isEnabled = true
            if let folder = folder { self.slackDetector.setAuthorizedLogRoot(folder); self.logSlack("log folder authorized") }
            else { self.logSlack("folder authorization was not completed") }
            if let diagnostic = self.slackLogAccess.diagnostic { self.logSlack(diagnostic) }
            completion?(folder == nil ? self.slackLogAccess.diagnostic : nil)
            self.poll()
        }
    }
    @objc private func quitApp() { NSApplication.shared.terminate(nil) }
}

if CommandLine.arguments.contains("--self-test") {
    func status(_ recording: Bool = false, _ processing: Bool = false, _ ready: Bool = true, _ pending: Bool = false) -> ControlStatus {
        ControlStatus(recording: recording, processing: processing, seconds: 0, ready: ready, clientConnected: true, error: nil, pending: pending, starting: false)
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
    precondition(!status(false, false, false).canStart)
    precondition(!status(true, false, true, true).canStop)
    precondition(responseError(Data("{\"error\":\"Permission required\"}".utf8), status: 409) == "Permission required")
    precondition(responseError(nil, status: 500).contains("500"))
    try slackRecordingPolicySelfTest()
    try slackHuddleDetectorSelfTests()
    try slackLogAccessSelfTests()
    print("Heed menubar self-tests passed")
} else {
    let app = NSApplication.shared
    let controller = MenuController()
    app.delegate = controller
    app.setActivationPolicy(.accessory)
    app.run()
}
