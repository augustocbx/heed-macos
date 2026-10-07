import AppKit
import CoreGraphics
import Foundation

enum ScreenCaptureActionRoute {
    case directPane
    case guidedReplacement

    static func forPreflight(_ granted: Bool) -> Self { granted ? .directPane : .guidedReplacement }
}

enum UpdatePermissionHelpRoute {
    case general
    case screenGuide

    static func forMissing(_ missing: [String]?) -> Self {
        missing?.contains("screenCapture") == true ? .screenGuide : .general
    }

    static func forHelp(screenAuthorized: Bool, missing: [String]?, reportVersion: String?, installedVersion: String?) -> Self {
        if !screenAuthorized { return .screenGuide }
        guard let reportVersion, reportVersion == installedVersion else { return .general }
        return forMissing(missing)
    }
}

enum ScreenCaptureGuideLocalization {
    static let translations: [String: [String: String]] = [
        "Screen & System Audio Recording guide": ["pt-BR": "Guia de gravação de tela e áudio do sistema", "fr": "Guide d’enregistrement de l’écran et de l’audio système", "de": "Anleitung für Bildschirm- und Systemaudioaufnahme"],
        "Add Heed to Screen & System Audio Recording": ["pt-BR": "Adicione o Heed à Gravação de Tela e Áudio do Sistema", "fr": "Ajoutez Heed à l’enregistrement de l’écran et de l’audio système", "de": "Heed zur Bildschirm- und Systemaudioaufnahme hinzufügen"],
        "Open System Settings > Privacy & Security > Screen & System Audio Recording. Keep this guide beside Settings.": ["pt-BR": "Abra Ajustes do Sistema > Privacidade e Segurança > Gravação de Tela e Áudio do Sistema. Mantenha este guia ao lado dos Ajustes.", "fr": "Ouvrez Réglages Système > Confidentialité et sécurité > Enregistrement de l’écran et de l’audio système. Gardez ce guide à côté des réglages.", "de": "Öffnen Sie Systemeinstellungen > Datenschutz & Sicherheit > Bildschirm- und Systemaudioaufnahme. Lassen Sie diese Anleitung neben den Einstellungen geöffnet."],
        "Drag the installed Heed app below into the app list in System Settings, then turn on its switch.": ["pt-BR": "Arraste o aplicativo Heed instalado abaixo para a lista nos Ajustes do Sistema e ative a opção.", "fr": "Faites glisser l’application Heed installée ci-dessous dans la liste des Réglages Système, puis activez son autorisation.", "de": "Ziehen Sie die unten angezeigte installierte Heed-App in die Liste der Systemeinstellungen und aktivieren Sie den Schalter."],
        "If dragging does not work, click + in System Settings. In the file picker, press Command-Shift-G, enter ~/Applications, then select ~/Applications/Heed.app.": ["pt-BR": "Se não conseguir arrastar, clique em + nos Ajustes do Sistema. No seletor de arquivos, pressione Command-Shift-G, digite ~/Applications e selecione ~/Applications/Heed.app.", "fr": "Si le glisser-déposer ne fonctionne pas, cliquez sur + dans les Réglages Système. Dans la fenêtre de sélection, appuyez sur Command-Shift-G, saisissez ~/Applications, puis sélectionnez ~/Applications/Heed.app.", "de": "Falls das Ziehen nicht funktioniert, klicken Sie in den Systemeinstellungen auf +. Drücken Sie im Dateidialog Command-Shift-G, geben Sie ~/Applications ein und wählen Sie ~/Applications/Heed.app."],
        "The running Heed app could not be verified at ~/Applications/Heed.app. Reinstall Heed there, reopen it, then reopen this guide before adding the app in System Settings.": ["pt-BR": "Não foi possível verificar o Heed em execução em ~/Applications/Heed.app. Reinstale o Heed nesse local, reabra-o e depois reabra este guia antes de adicionar o aplicativo nos Ajustes do Sistema.", "fr": "L’application Heed en cours d’exécution n’a pas pu être vérifiée à ~/Applications/Heed.app. Réinstallez Heed à cet emplacement, rouvrez-la, puis rouvrez ce guide avant de l’ajouter dans les Réglages Système.", "de": "Die laufende Heed-App konnte unter ~/Applications/Heed.app nicht überprüft werden. Installieren Sie Heed dort erneut, öffnen Sie die App und dann diese Anleitung wieder, bevor Sie sie in den Systemeinstellungen hinzufügen."],
        "After updating, if capture still fails, turn Heed off and on in this pane, then quit and reopen Heed. Check Microphone separately if needed. Heed does not reset permissions automatically.": ["pt-BR": "Após atualizar, se a captura ainda falhar, desative e reative o Heed nesta tela, depois encerre e reabra o aplicativo. Verifique o Microfone separadamente se necessário. O Heed não redefine permissões automaticamente.", "fr": "Après une mise à jour, si la capture échoue encore, désactivez puis réactivez Heed dans cette fenêtre, puis quittez et rouvrez l’application. Vérifiez le microphone séparément si nécessaire. Heed ne réinitialise pas automatiquement les autorisations.", "de": "Falls die Aufnahme nach einem Update weiterhin fehlschlägt, deaktivieren und aktivieren Sie Heed in diesem Bereich und starten Sie die App neu. Prüfen Sie das Mikrofon bei Bedarf separat. Heed setzt Berechtigungen nicht automatisch zurück."],
        "Screen recording access is allowed.": ["pt-BR": "O acesso à gravação de tela está autorizado.", "fr": "L’accès à l’enregistrement de l’écran est autorisé.", "de": "Der Zugriff auf die Bildschirmaufnahme ist erlaubt."],
        "Screen recording is still not allowed. Add or enable Heed in System Settings, follow any quit and reopen prompt, then check again.": ["pt-BR": "A gravação de tela ainda não está autorizada. Adicione ou ative o Heed nos Ajustes do Sistema, siga qualquer solicitação para encerrar e reabrir e verifique novamente.", "fr": "L’enregistrement de l’écran n’est toujours pas autorisé. Ajoutez ou activez Heed dans les Réglages Système, suivez toute invitation à quitter et rouvrir l’application, puis vérifiez à nouveau.", "de": "Die Bildschirmaufnahme ist weiterhin nicht erlaubt. Fügen Sie Heed in den Systemeinstellungen hinzu oder aktivieren Sie es, folgen Sie einer möglichen Aufforderung zum Beenden und erneuten Öffnen und prüfen Sie dann erneut."],
        "Reinstall and reopen Heed before checking screen recording access again.": ["pt-BR": "Reinstale e reabra o Heed antes de verificar novamente o acesso à gravação de tela.", "fr": "Réinstallez et rouvrez Heed avant de revérifier l’accès à l’enregistrement de l’écran.", "de": "Installieren und öffnen Sie Heed erneut, bevor Sie den Zugriff auf die Bildschirmaufnahme erneut prüfen."],
        "Open Screen & System Audio Recording": ["pt-BR": "Abrir Gravação de Tela e Áudio do Sistema", "fr": "Ouvrir l’enregistrement de l’écran et de l’audio système", "de": "Bildschirm- und Systemaudioaufnahme öffnen"],
        "Open Applications folder": ["pt-BR": "Abrir pasta Aplicativos", "fr": "Ouvrir le dossier Applications", "de": "Programme-Ordner öffnen"],
        "Show Heed in Finder": ["pt-BR": "Mostrar Heed no Finder", "fr": "Afficher Heed dans le Finder", "de": "Heed im Finder anzeigen"],
        "Check screen recording again": ["pt-BR": "Verificar gravação de tela novamente", "fr": "Revérifier l’enregistrement de l’écran", "de": "Bildschirmaufnahme erneut prüfen"],
        "Drag Heed.app to System Settings": ["pt-BR": "Arrastar Heed.app para os Ajustes do Sistema", "fr": "Faire glisser Heed.app vers les Réglages Système", "de": "Heed.app in die Systemeinstellungen ziehen"],
        "Drag this app into the Screen & System Audio Recording list. Use Show Heed in Finder or the + button if dragging is unavailable.": ["pt-BR": "Arraste este aplicativo para a lista de Gravação de Tela e Áudio do Sistema. Se não puder arrastar, use Mostrar Heed no Finder ou o botão +.", "fr": "Faites glisser cette application dans la liste d’enregistrement de l’écran et de l’audio système. Si cela ne fonctionne pas, utilisez Afficher Heed dans le Finder ou le bouton +.", "de": "Ziehen Sie diese App in die Liste der Bildschirm- und Systemaudioaufnahme. Falls das Ziehen nicht möglich ist, verwenden Sie „Heed im Finder anzeigen“ oder die Schaltfläche +."],
        "If an old Heed.app entry remains, select it and click −. This removes only its permission entry; the installed app and meeting data remain.": ["pt-BR": "Se uma entrada antiga do Heed.app permanecer, selecione-a e clique em −. Isso remove apenas a entrada de permissão; o aplicativo instalado e os dados das reuniões permanecem.", "fr": "Si une ancienne entrée Heed.app reste affichée, sélectionnez-la et cliquez sur −. Cela supprime uniquement son entrée d’autorisation ; l’application installée et les données des réunions restent intactes.", "de": "Falls ein alter Heed.app-Eintrag noch vorhanden ist, wählen Sie ihn aus und klicken Sie auf −. Dadurch wird nur der Berechtigungseintrag entfernt; die installierte App und die Besprechungsdaten bleiben erhalten."],
        "After adding Heed, enable its new switch. If macOS asks to quit and reopen Heed, follow that prompt, reopen this guide from the permission action, then click Check screen recording again in the reopened window.": ["pt-BR": "Depois de adicionar o Heed, ative a nova opção. Se o macOS pedir para encerrar e reabrir o Heed, siga a solicitação, reabra este guia pela ação de permissão e clique em Verificar gravação de tela novamente na janela reaberta.", "fr": "Après avoir ajouté Heed, activez sa nouvelle autorisation. Si macOS demande de quitter et rouvrir Heed, suivez cette invitation, rouvrez ce guide depuis l’action d’autorisation, puis cliquez sur Revérifier l’enregistrement de l’écran dans la fenêtre rouverte.", "de": "Aktivieren Sie nach dem Hinzufügen von Heed den neuen Schalter. Wenn macOS zum Beenden und erneuten Öffnen von Heed auffordert, folgen Sie der Aufforderung, öffnen Sie diese Anleitung über die Berechtigungsaktion erneut und klicken Sie im erneut geöffneten Fenster auf „Bildschirmaufnahme erneut prüfen“."],
        "For Microphone, open its separate privacy pane and enable Heed. A restricted microphone requires your device administrator. Reauthorize Slack or shared folders only if their access no longer works.": ["pt-BR": "Para Microfone, abra a tela de privacidade separada e ative o Heed. Um microfone restrito exige ajuda do administrador do dispositivo. Autorize o Slack ou pastas compartilhadas novamente apenas se o acesso deixar de funcionar.", "fr": "Pour le microphone, ouvrez son volet de confidentialité distinct et activez Heed. Un microphone restreint nécessite l’administrateur de l’appareil. Réautorisez Slack ou les dossiers partagés uniquement si leur accès ne fonctionne plus.", "de": "Öffnen Sie für das Mikrofon den separaten Datenschutzbereich und aktivieren Sie Heed. Ein eingeschränktes Mikrofon erfordert den Geräteadministrator. Erlauben Sie Slack oder freigegebene Ordner erneut nur, wenn der Zugriff nicht mehr funktioniert."],
        "Open Microphone privacy settings": ["pt-BR": "Abrir ajustes de privacidade do Microfone", "fr": "Ouvrir les réglages de confidentialité du microphone", "de": "Mikrofon-Datenschutzeinstellungen öffnen"]
    ]
}

