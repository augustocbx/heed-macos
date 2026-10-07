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
    var meetingMode: String? = nil
    var realTimeTranscription: Bool? = nil
    var liveOptions: AdmittedLiveOptions? = nil
    var liveModel: String? = nil
    func captureLabel(locale: String) -> String {
        let archivalLabel = meetingMode == "transcript-only" ? " • " + MenuLocalization.text("Transcript only",locale:locale) : ""
        if realTimeTranscription == false { return MenuLocalization.text("Recording • live text off; transcript after stop",locale:locale) + archivalLabel }
        guard let language = liveOptions?.effectiveLanguage else { return MenuLocalization.text("Recording",locale:locale) + archivalLabel }
        let label = MenuLocalization.text(language == "pt" ? "Brazilian Portuguese" : "English",locale:locale)
        return "\(MenuLocalization.text("Recording",locale:locale)) • \(label) • \(liveOptions?.engine ?? "?") / \(liveModel ?? liveOptions?.initialModel ?? "?")\(archivalLabel)"
    }
    var canStart: Bool { ready && !recording && !processing && !pending && starting != true && maintenance != true && (state != "failed" || path == nil) }
    var canStop: Bool { recording && !processing && !pending && starting != true && meetingId != nil }
    var canQuit: Bool { !recording && !processing && !pending && starting != true }
}
struct MenuQAState: Decodable {
    let control: ControlStatus?
    let fresh: Bool
    let microphone: String
    let screenCapture: Bool
    let services: [ServiceNoticeInfo]

    static func load(root: URL) -> Self? {
        let file = root.appendingPathComponent("menu-state.json")
        guard let size = (try? FileManager.default.attributesOfItem(atPath: file.path)[.size]) as? NSNumber,
              size.intValue <= 16_384, let data = try? Data(contentsOf: file) else { return nil }
        return try? JSONDecoder().decode(Self.self, from: data)
    }
}
struct APIError: Decodable { let error: String }
struct RecordingMenuPresentation {
    let status: String
    let blocker: String?
    let recovery: String?
    let canStart: Bool
    let canStop: Bool

