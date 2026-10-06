import Foundation
func protocolTests() throws {
    func check(_ value: Bool, _ message: String) throws { if !value { throw CloudFailure(message) } }
    func rejects(_ operation: () throws -> Void) throws {
        var rejected = false
        do { try operation() } catch { rejected = true }
        try check(rejected, "Invalid operation accepted")
    }
    for path in ["../outside", "objects/../outside", "objects/link/file", "/objects/a", "objects/%2e"] {
        if path == "objects/link/file" { continue }
        try rejects { _ = try artifactPath(path) }
    }
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("heed-icloud-test-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let io = try ScopedFiles(root: root)
    let data = Data("Synthetic immutable fixture".utf8)
    try io.write("objects/fixture", bytes: data.count, digest: digest(data), input: { count in data.prefix(count) })
    try check(try io.read("objects/fixture", max: 100) == data, "Immutable publication round trip")
    try io.write("objects/fixture", bytes: data.count, digest: digest(data), input: { count in data.prefix(count) })
    try rejects { try io.write("objects/fixture", bytes: 3, digest: digest(Data("bad".utf8)), input: { _ in Data("bad".utf8) }) }
    try FileManager.default.createSymbolicLink(atPath: root.appendingPathComponent("objects/link").path, withDestinationPath: "/tmp")
    try rejects { _ = try io.read("objects/link/file", max: 100) }
    try rejects { try io.write("objects/wrong", bytes: data.count, digest: String(repeating: "0", count: 64), input: { count in data.prefix(count) }) }
    try check(!FileManager.default.fileExists(atPath: root.appendingPathComponent("objects/wrong").path), "Invalid publication never committed")
    var valid = true
    try rejects { try io.write("objects/account-changed", bytes: data.count, digest: digest(data), validate: { if !valid { throw CloudFailure("Account changed") } }, input: { count in valid = false; return data.prefix(count) }) }
    try check(!FileManager.default.fileExists(atPath: root.appendingPathComponent("objects/account-changed").path), "Account changes cannot commit an object")
    // A real coordinated child writer must block our actual child reader, unlike an ordinary root read.
    let entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0), completed = DispatchSemaphore(value: 0)
    let target = root.appendingPathComponent("objects/fixture")
    DispatchQueue.global().async {
        var error: NSError?
        NSFileCoordinator().coordinate(writingItemAt: target, options: .forReplacing, error: &error) { _ in
            entered.signal(); _ = release.wait(timeout: .now() + 5)
        }
    }
    try check(entered.wait(timeout: .now() + 2) == .success, "Competing writer entered")
    DispatchQueue.global().async {
        defer { completed.signal() }
        _ = try? coordinated(root, binding: CloudBinding(bookmark: "", account: "", identity: io.identity), path: "objects/fixture", write: false) { try $0.read("objects/fixture", max: 100) }
    }
    let blocked = completed.wait(timeout: .now() + 0.1) == .timedOut
    release.signal()
    try check(blocked, "Child read waits for coordinated child writer")
    try check(completed.wait(timeout: .now() + 2) == .success, "Child read resumes after writer")
    try check(try io.listCommits().isEmpty, "Empty bounded discovery")
    try check(try observe(root).state == "unsupported-folder", "Ordinary folders are never iCloud")
}