enum InstalledHeedApp {
    static func resolve(home: URL = FileManager.default.homeDirectoryForCurrentUser,
                        runningApp: URL = Bundle.main.bundleURL,
                        runningVersion: String? = Bundle.main.infoDictionary?["CFBundleVersion"] as? String) -> URL? {
        let app = home.appendingPathComponent("Applications/Heed.app")
        let manager = FileManager.default
        guard app.resolvingSymlinksInPath().standardizedFileURL.path == runningApp.resolvingSymlinksInPath().standardizedFileURL.path,
              let attributes = try? manager.attributesOfItem(atPath: app.path),
              attributes[.type] as? FileAttributeType == .typeDirectory,
              let data = try? Data(contentsOf: app.appendingPathComponent("Contents/Info.plist")),
              let info = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any],
              info["CFBundleIdentifier"] as? String == "local.heed.menubar",
              info["CFBundlePackageType"] as? String == "APPL",
              info["CFBundleExecutable"] as? String == "Heed",
              runningVersion == nil || info["CFBundleVersion"] as? String == runningVersion else { return nil }
        let executable = app.appendingPathComponent("Contents/MacOS/Heed")
        guard let executableAttributes = try? manager.attributesOfItem(atPath: executable.path),
              executableAttributes[.type] as? FileAttributeType == .typeRegular,
              manager.isExecutableFile(atPath: executable.path) else { return nil }
        return app
    }
}

