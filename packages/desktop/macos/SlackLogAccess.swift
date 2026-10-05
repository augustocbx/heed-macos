import AppKit
import Foundation

/// Permissão limitada à pasta de registros, concedida pelo seletor do macOS.
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
        // Aplicativos sem sandbox podem receber false mesmo com acesso concedido
        // pelo seletor. O detector verifica a leitura efetiva, sem negar por isso.
    }

    func restore() -> URL? {
        guard let data = defaults.data(forKey: key) else { return nil }
        do {
            var stale = false
            let url = try URL(resolvingBookmarkData: data, options: [.withSecurityScope, .withoutUI], relativeTo: nil, bookmarkDataIsStale: &stale)
            guard isAllowed(url) else { diagnostic = "A autorização salva não corresponde à pasta de registros do Slack."; return nil }
            retainScope(url)
            if stale {
                let renewed = try url.bookmarkData(options: [.withSecurityScope, .securityScopeAllowOnlyReadAccess], includingResourceValuesForKeys: nil, relativeTo: nil)
                defaults.set(renewed, forKey: key)
            }
            diagnostic = nil
            return url
        } catch {
            diagnostic = "Não foi possível restaurar a autorização dos registros do Slack (código \((error as NSError).code))."
            return nil
        }
    }

    func request(completion: @escaping (URL?) -> Void) {
        let panel = NSOpenPanel()
        panel.title = "Autorizar detecção de reuniões do Slack"
        panel.message = "Selecione a pasta logs do Slack. O Heed lê somente os registros para detectar quando uma reunião começa."
        panel.prompt = "Autorizar registros"
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
                self.diagnostic = "Autorização dos registros do Slack cancelada."
                completion(nil)
                return
            }
            guard self.isAllowed(url) else {
                self.diagnostic = "Selecione exatamente a pasta logs do Slack; outras pastas não serão autorizadas."
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
                // A seleção já concedeu acesso nesta execução, mesmo que não
                // seja possível persistir o bookmark para a próxima abertura.
                self.diagnostic = "Acesso autorizado nesta execução; não foi possível salvar a autorização (código \((error as NSError).code))."
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
    try check(access.expectedRoots.allSatisfy { access.isAllowed($0) }, "Aceitar somente raízes previstas")
    try check(!access.isAllowed(home), "Não autorizar home")
    try check(!access.isAllowed(access.expectedRoots[0].deletingLastPathComponent()), "Não autorizar todos os dados do Slack")
    try check(!access.isAllowed(access.expectedRoots[0].appendingPathComponent("default")), "Selecionar exatamente logs")
    try check(!access.isAllowed(home.appendingPathComponent("Library/Application Support/Other/logs")), "Não autorizar outro aplicativo")
    try check(access.restore() == nil, "Sem bookmark não restaurar")
}
