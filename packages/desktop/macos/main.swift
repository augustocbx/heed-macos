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
    var canStart: Bool { ready && !recording && !processing && !pending }
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
        menu.addItem(NSMenuItem.separator())
        let quit = NSMenuItem(title: "Sair do ícone", action: #selector(quitApp), keyEquivalent: "")
        quit.target = self; menu.addItem(quit)
        item.menu = menu
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
            }
        }.resume()
    }
    private func updateMenu() {
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
    private func command(_ action: String) {
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
                if let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) {
                    self.openInterface(); self.poll()
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
    @objc private func quitApp() { NSApplication.shared.terminate(nil) }
}

if CommandLine.arguments.contains("--self-test") {
    func status(_ recording: Bool = false, _ processing: Bool = false, _ ready: Bool = true, _ pending: Bool = false) -> ControlStatus {
        ControlStatus(recording: recording, processing: processing, seconds: 0, ready: ready, clientConnected: true, error: nil, pending: pending)
    }
    precondition(status().canStart && !status().canStop)
    precondition(!status(true).canStart && status(true).canStop)
    precondition(!status(false, true).canStart)
    precondition(!status(false, false, false).canStart)
    precondition(!status(true, false, true, true).canStop)
    precondition(responseError(Data("{\"error\":\"Permissão necessária\"}".utf8), status: 409) == "Permissão necessária")
    precondition(responseError(nil, status: 500).contains("500"))
    print("Heed menubar self-tests passed")
} else {
    let app = NSApplication.shared
    let controller = MenuController()
    app.delegate = controller
    app.setActivationPolicy(.accessory)
    app.run()
}
