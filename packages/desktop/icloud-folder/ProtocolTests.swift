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
    try check(try io.listCommits().isEmpty, "Empty bounded discovery")
    try check(try observe(root).state == "unsupported-folder", "Ordinary folders are never iCloud")
}
