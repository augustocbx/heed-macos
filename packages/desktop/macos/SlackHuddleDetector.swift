import Foundation

/// Observa apenas transições de estado do cliente nativo; não guarda conteúdo do Slack.
/// Os registros são uma implementação privada do Slack e podem mudar entre versões.
final class SlackHuddleDetector {
    private struct Cursor {
        var inode: UInt64
        var offset: UInt64
        var partial = Data()
    }
    private let defaultRoots: [URL]
    private var authorizedLogRoot: URL?
    private var roots: [URL] { authorizedLogRoot.map { [$0] } ?? defaultRoots }
    private var cursors: [String: Cursor] = [:]
    private var states: [String: Bool] = [:]
    private(set) var available = false

    init(home: URL = FileManager.default.homeDirectoryForCurrentUser) {
        defaultRoots = [
            home.appendingPathComponent("Library/Containers/com.tinyspeck.slackmacgap/Data/Library/Application Support/Slack/logs"),
            home.appendingPathComponent("Library/Application Support/Slack/logs")
        ]
    }

    func setAuthorizedLogRoot(_ url: URL?) {
        authorizedLogRoot = url
        cursors.removeAll()
        states.removeAll()
        available = false
        // A consulta seguinte estabelece novo EOF, sem ler reuniões antigas.
    }

    /// Verifica a leitura mesmo com o Slack fechado; estado do processo não é permissão.
    var canReadLogs: Bool {
        for root in roots {
            guard let children = try? FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil) else { continue }
            for child in children {
                if let handle = try? FileHandle(forReadingFrom: child.appendingPathComponent("webapp-console.log")) {
                    defer { try? handle.close() }
                    if (try? handle.read(upToCount: 1)) != nil { return true }
                }
            }
        }
        return false
    }

    static func transition(_ line: String) -> Bool? {
        let pattern = #"^(?:\[[0-9/:, .]+\]\s*)?(?:info:\s*)?\[HUDDLES\]\s+updateActiveHuddleReference huddleState ([A-Z_]+)(?:,|\s|$)"#
        guard let match = line.range(of: pattern, options: .regularExpression),
              let stateMarker = line[match].range(of: "huddleState ") else { return nil }
        let state = line[stateMarker.upperBound...].prefix { $0.isLetter || $0 == "_" }
        switch state {
        case "STARTED": return true
        case "ENDING", "NOT_STARTED": return false
        default: return nil // PENDING/PRE_JOINED são apenas preparação.
        }
    }

    /// nil significa que nenhum registro suportado está disponível. No primeiro
    /// acesso começa no EOF: reuniões anteriores não disparam gravação retroativa.
    func poll(slackRunning: Bool) -> Bool? {
        guard slackRunning else {
            states.removeAll()
            cursors.removeAll()
            available = true
            return false
        }
        let fm = FileManager.default
        var files: [URL] = []
        for root in roots {
            if let children = try? fm.contentsOfDirectory(at: root, includingPropertiesForKeys: nil) {
                for child in children {
                    let file = child.appendingPathComponent("webapp-console.log")
                    if fm.fileExists(atPath: file.path) { files.append(file) }
                }
            }
        }
        available = !files.isEmpty
        guard available else { return nil }
        var readAny = false
        for file in files.sorted(by: { $0.path < $1.path }) {
            guard let attrs = try? fm.attributesOfItem(atPath: file.path),
                  let number = attrs[.systemFileNumber] as? NSNumber,
                  let sizeNumber = attrs[.size] as? NSNumber,
                  let handle = try? FileHandle(forReadingFrom: file) else { continue }
            defer { try? handle.close() }
            let inode = number.uint64Value
            let size = sizeNumber.uint64Value
            var cursor = cursors[file.path] ?? Cursor(inode: inode, offset: size)
            if cursor.inode != inode || size < cursor.offset {
                cursor = Cursor(inode: inode, offset: 0)
            }
            // Limita trabalho/memória por consulta; não busca históricos antigos.
            if size > cursor.offset + 262_144 {
                cursor.offset = size - 262_144
                cursor.partial.removeAll()
            }
            do {
                try handle.seek(toOffset: cursor.offset)
                let chunk = try handle.read(upToCount: 262_144) ?? Data()
                readAny = true
                cursor.offset += UInt64(chunk.count)
                cursor.partial.append(chunk)
                while let newline = cursor.partial.firstIndex(of: 10) {
                    let line = String(decoding: cursor.partial[..<newline], as: UTF8.self)
                    cursor.partial.removeSubrange(...newline)
                    if let state = Self.transition(line) { states[file.path] = state }
                }
                if cursor.partial.count > 65_536 { cursor.partial.removeAll() }
                cursors[file.path] = cursor
            } catch { continue }
        }
        if !readAny { available = false; return nil }
        return states.values.contains(true)
    }
}

