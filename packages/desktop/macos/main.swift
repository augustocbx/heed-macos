import AppKit
import Foundation

struct ControlStatus: Decodable {
    let recording: Bool
    let processing: Bool
    let seconds: Int
    let ready: Bool
    let clientConnected: Bool
    let error: String?
    let pending: Bool
    let starting: Bool?
    var canStart: Bool { ready && !recording && !processing && !pending && starting != true }
    var canStop: Bool { recording && !pending }
}
struct APIError: Decodable { let error: String }
func responseError(_ data: Data?, status: Int) -> String {
    if let data = data, let decoded = try? JSONDecoder().decode(APIError.self, from: data) { return decoded.error }
    return "Falha na comunicação (HTTP \(status))"
}

final class MenuController: NSObject, NSApplicationDelegate {
    private var item: NSStatusItem!
    private let statusMenu = NSMenuItem(title: "Preparando serviços…", action: nil, keyEquivalent: "")
    private let startMenu = NSMenuItem(title: "Iniciar gravação", action: #selector(startRecording), keyEquivalent: "")
    private let stopMenu = NSMenuItem(title: "Parar gravação", action: #selector(stopRecording), keyEquivalent: "")
    private var languages: [NSMenuItem] = []
    private var state: ControlStatus?
    private var sending = false
    private var polling = false
    private var timer: Timer?
    private var slackDetector = SlackHuddleDetector()
    private var slackPolicy = SlackRecordingPolicy()
    private let slackAutoMenu = NSMenuItem(title: "Gravar automaticamente reuniões do Slack", action: #selector(toggleSlackAuto), keyEquivalent: "")
    private let slackStateMenu = NSMenuItem(title: "Slack: aguardando próxima reunião", action: nil, keyEquivalent: "")
    private var lastSlackObservation: String?
    private let slackLogAccess = SlackLogAccess()
    private var requestingSlackAccess = false
    private var promptedForSlackAccess = false
    private let slackAccessMenu = NSMenuItem(title: "Autorizar registros do Slack…", action: #selector(authorizeSlackLogs), keyEquivalent: "")
    private let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 6
        return URLSession(configuration: config)
    }()
    private var language: String { UserDefaults.standard.string(forKey: "HeedLanguage") == "en" ? "en" : "pt" }
    func applicationDidFinishLaunching(_ notification: Notification) {
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        let menu = NSMenu()
        menu.autoenablesItems = false
        statusMenu.isEnabled = false
        menu.addItem(statusMenu)
        menu.addItem(NSMenuItem.separator())
        for entry in [startMenu, stopMenu] { entry.target = self; entry.isEnabled = false; menu.addItem(entry) }
        let open = NSMenuItem(title: "Abrir interface", action: #selector(openInterface), keyEquivalent: "")
        open.target = self; menu.addItem(open)
        let languageMenu = NSMenu()
        for (title, code) in [("Português", "pt"), ("English", "en")] {
            let entry = NSMenuItem(title: title, action: #selector(selectLanguage(_:)), keyEquivalent: "")
            entry.target = self; entry.representedObject = code
            languageMenu.addItem(entry); languages.append(entry)
        }
        let languageEntry = NSMenuItem(title: "Idioma da reunião", action: nil, keyEquivalent: "")
        languageEntry.submenu = languageMenu; menu.addItem(languageEntry)
        slackAutoMenu.target = self; menu.addItem(slackAutoMenu)
        slackStateMenu.isEnabled = false; menu.addItem(slackStateMenu)
        slackAccessMenu.target = self; menu.addItem(slackAccessMenu)
        menu.addItem(NSMenuItem.separator())
        let quit = NSMenuItem(title: "Sair do ícone", action: #selector(quitApp), keyEquivalent: "")
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
                    self.statusMenu.title = state.error ?? (state.recording ? "Gravando • \(state.seconds / 60):\(String(format: "%02d", state.seconds % 60))" : state.processing ? "Processando reunião…" : state.pending ? "Aguardando interface…" : state.ready ? "Pronto para gravar" : "Preparando serviços…")
                } else {
                    self.state = nil
                    self.statusMenu.title = "Serviço indisponível — abra a interface"
                }
                self.updateMenu()
                self.checkSlackMeeting()
            }
        }.resume()
    }
    private func updateMenu() {
        slackAutoMenu.state = slackAutoEnabled ? .on : .off
        startMenu.isEnabled = !sending && (state?.canStart ?? false)
        stopMenu.isEnabled = !sending && (state?.canStop ?? false)
        for entry in languages { entry.state = (entry.representedObject as? String) == language ? .on : .off; entry.isEnabled = !sending && !(state?.recording ?? false) && !(state?.pending ?? false) }
        let recording = state?.recording ?? false
        let image = NSImage(systemSymbolName: recording ? "record.circle.fill" : "waveform.circle", accessibilityDescription: recording ? "Heed gravando" : "Heed")
        image?.isTemplate = !recording
        item.button?.image = image
        item.button?.contentTintColor = recording ? .systemRed : nil
        item.button?.toolTip = "Heed — \(statusMenu.title)"
    }
    private var slackAutoEnabled: Bool {
        UserDefaults.standard.object(forKey: "HeedSlackAutoRecord") == nil || UserDefaults.standard.bool(forKey: "HeedSlackAutoRecord")
    }
    private func checkSlackMeeting() {
        slackPolicy.enabled = slackAutoEnabled
        let status = state.map { SlackRecordingPolicy.Status(recording: $0.recording, processing: $0.processing,
            pending: $0.pending || sending, starting: $0.starting == true, ready: $0.ready, clientConnected: $0.clientConnected) }
        let slackRunning = NSWorkspace.shared.runningApplications.contains { $0.bundleIdentifier == "com.tinyspeck.slackmacgap" }
        let signal = slackDetector.poll(slackRunning: slackRunning)
        let observation = !slackAutoEnabled ? "desabilitado" : !slackRunning ? "fechado" : signal == nil ? "indisponível" : signal == true ? "reunião detectada" : "aguardando próxima reunião"
        slackStateMenu.title = "Slack: \(observation)"
        if lastSlackObservation != observation { logSlack(observation); lastSlackObservation = observation }
        let effects = slackPolicy.evaluate(signal: signal, status: status, now: ProcessInfo.processInfo.systemUptime)
        if slackAutoEnabled && slackRunning && signal == nil && !promptedForSlackAccess { authorizeSlackLogs() }
        for effect in effects {
            switch effect {
            case .openInterface: openInterface()
            case .start(let callID): command("start", slackCallID: callID)
            }
        }
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
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["action": action, "language": language])
        session.dataTask(with: request) { [weak self] data, response, error in
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.sending = false
                let accepted = (response as? HTTPURLResponse).map { (200..<300).contains($0.statusCode) } ?? false
                if let callID = slackCallID {
                    self.slackPolicy.commandCompleted(callID: callID, accepted: accepted, now: ProcessInfo.processInfo.systemUptime)
                    self.logSlack(accepted ? "início automático aceito" : "falha ao solicitar início automático")
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
    @objc private func selectLanguage(_ sender: NSMenuItem) { UserDefaults.standard.set(sender.representedObject as? String, forKey: "HeedLanguage"); updateMenu() }
    @objc private func toggleSlackAuto() { UserDefaults.standard.set(!slackAutoEnabled, forKey: "HeedSlackAutoRecord"); updateMenu() }
    @objc private func authorizeSlackLogs() {
        guard !requestingSlackAccess else { return }
        requestingSlackAccess = true; promptedForSlackAccess = true
        slackAccessMenu.isEnabled = false
        slackLogAccess.request { [weak self] folder in
            guard let self = self else { return }
            self.requestingSlackAccess = false; self.slackAccessMenu.isEnabled = true
            if let folder = folder { self.slackDetector.setAuthorizedLogRoot(folder); self.logSlack("pasta de registros autorizada") }
            else { self.logSlack("autorização da pasta não concluída") }
            if let diagnostic = self.slackLogAccess.diagnostic { self.logSlack(diagnostic) }
            self.poll()
        }
    }
    @objc private func quitApp() { NSApplication.shared.terminate(nil) }
}

if CommandLine.arguments.contains("--self-test") {
    func status(_ recording: Bool = false, _ processing: Bool = false, _ ready: Bool = true, _ pending: Bool = false) -> ControlStatus {
        ControlStatus(recording: recording, processing: processing, seconds: 0, ready: ready, clientConnected: true, error: nil, pending: pending, starting: false)
    }
    precondition(status().canStart && !status().canStop)
    precondition(!status(true).canStart && status(true).canStop)
    precondition(!status(false, true).canStart)
    precondition(!status(false, false, false).canStart)
    precondition(!status(true, false, true, true).canStop)
    precondition(responseError(Data("{\"error\":\"Permissão necessária\"}".utf8), status: 409) == "Permissão necessária")
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
