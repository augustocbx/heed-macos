import Foundation

struct ScreenCaptureRecovery {
    private(set) var resumeCommandID: String?
    init(arguments: [String]) {
        let matches = arguments.indices.filter { arguments[$0] == "--resume-screen-capture-recovery" }
        guard matches.count == 1, let position = matches.first, position + 1 < arguments.count,
              let uuid = UUID(uuidString: arguments[position + 1]),
              uuid.uuidString.lowercased() == arguments[position + 1] else { return }
        resumeCommandID = arguments[position + 1]
    }
    mutating func consumeResume(commandID: String, action: String) -> Bool {
        guard action == "recoverScreenCapture", resumeCommandID == commandID else { return false }
        resumeCommandID = nil
        return true
    }
    static func readyToRestart(_ data: Data) -> Bool {
        struct Handshake: Decodable { let readyToRestart: Bool }
        guard data.count <= 4096, let reply = try? JSONDecoder().decode(Handshake.self, from: data) else { return false }
        return reply.readyToRestart
    }
    static func readHandshake(_ handle: FileHandle) throws -> Bool {
        var line = Data()
        while let byte = try handle.read(upToCount: 1), !byte.isEmpty {
            if byte[0] == 10 { return readyToRestart(line) }
            guard line.count < 4096 else { return false }
            line.append(byte)
        }
        return false
    }
    static func canBegin(fresh: Bool, idle: Bool, maintenance: Bool, updating: Bool, booting: Bool, sending: Bool) -> Bool {
        fresh && idle && !maintenance && !updating && !booting && !sending
    }
}

/// Read the handoff without waiting for the child, which must outlive this menu instance.
func launchScreenCaptureRecovery(root: String, app: String, commandID: String,
                                 environment: [String: String], ready: @escaping () -> Void, failed: @escaping () -> Void) {
    DispatchQueue.global(qos: .utility).async {
        let process = Process(), pipe = Pipe()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/python3")
        process.arguments = [URL(fileURLWithPath: root).appendingPathComponent("packages/desktop/permission-recovery.py").path,
                             "--root", root, "--app", app, "--pid", String(getpid()), "--command", commandID]
        process.environment = environment
        process.standardOutput = pipe; process.standardError = FileHandle.nullDevice
        do {
            try process.run()
            guard try ScreenCaptureRecovery.readHandshake(pipe.fileHandleForReading), process.isRunning else {
                throw CocoaError(.fileReadCorruptFile)
            }
            DispatchQueue.main.async(execute: ready)
            // If termination is refused, the helper releases its guard and exits after its deadline.
            // Draining keeps its final report writable while this process is still alive.
            while let data = try pipe.fileHandleForReading.read(upToCount: 4096), !data.isEmpty {}
            process.waitUntilExit()
            DispatchQueue.main.async(execute: failed)
        } catch {
            DispatchQueue.main.async(execute: failed)
        }
    }
}

func permissionRecoverySelfTests() {
    let command = "01234567-89ab-4cde-8fab-0123456789ab"
    precondition(ScreenCaptureRecovery.canBegin(fresh: true, idle: true, maintenance: false, updating: false, booting: false, sending: false), "Fresh idle state must allow an explicit recovery request")
    for blocker in 0..<6 {
        precondition(!ScreenCaptureRecovery.canBegin(fresh: blocker != 0, idle: blocker != 1, maintenance: blocker == 2, updating: blocker == 3, booting: blocker == 4, sending: blocker == 5), "Each busy or unknown condition must independently prevent native recovery")
    }
    var recovery = ScreenCaptureRecovery(arguments: ["Heed", "--resume-screen-capture-recovery", command])
    precondition(!recovery.consumeResume(commandID: command, action: "screenCapture"), "An ordinary authorization must never resume recovery")
    precondition(!recovery.consumeResume(commandID: "11234567-89ab-4cde-8fab-0123456789ab", action: "recoverScreenCapture"), "Another pending command must not resume recovery")
    precondition(recovery.consumeResume(commandID: command, action: "recoverScreenCapture"), "The exact queued recovery must resume without a second reset")
    precondition(!recovery.consumeResume(commandID: command, action: "recoverScreenCapture"), "A resume token must be consumed once")
    for arguments in [["Heed"], ["Heed", "--resume-screen-capture-recovery"],
                      ["Heed", "--resume-screen-capture-recovery", "not-a-uuid"],
                      ["Heed", "--resume-screen-capture-recovery", command, "--resume-screen-capture-recovery", command]] {
        precondition(ScreenCaptureRecovery(arguments: arguments).resumeCommandID == nil, "Malformed or ambiguous recovery arguments must be ignored")
    }
    precondition(ScreenCaptureRecovery.readyToRestart(Data("{\"readyToRestart\":true}".utf8)))
    for (payload, expected) in [("{\"readyToRestart\":true}\n", true), ("{\"readyToRestart\":true}", false),
                               ("{\"readyToRestart\":true}\n{\"authorized\":false}\n", true),
                               (String(repeating: " ", count: 4097) + "\n", false)] {
        let pipe = Pipe()
        pipe.fileHandleForWriting.write(Data(payload.utf8)); try! pipe.fileHandleForWriting.close()
        precondition(try! ScreenCaptureRecovery.readHandshake(pipe.fileHandleForReading) == expected,
                     "Restart must require a complete first line and must not wait for the helper's final result")
    }
    for payload in ["{}", "{\"readyToRestart\":false}", "{\"readyToRestart\":1}", "not json", "{\"error\":\"failed\"}", String(repeating: " ", count: 4097)] {
        precondition(!ScreenCaptureRecovery.readyToRestart(Data(payload.utf8)), "Only a bounded affirmative handshake permits restart")
    }
}