    static func evaluate(_ state: ControlStatus?, fresh: Bool, microphone: String,
                         screenCapture: Bool, services: [ServiceNoticeInfo], sending: Bool) -> Self {
        let unavailable = services.filter { $0.state != "ready" }
        let servicesReady = ServiceNoticeInfo.permitsVerifiedStart(unavailable, freshController: fresh)
        if state?.recording == true {
            return Self(status: "Recording", blocker: nil, recovery: nil, canStart: false,
                        canStop: !sending && state?.canStop == true)
        }
        if state?.processing == true { return Self(status: "Processing meeting…", blocker: "Processing meeting…", recovery: nil, canStart: false, canStop: false) }
        if state?.pending == true || state?.starting == true || sending {
            return Self(status: "Waiting for the interface…", blocker: "Waiting for the interface…", recovery: nil, canStart: false, canStop: false)
        }
        if fresh && state?.state == "failed" && state?.path != nil {
            return Self(status: "Recording needs recovery", blocker: "Recording needs recovery",
                        recovery: "Open recording recovery…", canStart: false, canStop: false)
        }
        if microphone == "unknown" {
            return Self(status: "Could not verify permissions", blocker: "Could not verify permissions",
                        recovery: "Check permissions again", canStart: false, canStop: false)
        }
        if microphone != "authorized" {
            let restricted = microphone == "restricted"
            return Self(status: restricted ? "Microphone restricted by device policy" : "Microphone permission needed",
                        blocker: restricted ? "Microphone restricted by device policy" : "Microphone permission needed",
                        recovery: restricted ? "Settings and permissions…" : "Open Microphone settings…", canStart: false, canStop: false)
        }
        if !screenCapture {
            return Self(status: "Screen & System Audio Recording permission needed",
                        blocker: "Screen & System Audio Recording permission needed",
                        recovery: "Open Screen Recording settings…", canStart: false, canStop: false)
        }
        guard fresh, let state = state else {
            return Self(status: "Service unavailable — open the interface", blocker: "Could not verify recording status", recovery: "Check recording status again", canStart: false, canStop: false)
        }
        if !servicesReady {
            return Self(status: "Preparing services…", blocker: "Services are not ready", recovery: "Retry service startup", canStart: false, canStop: false)
        }
        if state.maintenance == true {
            return Self(status: "Preparing update…", blocker: "Preparing update…", recovery: nil, canStart: false, canStop: false)
        }
        if !state.ready || !state.canStart {
            let reason = state.clientConnected ? "Recording is not ready" : "Recording interface disconnected"
            return Self(status: reason, blocker: reason, recovery: "Check recording in interface…",
                        canStart: false, canStop: false)
        }
        return Self(status: "Ready to record", blocker: nil, recovery: nil, canStart: true, canStop: false)
    }
}
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
    private let recoveryMenu = NSMenuItem(title: "", action: #selector(recoverRecording), keyEquivalent: "")
    private let automaticMenu = NSMenuItem(title: "Automatic recording", action: nil, keyEquivalent: "")
    private let settingsMenu = NSMenuItem(title: "Settings and permissions", action: nil, keyEquivalent: "")
    private let diagnosticsMenu = NSMenuItem(title: "Diagnostics", action: nil, keyEquivalent: "")
    private let permissionStatusMenu = NSMenuItem(title: "Could not verify permissions", action: nil, keyEquivalent: "")
    private let microphoneMenu = NSMenuItem(title: "Open Microphone settings…", action: #selector(openMicrophoneSettings), keyEquivalent: "")
    private let screenMenu = NSMenuItem(title: "Open Screen Recording settings…", action: #selector(openScreenSettings), keyEquivalent: "")
    private let recheckPermissionsMenu = NSMenuItem(title: "Check permissions again", action: #selector(recheckPermissions), keyEquivalent: "")
    private let permissionHelpMenu = NSMenuItem(title: "Permission help…", action: #selector(showPermissionHelp), keyEquivalent: "")
    private var recoveryKind: String?
    private var locale = "en"
    private lazy var liveLanguageClient = LiveLanguageClient(session:session,endpoints:{ [weak self] in self?.endpoints })
    private var liveLanguageSettings: LiveLanguageSettings?
    private var liveLanguageItems: [NSMenuItem] = []
    private let meetingModeMenu = NSMenuItem(title:"Meeting mode",action:nil,keyEquivalent:"")
    private var meetingModeItems:[NSMenuItem] = []
    private let liveLanguageMenu = NSMenuItem(title:"Live speech language",action:nil,keyEquivalent:"")
    private let liveLanguageStateMenu = NSMenuItem(title:"",action:nil,keyEquivalent:"")
    private let finalOnlyMenu = NSMenuItem(title:"Record final-only (keeps real-time off)",action:#selector(recordFinalOnly),keyEquivalent:"")
    private var languageSettingsGeneration = 0
    private var languageSettingsLoading = false
    private var liveAdmissionUnavailable = false
    private var localizedItems: [(NSMenuItem, String)] = []
    private var localeItems: [NSMenuItem] = []
    private func text(_ key: String) -> String { MenuLocalization.text(key, locale: locale) }
    private var endpoints = try? ServiceEndpoints.load()
    private let diagnostics = NativeServiceDiagnostics()
    private var serviceNotices: [ServiceNoticeInfo] = []
    private let noticeMenu = NSMenuItem(title:"Service status…",action:#selector(showServiceStatus),keyEquivalent:"")
    private let retryMenu = NSMenuItem(title:"Retry service startup",action:#selector(retryServices),keyEquivalent:"")
    private var booting = false
    private lazy var releaseUpdates = ReleaseUpdateClient(endpoints: { [weak self] in self?.endpoints })
    private let updatesMenu = UpdateMenu()
    private let menuInstanceID = UUID().uuidString
    private var updateTimer: Timer?
    private var state: ControlStatus?
    private var qaState: MenuQAState?
    private var statusMessage: (text: String, until: Date)?
    private var freshProtectedStatus = false
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
    private let slackAutoMenu = NSMenuItem(title: "Slack", action: #selector(toggleSlackAuto), keyEquivalent: "")
    private let slackStateMenu = NSMenuItem(title: "Slack: Not checked", action: nil, keyEquivalent: "")
    private let detectionErrorMenu = NSMenuItem(title: "Detection unavailable — use manual recording", action: #selector(showDetectionError), keyEquivalent: "")
    private var lastSlackObservation: String?
    private let slackLogAccess = SlackLogAccess()
    private let smbFolderAccess = SmbFolderAccess()
    private var requestingSlackAccess = false
    private var promptedForSlackAccess = false
    private var permissionCommandID: String?
    private var lastPermissionCommandID: String?
    private let permissionReports = SerializedPermissionReports()
    private var screenCaptureRecovery = ScreenCaptureRecovery(arguments: CommandLine.arguments)
    private lazy var screenPermissionGuide = ScreenCaptureGuideWindow()
    private let slackAccessMenu = NSMenuItem(title: "Allow Slack log access…", action: #selector(authorizeSlackLogs), keyEquivalent: "")
    private let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 6
        return ServiceEndpoints.session(configuration: config)
    }()
    func applicationDidFinishLaunching(_ notification: Notification) {
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.menu = makeMenu()
        if updateQARoot() == nil {
            if let folder = slackLogAccess.restore() { slackDetector.setAuthorizedLogRoot(folder) }
            smbFolderAccess.restore()
        }
        updatesMenu.check = { [weak self] in self?.releaseUpdates.check(manual: true) }
        updatesMenu.install = { [weak self] in self?.confirmUpdate() }
        updatesMenu.retry = { [weak self] in self?.releaseUpdates.retry() }
        var firstUpdateStatus = true
        releaseUpdates.onChange = { [weak self] snapshot in
            guard let self = self else { return }
            self.updatesMenu.render(snapshot, build: self.releaseUpdates.build, locale: self.locale)
            if firstUpdateStatus { firstUpdateStatus = false; self.releaseUpdates.check(manual: false) }
        }
        releaseUpdates.refreshStatus()
        updateTimer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in self?.releaseUpdates.check(manual: false) }
        updateMenu(); bootServices(); poll()
        timer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in self?.poll() }
    }
    func makeMenu() -> NSMenu {
        let menu = NSMenu()
        menu.autoenablesItems = false
        statusMenu.isEnabled = false
        menu.addItem(statusMenu)
        for entry in [startMenu, stopMenu] { entry.target = self; entry.isEnabled = false; menu.addItem(entry) }
        recoveryMenu.target = self; recoveryMenu.isHidden = true; menu.addItem(recoveryMenu)
        let open = NSMenuItem(title: "Open interface", action: #selector(openInterface), keyEquivalent: "")
        open.target = self; menu.addItem(open)
        menu.addItem(.separator())
        let automatic = NSMenu(); automatic.autoenablesItems = false
        automaticMenu.submenu = automatic; menu.addItem(automaticMenu)
        let settingsGroup = NSMenu(); settingsGroup.autoenablesItems = false
        settingsMenu.submenu = settingsGroup; menu.addItem(settingsMenu)
        let settings = NSMenuItem(title: "Open settings…", action: #selector(openSettings), keyEquivalent: "")
        settings.target = self; settingsGroup.addItem(settings)
        permissionStatusMenu.isEnabled = false; settingsGroup.addItem(permissionStatusMenu)
        for entry in [microphoneMenu, screenMenu, recheckPermissionsMenu, permissionHelpMenu] { entry.target = self; settingsGroup.addItem(entry) }
        settingsGroup.addItem(.separator())
        meetingModeMenu.isEnabled = false; settingsGroup.addItem(meetingModeMenu)
        for (title, code) in [("Audio + transcript", "audio-transcript"), ("Transcript only", "transcript-only")] {
            let entry = NSMenuItem(title: title, action: #selector(selectMeetingMode(_:)), keyEquivalent: "")
            entry.target = self; entry.representedObject = code; settingsGroup.addItem(entry); meetingModeItems.append(entry)
        }
        settingsGroup.addItem(.separator())
        let speechMenu = NSMenu()
        for (title,code) in [("English","en"),("Brazilian Portuguese","pt")] {
            let entry = NSMenuItem(title:title,action:#selector(selectLiveLanguage(_:)),keyEquivalent:"")
            entry.target = self; entry.representedObject = code; speechMenu.addItem(entry); liveLanguageItems.append(entry)
        }
        liveLanguageMenu.submenu = speechMenu; settingsGroup.addItem(liveLanguageMenu)
        liveLanguageStateMenu.isEnabled = false; settingsGroup.addItem(liveLanguageStateMenu)
        finalOnlyMenu.target = self; finalOnlyMenu.isHidden = true; menu.insertItem(finalOnlyMenu, at: 3)
        slackAutoMenu.target = self; automatic.addItem(slackAutoMenu)
        slackStateMenu.isEnabled = false; automatic.addItem(slackStateMenu)
        slackAccessMenu.target = self; automatic.addItem(slackAccessMenu)
        detectionErrorMenu.target = self; detectionErrorMenu.isHidden = true; automatic.addItem(detectionErrorMenu)
        for app in ["zoom", "teams", "meet"] {
            let key = app == "zoom" ? "Zoom" : app == "teams" ? "Teams" : "Google Meet"
            let toggle = NSMenuItem(title: key, action: #selector(toggleMeetingAuto(_:)), keyEquivalent: "")
            toggle.target = self; toggle.representedObject = app; automatic.addItem(.separator()); automatic.addItem(toggle); detectionMenus[app] = toggle
            let status = NSMenuItem(title: "\(key): Not checked", action: nil, keyEquivalent: ""); status.isEnabled = false; automatic.addItem(status); detectionStates[app] = status
        }
        accessibilityMenu.target = self; automatic.addItem(accessibilityMenu)
        let diagnostics = NSMenu(); diagnostics.autoenablesItems = false
        diagnosticsMenu.submenu = diagnostics
        noticeMenu.target = self; diagnostics.addItem(noticeMenu)
        retryMenu.target = self; diagnostics.addItem(retryMenu)
        storageMenu.isEnabled = false; diagnostics.addItem(storageMenu)
        menu.addItem(updatesMenu.item)
        menu.addItem(diagnosticsMenu)
        menu.addItem(.separator())
        let quit = NSMenuItem(title: "Quit menu app", action: #selector(quitApp), keyEquivalent: "")
        quit.target = self; menu.addItem(quit)
        localizedItems = [(meetingModeMenu, "Meeting mode"), (liveLanguageMenu,"Live speech language"),(finalOnlyMenu,"Record final-only (keeps real-time off)"),(startMenu, "Start recording"), (stopMenu, "Stop recording"),
            (open, "Open interface"), (settings, "Open settings…"), (automaticMenu, "Automatic recording"),
            (settingsMenu, "Settings and permissions"), (diagnosticsMenu, "Diagnostics"),
            (microphoneMenu, "Open Microphone settings…"), (screenMenu, "Open Screen Recording settings…"),
            (recheckPermissionsMenu, "Check permissions again"), (permissionHelpMenu, "Permission help…"),
            (slackAutoMenu, "Slack"), (slackAccessMenu, "Allow Slack log access…"),
            (detectionErrorMenu, "Detection unavailable — use manual recording"), (quit, "Quit menu app")]
        let languageMenu = NSMenu()
        for (title, code) in [("English", "en"), ("Português (Brasil)", "pt-BR"), ("Français", "fr"), ("Deutsch", "de")] {
            let entry = NSMenuItem(title: title, action: #selector(selectLocale(_:)), keyEquivalent: "")
            entry.target = self; entry.representedObject = code
            languageMenu.addItem(entry); localeItems.append(entry)
        }
        let language = NSMenuItem(title: "Interface language", action: nil, keyEquivalent: "")
        language.submenu = languageMenu; settingsGroup.addItem(language)
        localizedItems.append((language, "Interface language"))
        localizedItems.append((retryMenu,"Retry service startup"))
        localizedItems.append((accessibilityMenu, "Authorize Accessibility"))
        for (app, entry) in detectionMenus { localizedItems.append((entry, app == "zoom" ? "Zoom" : app == "teams" ? "Teams" : "Google Meet")) }
        return menu
    }
    private func bootServices() {
        if updateQARoot() != nil {return}
        guard !booting,let endpoints = endpoints, let script = Bundle.main.path(forResource: "start-services", ofType: "sh") else { return }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/bash")
        process.arguments = [script]
        process.environment = endpoints.launchEnvironment(base: ProcessInfo.processInfo.environment)
        process.terminationHandler = { [weak self] _ in DispatchQueue.main.async{self?.booting=false;self?.refreshServiceNotices(force:true)} }
        do{try process.run();booting=true}catch{booting=false;refreshServiceNotices(force:true)}
    }
    private func refreshServiceNotices(force:Bool=false) {
        guard let endpoints=endpoints else{return}
        diagnostics.check(endpoints:endpoints,refresh:force){[weak self] notices in DispatchQueue.main.async{guard let self=self else{return};self.serviceNotices=notices;self.updateMenu()}}
    }
    @objc private func showServiceStatus() {
        let alert=NSAlert();alert.messageText=text("Service status…")
        let unavailable=serviceNotices.filter{$0.state != "ready"}
        alert.informativeText=serviceNotices.count != 3 ? text("Not checked") : unavailable.isEmpty ? text("Services responded.") : unavailable.map{$0.message(locale:locale)}.joined(separator:"\n")+"\n\n"+(unavailable.contains{$0.state == "conflict"} ? ServiceNoticeInfo.recovery(locale:locale) : text("Retry Heed startup after checking the service and its configured port."))
        alert.addButton(withTitle:text("Check again"));alert.addButton(withTitle:text("Close"))
        if alert.runModal() == .alertFirstButtonReturn{refreshServiceNotices(force:true);poll()}
    }
    @objc private func retryServices() {
        guard !booting,!sending,state?.canQuit != false else{return}
        endpoints=try? ServiceEndpoints.load();releaseUpdates.refreshStatus(force:true);serviceNotices=[];bootServices();refreshServiceNotices(force:true);poll()
    }
    private func poll() {
        releaseUpdates.refreshStatus()
        if let root = updateQARoot() {
            qaState = MenuQAState.load(root: root)
            state = qaState?.control
            freshProtectedStatus = qaState?.fresh == true
            serviceNotices = qaState?.services ?? []
            locale = MenuLocalization.normalize(qaState?.control?.uiLocale)
            updateMenu()
            return
        }
        refreshLiveLanguageSettings()
        guard !polling else { return }
        refreshServiceNotices()
        guard let endpoints = endpoints else { self.state = nil; self.statusMenu.title = self.text("Service unavailable — open the interface"); self.updateMenu(); return }
        polling = true
        freshProtectedStatus=false
        let request = URLRequest(url: endpoints.apiURL("/api/desktop/control/status"))
        endpoints.perform(session: session, request: request) { [weak self] data, response, error in
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.polling = false
                if let data = data, (response as? HTTPURLResponse)?.statusCode == 200,
                   let state = try? JSONDecoder().decode(ControlStatus.self, from: data) {
                    self.state = state
                    self.freshProtectedStatus=true
                    self.locale = MenuLocalization.normalize(state.uiLocale)
                } else {
                    self.state = nil
                    self.freshProtectedStatus=false
                }
                if let request = self.state?.permissionRequest { self.executePermissionRequest(request) }
                if let command = self.state?.smbCommand { self.smbFolderAccess.execute(command, locale: self.locale) }
                self.checkMeetings()
                self.updateMenu()
                self.reportPermissions()
            }
        }
    }
    private func updateMenu() {
        updatesMenu.render(releaseUpdates.snapshot, build: releaseUpdates.build, locale: locale)
        let unavailable=serviceNotices.filter{$0.state != "ready"}
        let notice=unavailable.first{$0.state == "conflict"} ?? unavailable.first
        noticeMenu.title=notice?.message(locale:locale) ?? text("Service status…")
        noticeMenu.isEnabled=true
        retryMenu.isEnabled = !booting && !sending && state?.canQuit != false
        let presentation = RecordingMenuPresentation.evaluate(state, fresh: freshProtectedStatus,
            microphone: microphonePermission, screenCapture: screenCaptureAuthorized,
            services: serviceNotices, sending: sending)
        let microphone = microphonePermission
        permissionStatusMenu.title = text(microphone == "unknown" ? "Could not verify permissions" :
            microphone == "restricted" ? "Microphone restricted by device policy" :
            microphone != "authorized" || !screenCaptureAuthorized ? "Permissions need attention" : "Capture permissions allowed")
        microphoneMenu.isHidden = microphone == "authorized"
        screenMenu.isHidden = screenCaptureAuthorized
        if let current = state, current.recording {
            statusMenu.title = "\(current.captureLabel(locale: locale)) • \(current.seconds / 60):\(String(format: "%02d", current.seconds % 60))"
        } else if presentation.blocker == "Services are not ready", let notice = notice {
            statusMenu.title = notice.message(locale: locale)
        } else { statusMenu.title = text(presentation.status) }
        if state?.recording != true && state?.processing != true && presentation.blocker == nil,
           let message = statusMessage {
            if message.until > Date() { statusMenu.title = message.text }
            else { statusMessage = nil }
        }
        applyRecordingActions(presentation)
        if let storage = state?.storage {
            let number = NumberFormatter();number.locale = Locale(identifier: locale);number.maximumFractionDigits = 3
            let used = number.string(from: NSNumber(value: Double(storage.usedBytes) / 1_000_000_000)) ?? "?"
            let limit = number.string(from: NSNumber(value: Double(storage.limitBytes) / 1_000_000_000)) ?? "?"
            storageMenu.title = "\(text("Local meeting storage")): \(used) / \(limit) GB"
        } else { storageMenu.title = text("Local meeting storage") }
        for (entry, key) in localizedItems { entry.title = text(key) }
        for entry in localeItems { entry.state = (entry.representedObject as? String) == locale ? .on : .off }
        for entry in liveLanguageItems {
            let language = entry.representedObject as? String
            entry.title = text(language == "pt" ? "Brazilian Portuguese" : "English")
            entry.state = language == (liveLanguageSettings?.liveLanguage ?? "en") ? .on : .off
            entry.isEnabled = liveLanguageSettings != nil && !sending
        }
        let activeMode = ["starting","recording","stopping","finalizing","failed"].contains(state?.state ?? "")
        for entry in meetingModeItems {
            let selected=entry.representedObject as? String
            entry.title=text(selected == "transcript-only" ? "Transcript only" : "Audio + transcript")
            entry.state=selected == (activeMode ? state?.meetingMode : liveLanguageSettings?.meetingMode) ? .on : .off
            entry.isEnabled=liveLanguageSettings != nil && !sending && !activeMode
        }
        liveLanguageStateMenu.title = state?.recording == true ? state!.captureLabel(locale:locale) : text("Live speech language") + ": " + text(liveLanguageSettings?.liveLanguage == "pt" ? "Brazilian Portuguese" : "English")
        finalOnlyMenu.isHidden = !liveAdmissionUnavailable && !["unsupported","unavailable"].contains(liveLanguageSettings?.liveLanguageState ?? "")
        slackAutoMenu.state = slackAutoEnabled ? .on : .off
        slackAutoMenu.isEnabled = state?.meetingDetection != nil
        if state?.meetingDetection == nil { slackStateMenu.title = "Slack: \(text("Not checked"))" }
        detectionErrorMenu.isHidden = state?.meetingDetection?.error == nil
        for (app, entry) in detectionMenus {
            entry.state = state?.meetingDetection?.enabled[app] == true ? .on : .off
            entry.isEnabled = state?.meetingDetection != nil
        }
        if state?.meetingDetection == nil {
            for (app, entry) in detectionStates {
                entry.title = "\(app == "meet" ? "Google Meet" : app == "teams" ? "Teams" : "Zoom"): \(text("Not checked"))"
            }
        }
        let recording = state?.recording ?? false
        item.button?.image = recordingStatusImage(recording, locale: locale)
        item.button?.contentTintColor = recording ? .systemRed : nil
        item.button?.toolTip = "Heed — \(statusMenu.title)"
        if updateQARoot() != nil {
            if qaState == nil { statusMenu.title = "Heed QA — simulated services" }
            item.button?.toolTip = "Heed QA — \(statusMenu.title)"
        }
    }
    func applyRecordingActions(_ presentation: RecordingMenuPresentation) {
        recoveryMenu.isHidden = presentation.recovery == nil
        recoveryMenu.title = presentation.recovery.map { text($0) } ?? ""
        recoveryKind = presentation.recovery
        startMenu.isEnabled = presentation.canStart
        finalOnlyMenu.isEnabled = presentation.canStart
        stopMenu.isEnabled = presentation.canStop
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
        if slackAutoEnabled && slackRunning && !slackDetector.canReadLogs && !promptedForSlackAccess
            && !releaseUpdates.snapshot.isInstalling && state?.maintenance != true
            && releaseUpdates.snapshot.permissionVersion != releaseUpdates.build?.version { authorizeSlackLogs() }
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
        // Detector errors affect automatic recording, not manual readiness.
    }
    @objc private func showDetectionError() {
        guard let error = state?.meetingDetection?.error else { return }
        let alert = NSAlert()
        alert.messageText = text("Automatic recording")
        alert.informativeText = MenuLocalization.message(error, locale: locale)
        alert.addButton(withTitle: text("Close"))
        alert.runModal()
    }
    private var microphonePermission: String {
        if let qaState = qaState { return qaState.microphone }
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: return "authorized"
        case .denied: return "denied"
        case .restricted: return "restricted"
        case .notDetermined: return "notDetermined"
        @unknown default: return "unknown"
        }
    }
    private var screenCaptureAuthorized: Bool { qaState?.screenCapture ?? CGPreflightScreenCaptureAccess() }
    private func reportPermissions(commandID: String? = nil, error: String? = nil, completion: ((Bool) -> Void)? = nil) {
        permissionReports.enqueue(keepIfBusy: commandID != nil || completion != nil) { [weak self] finish in
            guard let self = self, let endpoints = self.endpoints else { finish(); completion?(false); return }
            var payload: [String: Any] = ["recoverySupported": true, "permissions": ["microphone": self.microphonePermission,
                "screenCapture": self.screenCaptureAuthorized, "slackLogs": self.slackAutoEnabled ? self.slackDetector.canReadLogs as Any : NSNull(),
                "slackAutoRecord": self.slackAutoEnabled]]
            if let build = self.releaseUpdates.build {
                payload["build"] = ["version": build.version, "commit": build.commit as Any? ?? NSNull(), "instanceId": self.menuInstanceID]
            }
            if let commandID = commandID { payload["commandId"] = commandID }
            if let error = error { payload["error"] = error }
            var request = URLRequest(url: endpoints.apiURL("/api/desktop/permissions/report"))
            request.httpMethod = "POST"; request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try? JSONSerialization.data(withJSONObject: payload)
            endpoints.perform(session: self.session, request: request) { _, response, _ in
                DispatchQueue.main.async {
                    finish()
                    completion?((response as? HTTPURLResponse)?.statusCode == 200)
                }
            }
        }
    }
    @objc private func openMicrophoneSettings() {
        if updateQARoot() != nil { poll(); return }
        if microphonePermission == "notDetermined" {
            AVCaptureDevice.requestAccess(for: .audio) { [weak self] _ in DispatchQueue.main.async { self?.recheckPermissions() } }
        } else { openPrivacyPane("Privacy_Microphone") }
    }
    @objc private func openScreenSettings() {
        if updateQARoot() != nil { poll(); return }
        switch ScreenCaptureActionRoute.forPreflight(screenCaptureAuthorized) {
        case .directPane:
            openPrivacyPane("Privacy_ScreenCapture")
        case .guidedReplacement:
            _ = CGRequestScreenCaptureAccess()
            showScreenPermissionGuide(openPane: true)
        }
    }
    @objc private func recheckPermissions() {
        if updateQARoot() != nil {
            poll()
            releaseUpdates.checkPermissions()
            return
        }
        refreshServiceNotices(force: true)
        poll()
        reportPermissions { [weak self] reported in
            if reported { self?.releaseUpdates.checkPermissions() }
            self?.updateMenu()
        }
    }
    @objc private func recoverRecording() {
        switch recoveryKind {
        case "Open Microphone settings…": openMicrophoneSettings()
        case "Open Screen Recording settings…": openScreenSettings()
        case "Retry service startup": retryServices()
        case "Check recording status again": recheckPermissions()
        case "Check permissions again": recheckPermissions()
        case "Open recording recovery…": openInterface()
        case "Check recording in interface…": openInterface()
        case "Settings and permissions…": openSettings()
        default: openInterface()
        }
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
            switch ScreenCaptureActionRoute.forPreflight(CGPreflightScreenCaptureAccess()) {
            case .directPane:
                openPrivacyPane("Privacy_ScreenCapture")
            case .guidedReplacement:
                _ = CGRequestScreenCaptureAccess()
                showScreenPermissionGuide(openPane: true)
            }
            finish(nil)
        case "recoverScreenCapture":
            if screenCaptureRecovery.consumeResume(commandID: request.id, action: request.action) {
                if !CGPreflightScreenCaptureAccess() { _ = CGRequestScreenCaptureAccess() }
                openPrivacyPane("Privacy_ScreenCapture")
                openSettings()
                finish(nil)
                return
            }
            let recoveryError = "System audio permission recovery could not finish. Reopen Heed and try again after active work or updates finish."
            guard let endpoints = endpoints, ScreenCaptureRecovery.canBegin(fresh: freshProtectedStatus,
                  idle: state?.canQuit == true, maintenance: state?.maintenance == true,
                  updating: releaseUpdates.snapshot.isInstalling, booting: booting, sending: sending) else {
                finish(recoveryError); return
            }
            let alert = NSAlert()
            alert.messageText = text("Recover system audio permission?")
            alert.informativeText = text("Heed will clear only its screen and system audio permission, then restart. macOS will ask you to authorize it again. Meetings, settings and other permissions are preserved.")
            alert.addButton(withTitle: text("Recover and restart")); alert.addButton(withTitle: text("Cancel"))
            guard alert.runModal() == .alertFirstButtonReturn else { finish("Permission recovery canceled."); return }
            launchScreenCaptureRecovery(root: endpoints.checkoutRoot, app: Bundle.main.bundleURL.path,
                commandID: request.id, environment: endpoints.launchEnvironment(base: ProcessInfo.processInfo.environment),
                ready: { NSApplication.shared.terminate(nil) }, failed: { finish(recoveryError) })
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
        guard let endpoints = endpoints, !sending else { return }
        sending = true; updateMenu()
        var request = URLRequest(url: endpoints.apiURL("/api/desktop/control/commands"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 600
        var payload: [String: Any] = ["action": action, "requestId": UUID().uuidString]
        if action == "stop", let meetingId = state?.meetingId { payload["meetingId"] = meetingId }
        request.httpBody = try? JSONSerialization.data(withJSONObject: payload)
        endpoints.perform(session: session, request: request) { [weak self] data, response, error in
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.sending = false
                let accepted = (response as? HTTPURLResponse).map { (200..<300).contains($0.statusCode) } ?? false
                if accepted {
                    self.poll()
                } else {
                    self.showStatusMessage(MenuLocalization.message(error?.localizedDescription ?? responseError(data, status: (response as? HTTPURLResponse)?.statusCode ?? 0), locale: self.locale))
                    self.updateMenu()
                }
            }
        }
    }
    @objc private func selectLocale(_ sender: NSMenuItem) {
        guard let endpoints = endpoints, let selected = sender.representedObject as? String, MenuLocalization.locales.contains(selected) else { return }
        var request = URLRequest(url: endpoints.apiURL("/api/ui-locale"))
        request.httpMethod = "POST"; request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["locale": selected])
        endpoints.perform(session: session, request: request) { [weak self] data, response, _ in
            DispatchQueue.main.async {
                guard let self = self else { return }
                if (response as? HTTPURLResponse)?.statusCode == 200,
                   let data = data, let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                   let saved = body["locale"] as? String {
                    self.locale = MenuLocalization.normalize(saved); self.updateMenu(); self.poll()
                } else { self.showStatusMessage(self.text("Could not save the interface language. Try again.")) }
            }
        }
    }
    private func refreshLiveLanguageSettings() {
        guard !languageSettingsLoading, !sending else { return }
        languageSettingsLoading = true; let generation = languageSettingsGeneration
        liveLanguageClient.load { [weak self] result in
            guard let self = self else { return }; self.languageSettingsLoading = false
            guard generation == self.languageSettingsGeneration else { return }
            if case .success(let settings) = result { self.liveLanguageSettings = settings }
            else { self.liveLanguageSettings = nil; self.liveAdmissionUnavailable = true }
            self.updateMenu()
        }
    }
    @objc private func selectMeetingMode(_ sender:NSMenuItem) {
        guard !sending, let mode=sender.representedObject as? String else {return}
        if mode == "transcript-only" {
            let alert=NSAlert();alert.messageText=text("Enable transcript only")
            alert.informativeText=text("Transcript only uses temporary local audio during capture and final processing. After the final transcript is saved, audio is deleted. Playback and retranscription are unavailable.")
            alert.addButton(withTitle:text("Enable transcript only"));alert.addButton(withTitle:text("Cancel"))
            guard alert.runModal() == .alertFirstButtonReturn else {return}
        }
        sending=true;languageSettingsGeneration += 1;updateMenu()
        liveLanguageClient.save(meetingMode:mode) { [weak self] result in
            guard let self=self else {return};self.sending=false
            switch result {
            case .success(let action):self.liveLanguageSettings=action.settings
            case .failure:self.showStatusMessage(self.text("Could not save meeting mode. Try again."))
            }
            self.updateMenu()
        }
    }
    @objc private func selectLiveLanguage(_ sender:NSMenuItem) {
        guard !sending, let language = sender.representedObject as? String else { return }
        sending = true; languageSettingsGeneration += 1; updateMenu()
        liveLanguageClient.save(language:language) { [weak self] result in
            guard let self = self else { return }; self.sending = false
            switch result {
            case .success(let action): self.liveLanguageSettings = action.settings; self.showStatusMessage(self.text("Saved. Live speech language applies to the next recording."))
            case .failure: self.showStatusMessage(self.text("Could not save live speech language. Try again."))
            }
            self.updateMenu()
        }
    }
    private func startCapture(finalOnly:Bool) {
        guard !sending, startMenu.isEnabled else { return }
        sending = true; languageSettingsGeneration += 1; updateMenu()
        liveLanguageClient.start(finalOnly:finalOnly) { [weak self] result in
            guard let self = self else { return }; self.sending = false
            switch result {
            case .success(let action):
                self.liveAdmissionUnavailable = false
                self.poll()
                if action.persistedOff { self.showLiveLanguageFeedback(self.text("Real-time transcription is now off for future recordings. Change it in Settings to turn it on again.")) }
            case .failure(let error):
                if let failure = error as? LiveLanguageClientError, ["live-language-unsupported","live-capabilities-unavailable"].contains(failure.code ?? "") { self.liveAdmissionUnavailable = true }
                let message = MenuLocalization.message(error.localizedDescription,locale:self.locale)
                self.showStatusMessage(message)
                if let failure = error as? LiveLanguageClientError, failure.persistedOff {
                    self.showLiveLanguageFeedback(message + "\n\n" + self.text("Real-time transcription is now off for future recordings. Change it in Settings to turn it on again."))
                } else { self.showLiveLanguageFeedback(message) }
                self.refreshLiveLanguageSettings()
            }
            self.updateMenu()
        }
    }
    private func showLiveLanguageFeedback(_ message:String) {
        let alert = NSAlert(); alert.messageText = text("Live speech language"); alert.informativeText = message
        alert.addButton(withTitle:text("Close")); alert.runModal()
    }
    @objc private func startRecording() { startCapture(finalOnly:false) }
    @objc private func recordFinalOnly() { startCapture(finalOnly:true) }
    @objc private func stopRecording() { command("stop") }
    private func showStatusMessage(_ message: String) {
        statusMessage = (message, Date().addingTimeInterval(8))
        updateMenu()
    }
    private func openVerifiedInterface(settings: Bool) {
        bootServices()
        guard let endpoints = endpoints else { statusMenu.title = text("Service unavailable — open the interface"); return }
        endpoints.verify(session: session, service: "heed-ui") { [weak self] verified in
            DispatchQueue.main.async {
                guard let self = self else { return }
                if verified { NSWorkspace.shared.open(endpoints.interfaceURL(settings: settings)) }
                else { self.statusMenu.title = self.text("Service unavailable — open the interface") }
            }
        }
    }
    @objc private func openInterface() { openVerifiedInterface(settings: false) }
    @objc private func openSettings() { openVerifiedInterface(settings: true) }
    private func confirmUpdate() {
        guard let version = releaseUpdates.snapshot.release?.manifest.version, releaseUpdates.snapshot.canInstall else { return }
        let alert = NSAlert()
        alert.messageText = String(format: text("Install Heed %@?"), version)
        alert.informativeText = text("Heed will restart. Meeting data and settings are preserved. macOS permissions may need renewal after the update.")
        alert.addButton(withTitle: text("Update")); alert.addButton(withTitle: text("Cancel"))
        if alert.runModal() == .alertFirstButtonReturn { releaseUpdates.install() }
    }
    @objc private func showPermissionHelp() {
        if UpdatePermissionHelpRoute.forHelp(screenAuthorized: screenCaptureAuthorized,
            missing: releaseUpdates.snapshot.missingPermissions,
            reportVersion: releaseUpdates.snapshot.permissionVersion,
            installedVersion: releaseUpdates.build?.version) == .screenGuide {
            showScreenPermissionGuide(openPane: false)
            return
        }
        let alert = NSAlert()
        alert.messageText = text("Recording permissions")
        alert.informativeText = text("Enable Heed under System Settings > Privacy & Security > Microphone and Screen & System Audio Recording. If capture remains unavailable, turn the affected permission off and on, then quit and reopen Heed. A restricted microphone requires your device administrator. Reauthorize Slack or shared folders only if their access no longer works. Heed never resets permissions automatically.")
        alert.addButton(withTitle: text("Settings and permissions…")); alert.addButton(withTitle: text("Close"))
        if alert.runModal() == .alertFirstButtonReturn { openSettings() }
    }
    private func showScreenPermissionGuide(openPane: Bool) {
        screenPermissionGuide.didRecheck = { [weak self] in
            self?.recheckPermissions()
        }
        screenPermissionGuide.show(locale: locale)
        if openPane { openPrivacyPane("Privacy_ScreenCapture") }
    }
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
        guard let endpoints = endpoints else { statusMenu.title = text("Could not check recording status. Try again before quitting."); return .terminateCancel }
        endpoints.perform(session: session, request: URLRequest(url: endpoints.apiURL("/api/desktop/control/status"))) { [weak self] data, response, error in
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
        }
        return .terminateLater
    }
    @objc private func quitApp() { NSApplication.shared.terminate(nil) }
}

if CommandLine.arguments.contains("--service-diagnostics") {
    if let endpoints=try? ServiceEndpoints.load() {
        var done=false
        NativeServiceDiagnostics().check(endpoints:endpoints,refresh:true){notices in
            DispatchQueue.main.async {
                if let data=try? JSONEncoder().encode(notices){FileHandle.standardOutput.write(data)}
                done=true
            }
        }
        let deadline=Date().addingTimeInterval(8)
        while !done && Date()<deadline{RunLoop.current.run(until:Date().addingTimeInterval(0.01))}
        exit(done ? 0 : 1)
    }
    exit(1)
}
if CommandLine.arguments.contains("--update-client-self-test") {
    try updateClientSelfTests()
    print("Heed update client fixture self-tests passed")
} else if CommandLine.arguments.contains("--self-test") {
    try screenCaptureGuideSelfTests()
    permissionRecoverySelfTests()
    serializedPermissionReportSelfTests()
    try updateSelfTests()
    try serviceNoticeSelfTests()
    func status(_ recording: Bool = false, _ processing: Bool = false, _ ready: Bool = true, _ pending: Bool = false) -> ControlStatus {
        ControlStatus(recording: recording, processing: processing, seconds: 0, ready: ready, clientConnected: true, error: nil, pending: pending, starting: false, meetingId: recording ? "fixture" : nil)
    }
    let menuController = MenuController()
    let menu = menuController.makeMenu()
    let top = menu.items.filter { !$0.isSeparatorItem && !$0.isHidden }.map(\.title)
    precondition(top.prefix(4).elementsEqual(["Preparing services…", "Start recording", "Stop recording", "Open interface"]),
                 "Readiness, adjacent recording actions, and interface must lead the menu")
    precondition(top.suffix(4).elementsEqual(["Settings and permissions", "Updates", "Diagnostics", "Quit menu app"]))
    let automatic = menu.items.first { $0.title == "Automatic recording" }!.submenu!
    precondition(automatic.items.filter { !$0.isSeparatorItem }.map(\.title).contains("Slack"))
    precondition(["Zoom", "Teams", "Google Meet"].allSatisfy { title in automatic.items.contains { $0.title == title } })
    let detectionWarning = automatic.items.first { $0.title == "Detection unavailable — use manual recording" }!
    precondition(detectionWarning.action != nil && detectionWarning.isEnabled,
                 "An automation failure needs a focusable, actionable warning")
    let settings = menu.items.first { $0.title == "Settings and permissions" }!.submenu!
    precondition(settings.items.contains { $0.title == "Interface language" })
    precondition(settings.items.contains { $0.title == "Check permissions again" })
    precondition(["Meeting mode", "Audio + transcript", "Transcript only"].allSatisfy { title in settings.items.contains { $0.title == title } },
                 "The new recording mode must remain directly reachable in Settings after merging main")
    let diagnostics = menu.items.first { $0.title == "Diagnostics" }!.submenu!
    precondition(diagnostics.items.contains { $0.title == "Local meeting storage" })
    let readyPresentation = RecordingMenuPresentation.evaluate(status(), fresh: true, microphone: "authorized", screenCapture: true, services: [], sending: false)
    precondition(readyPresentation.status == "Ready to record" && readyPresentation.canStart && readyPresentation.blocker == nil)
    let missingScreen = RecordingMenuPresentation.evaluate(status(), fresh: true, microphone: "authorized", screenCapture: false, services: [], sending: false)
    precondition(missingScreen.status == "Screen & System Audio Recording permission needed" && !missingScreen.canStart && missingScreen.recovery == "Open Screen Recording settings…",
                 "Disabled Start cannot coexist with Ready to record when capture permission is missing")
    menuController.applyRecordingActions(missingScreen)
    precondition(menu.items.first { $0.title == "Start recording" }?.isEnabled == false)
    let recoveryAction = menu.items.first { $0.title == "Open Screen Recording settings…" }!
    precondition(recoveryAction.isHidden == false,
                 "Permission blocker needs a visible main-menu recovery action")
    menuController.applyRecordingActions(readyPresentation)
    precondition(menu.items.first { $0.title == "Start recording" }?.isEnabled == true)
    precondition(recoveryAction.isHidden == true,
                 "Resolved warnings must clear after a fresh status")
    let missingMic = RecordingMenuPresentation.evaluate(status(), fresh: true, microphone: "denied", screenCapture: true, services: [], sending: false)
    precondition(missingMic.status == "Microphone permission needed" && !missingMic.canStart && missingMic.recovery == "Open Microphone settings…")
    let unknownPermission = RecordingMenuPresentation.evaluate(status(), fresh: true, microphone: "unknown", screenCapture: true, services: [], sending: false)
    precondition(unknownPermission.status == "Could not verify permissions" && unknownPermission.recovery == "Check permissions again" && !unknownPermission.canStart)
    let unknown = RecordingMenuPresentation.evaluate(status(), fresh: false, microphone: "authorized", screenCapture: true, services: [], sending: false)
    precondition(unknown.status == "Service unavailable — open the interface" && !unknown.canStart && unknown.recovery == "Check recording status again")
    let notReady = RecordingMenuPresentation.evaluate(status(false, false, false), fresh: true, microphone: "authorized", screenCapture: true, services: [], sending: false)
    precondition(notReady.status == "Recording is not ready" && !notReady.canStart && notReady.recovery == "Check recording in interface…")
    let disconnected = ControlStatus(recording: false, processing: false, seconds: 0, ready: false, clientConnected: false,
                                     error: nil, pending: false, starting: false, meetingId: nil)
    let disconnectedPresentation = RecordingMenuPresentation.evaluate(disconnected, fresh: true, microphone: "authorized", screenCapture: true, services: [], sending: false)
    precondition(disconnectedPresentation.status == "Recording interface disconnected" && !disconnectedPresentation.canStart
                 && disconnectedPresentation.recovery == "Check recording in interface…")
    let conflict = ServiceNoticeInfo(service: "api", port: 48100, state: "conflict", application: "OtherApp")
    let unavailable = RecordingMenuPresentation.evaluate(status(), fresh: true, microphone: "authorized", screenCapture: true, services: [conflict], sending: false)
    precondition(!unavailable.canStart && unavailable.recovery == "Retry service startup")
    let failedRecording = try JSONDecoder().decode(ControlStatus.self, from: Data("{\"recording\":false,\"processing\":false,\"seconds\":0,\"ready\":false,\"clientConnected\":true,\"pending\":false,\"state\":\"failed\",\"path\":\"/tmp/retained.wav\",\"error\":\"Finalization failed\"}".utf8))
    let failedPresentation = RecordingMenuPresentation.evaluate(failedRecording, fresh: true, microphone: "denied", screenCapture: false, services: [conflict], sending: false)
    precondition(failedPresentation.status == "Recording needs recovery" && failedPresentation.recovery == "Open recording recovery…" && !failedPresentation.canStart)
    menuController.applyRecordingActions(failedPresentation)
    precondition(menu.items.first { $0.title == "Open recording recovery…" }?.isHidden == false)
    let active = RecordingMenuPresentation.evaluate(status(true), fresh: true, microphone: "denied", screenCapture: false, services: [conflict], sending: false)
    precondition(active.status == "Recording" && active.canStop && !active.canStart, "Active recording remains visible during another warning")
    menuController.applyRecordingActions(active)
    precondition(menu.items.first { $0.title == "Stop recording" }?.isEnabled == true)
    let saving = RecordingMenuPresentation.evaluate(status(false, true), fresh: true, microphone: "denied", screenCapture: false, services: [], sending: false)
    precondition(saving.status == "Processing meeting…" && !saving.canStart)
    for locale in MenuLocalization.locales {
        for key in ["Automatic recording", "Settings and permissions", "Diagnostics", "Open Microphone settings…", "Open Screen Recording settings…", "Check recording status again", "Recording needs recovery", "Open recording recovery…", "Recording is not ready", "Recording interface disconnected", "Check recording in interface…"] {
            precondition(!MenuLocalization.text(key, locale: locale).isEmpty)
            if locale != "en" && !(locale == "fr" && key == "Diagnostics") {
                precondition(MenuLocalization.text(key, locale: locale) != key)
            }
        }
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
    let finalOnly = try JSONDecoder().decode(ControlStatus.self, from: Data("{\"recording\":true,\"processing\":false,\"seconds\":12,\"ready\":true,\"clientConnected\":true,\"pending\":false,\"realTimeTranscription\":false}".utf8))
    precondition(finalOnly.captureLabel(locale: "en") == "Recording • live text off; transcript after stop")
    for locale in ["pt-BR", "fr", "de"] { precondition(finalOnly.captureLabel(locale: locale) != finalOnly.captureLabel(locale: "en")) }
    precondition(status(true).captureLabel(locale: "en") == "Recording")
    var transcriptOnly=finalOnly;transcriptOnly.meetingMode="transcript-only"
    precondition(transcriptOnly.captureLabel(locale:"en") == "Recording • live text off; transcript after stop • Transcript only")
    for locale in ["pt-BR","fr","de"] {precondition(transcriptOnly.captureLabel(locale:locale) != transcriptOnly.captureLabel(locale:"en"))}
    let portuguese = try JSONDecoder().decode(ControlStatus.self,from:Data("{\"recording\":true,\"processing\":false,\"seconds\":12,\"ready\":true,\"clientConnected\":false,\"pending\":false,\"liveModel\":\"tiny\",\"liveOptions\":{\"effectiveLanguage\":\"pt\",\"engine\":\"mlx\",\"initialModel\":\"base\"}}".utf8))
    for locale in MenuLocalization.locales {
        precondition(portuguese.captureLabel(locale:locale).contains(MenuLocalization.text("Brazilian Portuguese",locale:locale)))
        precondition(portuguese.captureLabel(locale:locale).contains("mlx / tiny"))
    }
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
    try serviceEndpointsSelfTests()
    try meetingDetectionClientSelfTests()
    try liveLanguageClientSelfTests()
    try smbFolderAccessSelfTests()
    print("Heed menubar self-tests passed")
} else {
    let lockURL = (updateQARoot()?.appendingPathComponent("home") ?? FileManager.default.homeDirectoryForCurrentUser)
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