struct ScreenCaptureGuideState {
    let home: URL
    let runningApp: URL
    let runningVersion: String?
    let preflight: () -> Bool
    private(set) var appURL: URL?
    private(set) var authorized: Bool

    init(home: URL = FileManager.default.homeDirectoryForCurrentUser,
         runningApp: URL = Bundle.main.bundleURL,
         runningVersion: String? = Bundle.main.infoDictionary?["CFBundleVersion"] as? String,
         preflight: @escaping () -> Bool = { CGPreflightScreenCaptureAccess() }) {
        self.home = home
        self.runningApp = runningApp
        self.runningVersion = runningVersion
        self.preflight = preflight
        appURL = InstalledHeedApp.resolve(home: home, runningApp: runningApp, runningVersion: runningVersion)
        authorized = preflight()
    }

    mutating func refresh() {
        appURL = InstalledHeedApp.resolve(home: home, runningApp: runningApp, runningVersion: runningVersion)
        authorized = preflight()
    }

    var statusKey: String {
        guard appURL != nil else { return "Reinstall and reopen Heed before checking screen recording access again." }
        return authorized ? "Screen recording access is allowed." : "Screen recording is still not allowed. Add or enable Heed in System Settings, follow any quit and reopen prompt, then check again."
    }

    var canOfferAddSteps: Bool { appURL != nil }
}