func slackHuddleDetectorSelfTests() throws {
    func check(_ condition: @autoclosure () -> Bool, _ message: String) throws {
        if !condition() { throw NSError(domain: "SlackHuddleDetector", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
    }
    try check(SlackHuddleDetector.transition("[HUDDLES] updateActiveHuddleReference huddleState STARTED, substate undefined") == true, "STARTED deve iniciar")
    try check(SlackHuddleDetector.transition("[HUDDLES] updateActiveHuddleReference huddleState ENDING, substate undefined") == false, "ENDING deve encerrar")
    try check(SlackHuddleDetector.transition("[HUDDLES] updateActiveHuddleReference huddleState NOT_STARTED, substate undefined") == false, "NOT_STARTED deve encerrar")
    for state in ["PRE_JOINED", "PENDING", "COMPLETING_PRE_JOIN", "STARTED_OTHER"] {
        try check(SlackHuddleDetector.transition("[HUDDLES] updateActiveHuddleReference huddleState \(state), substate undefined") == nil, "Preparação não deve iniciar")
    }
    try check(SlackHuddleDetector.transition("[HUDDLE-CLIENT-MIDDLEW] User started huddle") == nil, "Intenção não deve iniciar")
    try check(SlackHuddleDetector.transition("[HUDDLE-SDK] Received meeting event: audioInputSelected") == nil, "Teste de microfone não deve iniciar")
    try check(SlackHuddleDetector.transition("[10/05/26, 14:00:29:836] info: [HUDDLES] updateActiveHuddleReference huddleState STARTED, substate undefined") == true, "Formato real deve iniciar")
    try check(SlackHuddleDetector.transition("[OTHER] updateActiveHuddleReference huddleState STARTED") == nil, "Logger diferente deve ser ignorado")
    let home = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: home) }
    let dir = home.appendingPathComponent("Library/Application Support/Slack/logs/default")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let file = dir.appendingPathComponent("webapp-console.log")
    let start = "[HUDDLES] updateActiveHuddleReference huddleState STARTED, substate undefined\n"
    let stop = "[HUDDLES] updateActiveHuddleReference huddleState NOT_STARTED, substate undefined\n"
    try Data(start.utf8).write(to: file)
    let detector = SlackHuddleDetector(home: home)
    try check(detector.canReadLogs, "Configurações devem verificar leitura real")
    try check(detector.poll(slackRunning: true) == false, "Histórico deve começar no EOF")
    func append(_ text: String) throws {
        let handle = try FileHandle(forWritingTo: file)
        defer { try? handle.close() }
        try handle.seekToEnd()
        try handle.write(contentsOf: Data(text.utf8))
    }
    try append(String(start.dropLast()))
    try check(detector.poll(slackRunning: true) == false, "Linha parcial deve aguardar newline")
    try append("\n")
    try check(detector.poll(slackRunning: true) == true, "Novo STARTED deve iniciar")
    try append(stop)
    try check(detector.poll(slackRunning: true) == false, "Novo NOT_STARTED deve encerrar")
    try Data(start.utf8).write(to: file, options: .atomic)
    try check(detector.poll(slackRunning: true) == true, "Rotação deve seguir arquivo novo")
    let otherDir = dir.deletingLastPathComponent().appendingPathComponent("another")
    try FileManager.default.createDirectory(at: otherDir, withIntermediateDirectories: true)
    let otherFile = otherDir.appendingPathComponent("webapp-console.log")
    try Data(start.utf8).write(to: otherFile)
    try append(stop)
    try check(detector.poll(slackRunning: true) == false, "Arquivo novo deve ignorar histórico")
    let otherHandle = try FileHandle(forWritingTo: otherFile)
    try otherHandle.seekToEnd()
    try otherHandle.write(contentsOf: Data(start.utf8))
    try otherHandle.close()
    try append(stop)
    try check(detector.poll(slackRunning: true) == true, "Stop de outra origem não deve encerrar origem ativa")
    detector.setAuthorizedLogRoot(dir.deletingLastPathComponent())
    try check(detector.poll(slackRunning: true) == false, "Nova autorização deve recomeçar no EOF")
    try append(start)
    try check(detector.poll(slackRunning: true) == true, "Ler novos eventos da raiz autorizada")
    try check(detector.poll(slackRunning: false) == false, "Slack fechado deve encerrar")
    let missing = SlackHuddleDetector(home: home.appendingPathComponent("missing"))
    _ = missing.poll(slackRunning: false)
    try check(!missing.canReadLogs, "Slack fechado não deve inventar autorização")
}
