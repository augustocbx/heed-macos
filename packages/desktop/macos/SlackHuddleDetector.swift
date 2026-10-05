import Foundation

/// Observes only native client state transitions; does not store Slack content.
/// These logs are a private Slack implementation and may change between versions.
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
        // The next poll establishes a new EOF without reading older meetings.
    }

    /// Checks readability even when Slack is closed; process state is not permission.
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
        default: return nil // PENDING/PRE_JOINED are only preparation.
        }
    }

    /// nil means no supported log is available. The first
    /// access starts at EOF: earlier meetings do not trigger retroactive recording.
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
            // Bounds work and memory per poll; does not read older history.
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
    try check(SlackHuddleDetector.transition("[HUDDLES] updateActiveHuddleReference huddleState STARTED, substate undefined") == true, "STARTED must start")
    try check(SlackHuddleDetector.transition("[HUDDLES] updateActiveHuddleReference huddleState ENDING, substate undefined") == false, "ENDING must end")
    try check(SlackHuddleDetector.transition("[HUDDLES] updateActiveHuddleReference huddleState NOT_STARTED, substate undefined") == false, "NOT_STARTED must end")
    for state in ["PRE_JOINED", "PENDING", "COMPLETING_PRE_JOIN", "STARTED_OTHER"] {
        try check(SlackHuddleDetector.transition("[HUDDLES] updateActiveHuddleReference huddleState \(state), substate undefined") == nil, "Preparation must not start")
    }
    try check(SlackHuddleDetector.transition("[HUDDLE-CLIENT-MIDDLEW] User started huddle") == nil, "Intent must not start")
    try check(SlackHuddleDetector.transition("[HUDDLE-SDK] Received meeting event: audioInputSelected") == nil, "Microphone testing must not start")
    try check(SlackHuddleDetector.transition("[10/05/26, 14:00:29:836] info: [HUDDLES] updateActiveHuddleReference huddleState STARTED, substate undefined") == true, "The actual log format must start")
    try check(SlackHuddleDetector.transition("[OTHER] updateActiveHuddleReference huddleState STARTED") == nil, "A different logger must be ignored")
    let home = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: home) }
    let dir = home.appendingPathComponent("Library/Application Support/Slack/logs/default")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let file = dir.appendingPathComponent("webapp-console.log")
    let start = "[HUDDLES] updateActiveHuddleReference huddleState STARTED, substate undefined\n"
    let stop = "[HUDDLES] updateActiveHuddleReference huddleState NOT_STARTED, substate undefined\n"
    try Data(start.utf8).write(to: file)
    let detector = SlackHuddleDetector(home: home)
    try check(detector.canReadLogs, "Settings must check actual readability")
    try check(detector.poll(slackRunning: true) == false, "History must start at EOF")
    func append(_ text: String) throws {
        let handle = try FileHandle(forWritingTo: file)
        defer { try? handle.close() }
        try handle.seekToEnd()
        try handle.write(contentsOf: Data(text.utf8))
    }
    try append(String(start.dropLast()))
    try check(detector.poll(slackRunning: true) == false, "A partial line must wait for a newline")
    try append("\n")
    try check(detector.poll(slackRunning: true) == true, "A new STARTED must start")
    try append(stop)
    try check(detector.poll(slackRunning: true) == false, "A new NOT_STARTED must end")
    try Data(start.utf8).write(to: file, options: .atomic)
    try check(detector.poll(slackRunning: true) == true, "Rotation must follow the new file")
    let otherDir = dir.deletingLastPathComponent().appendingPathComponent("another")
    try FileManager.default.createDirectory(at: otherDir, withIntermediateDirectories: true)
    let otherFile = otherDir.appendingPathComponent("webapp-console.log")
    try Data(start.utf8).write(to: otherFile)
    try append(stop)
    try check(detector.poll(slackRunning: true) == false, "A new file must ignore earlier history")
    let otherHandle = try FileHandle(forWritingTo: otherFile)
    try otherHandle.seekToEnd()
    try otherHandle.write(contentsOf: Data(start.utf8))
    try otherHandle.close()
    try append(stop)
    try check(detector.poll(slackRunning: true) == true, "A stop from another source must not end the active source")
    detector.setAuthorizedLogRoot(dir.deletingLastPathComponent())
    try check(detector.poll(slackRunning: true) == false, "New authorization must restart at EOF")
    try append(start)
    try check(detector.poll(slackRunning: true) == true, "Ler novos eventos da raiz autorizada")
    try check(detector.poll(slackRunning: false) == false, "Closing Slack must end detection")
    let missing = SlackHuddleDetector(home: home.appendingPathComponent("missing"))
    _ = missing.poll(slackRunning: false)
    try check(!missing.canReadLogs, "Closing Slack must not invent permission")
}