private final class HeedAppDragSource: NSView, NSDraggingSource {
    var appURL: URL?
    var label = ""

    override var acceptsFirstResponder: Bool { appURL != nil }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        NSColor.controlBackgroundColor.setFill()
        NSBezierPath(roundedRect: bounds.insetBy(dx: 2, dy: 2), xRadius: 12, yRadius: 12).fill()
        NSColor.separatorColor.setStroke()
        NSBezierPath(roundedRect: bounds.insetBy(dx: 2, dy: 2), xRadius: 12, yRadius: 12).stroke()
        guard let appURL else { return }
        NSWorkspace.shared.icon(forFile: appURL.path).draw(in: NSRect(x: 18, y: 13, width: 64, height: 64))
        (label as NSString).draw(at: NSPoint(x: 96, y: 35), withAttributes: [
            .font: NSFont.systemFont(ofSize: 15, weight: .semibold),
            .foregroundColor: NSColor.labelColor
        ])
    }

    override func mouseDown(with event: NSEvent) {
        guard let appURL = InstalledHeedApp.resolve(), appURL == self.appURL else { return }
        let item = NSDraggingItem(pasteboardWriter: appURL as NSURL)
        item.setDraggingFrame(NSRect(x: 14, y: 12, width: 72, height: 72), contents: NSWorkspace.shared.icon(forFile: appURL.path))
        beginDraggingSession(with: [item], event: event, source: self)
    }

    func draggingSession(_ session: NSDraggingSession, sourceOperationMaskFor context: NSDraggingContext) -> NSDragOperation { .copy }
}

final class ScreenCaptureGuideWindow: NSObject {
    private let window: NSWindow
    private let source = HeedAppDragSource(frame: NSRect(x: 0, y: 0, width: 560, height: 92))
    private let title = NSTextField(wrappingLabelWithString: "")
    private let intro = NSTextField(wrappingLabelWithString: "")
    private let staleEntry = NSTextField(wrappingLabelWithString: "")
    private let dragInstruction = NSTextField(wrappingLabelWithString: "")
    private let fallback = NSTextField(wrappingLabelWithString: "")
    private let completion = NSTextField(wrappingLabelWithString: "")
    private let missing = NSTextField(wrappingLabelWithString: "")
    private let updateHelp = NSTextField(wrappingLabelWithString: "")
    private let otherHelp = NSTextField(wrappingLabelWithString: "")
    private let status = NSTextField(wrappingLabelWithString: "")
    private let settingsButton = NSButton(title: "", target: nil, action: nil)
    private let microphoneButton = NSButton(title: "", target: nil, action: nil)
    private let revealButton = NSButton(title: "", target: nil, action: nil)
    private let recheckButton = NSButton(title: "", target: nil, action: nil)
    private var state = ScreenCaptureGuideState()
    private var locale = "en"
    var didRecheck: (() -> Void)?

    override init() {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 640, height: 570),
                          styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
        super.init()
        window.center()
        window.isReleasedWhenClosed = false
        window.level = .floating
        if let visible = NSScreen.main?.visibleFrame {
            window.setFrameOrigin(NSPoint(x: visible.minX + 24, y: visible.midY - 285))
        }
        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 14
        stack.edgeInsets = NSEdgeInsets(top: 24, left: 28, bottom: 24, right: 28)
        stack.translatesAutoresizingMaskIntoConstraints = false
        for view in [title, intro, staleEntry, dragInstruction, source, fallback, completion, missing, updateHelp, otherHelp, status] {
            stack.addArrangedSubview(view)
            view.translatesAutoresizingMaskIntoConstraints = false
            view.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -56).isActive = true
        }
        source.heightAnchor.constraint(equalToConstant: 92).isActive = true
        title.font = NSFont.systemFont(ofSize: 21, weight: .semibold)
        status.font = NSFont.systemFont(ofSize: 13, weight: .medium)
        let actions = NSStackView(views: [settingsButton, microphoneButton, revealButton, recheckButton])
        actions.orientation = .vertical
        actions.alignment = .leading
        actions.spacing = 10
        stack.addArrangedSubview(actions)
        settingsButton.target = self; settingsButton.action = #selector(openSettings)
        microphoneButton.target = self; microphoneButton.action = #selector(openMicrophone)
        revealButton.target = self; revealButton.action = #selector(revealApp)
        recheckButton.target = self; recheckButton.action = #selector(recheck)
        settingsButton.keyEquivalent = "\r"
        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true
        scroll.documentView = stack
        window.contentView = scroll
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: scroll.contentView.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: scroll.contentView.trailingAnchor),
            stack.topAnchor.constraint(equalTo: scroll.contentView.topAnchor),
            stack.widthAnchor.constraint(equalTo: scroll.contentView.widthAnchor)
        ])
    }

    func show(locale: String) {
        self.locale = locale
        state.refresh()
        render()
        NSApplication.shared.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
    }

    private func text(_ key: String) -> String { MenuLocalization.text(key, locale: locale) }

    private func render() {
        window.title = text("Screen & System Audio Recording guide")
        title.stringValue = text("Add Heed to Screen & System Audio Recording")
        intro.stringValue = text("Open System Settings > Privacy & Security > Screen & System Audio Recording. Keep this guide beside Settings.")
        staleEntry.stringValue = text("If an old Heed.app entry remains, select it and click −. This removes only its permission entry; the installed app and meeting data remain.")
        dragInstruction.stringValue = text("Drag the installed Heed app below into the app list in System Settings, then turn on its switch.")
        fallback.stringValue = text("If dragging does not work, click + in System Settings. In the file picker, press Command-Shift-G, enter ~/Applications, then select ~/Applications/Heed.app.")
        completion.stringValue = text("After adding Heed, enable its new switch. If macOS asks to quit and reopen Heed, follow that prompt, reopen this guide from the permission action, then click Check screen recording again in the reopened window.")
        missing.stringValue = text("The running Heed app could not be verified at ~/Applications/Heed.app. Reinstall Heed there, reopen it, then reopen this guide before adding the app in System Settings.")
        updateHelp.stringValue = text("After updating, if capture still fails, turn Heed off and on in this pane, then quit and reopen Heed. Check Microphone separately if needed. Heed does not reset permissions automatically.")
        otherHelp.stringValue = text("For Microphone, open its separate privacy pane and enable Heed. A restricted microphone requires your device administrator. Reauthorize Slack or shared folders only if their access no longer works.")
        status.stringValue = text(state.statusKey)
        settingsButton.title = text("Open Screen & System Audio Recording")
        microphoneButton.title = text("Open Microphone privacy settings")
        revealButton.title = state.appURL == nil ? text("Open Applications folder") : text("Show Heed in Finder")
        recheckButton.title = text("Check screen recording again")
        source.appURL = state.appURL
        source.label = text("Drag Heed.app to System Settings")
        source.setAccessibilityElement(true)
        source.setAccessibilityRole(.image)
        source.setAccessibilityLabel(source.label)
        source.setAccessibilityHelp(text("Drag this app into the Screen & System Audio Recording list. Use Show Heed in Finder or the + button if dragging is unavailable."))
        source.isHidden = !state.canOfferAddSteps
        intro.isHidden = !state.canOfferAddSteps
        dragInstruction.isHidden = !state.canOfferAddSteps
        staleEntry.isHidden = !state.canOfferAddSteps
        fallback.isHidden = !state.canOfferAddSteps
        completion.isHidden = !state.canOfferAddSteps
        missing.isHidden = state.canOfferAddSteps
        source.needsDisplay = true
    }

    @objc private func openSettings() {
        NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")!)
    }

    @objc private func openMicrophone() {
        NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone")!)
    }

    @objc private func revealApp() {
        if let appURL = InstalledHeedApp.resolve() {
            NSWorkspace.shared.activateFileViewerSelecting([appURL])
        } else {
            NSWorkspace.shared.open(FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Applications"))
        }
    }

    @objc private func recheck() {
        state.refresh()
        render()
        didRecheck?()
    }
}
