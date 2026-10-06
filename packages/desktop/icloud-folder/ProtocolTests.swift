import Foundation
final class CoordinatedFixtureResult { var data: Data?; let lock = NSLock() }
func protocolTests() throws {
    try remoteDeletionTests(); try admissionRecoveryTests()
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
    var secondWriterBlocked = false
    try io.write("objects/fixture", bytes: data.count, digest: digest(data), afterPublication: {
        // This is the vulnerable interval after rename but before first-writer cleanup.
        let process = Process(); process.executableURL = URL(fileURLWithPath: "/usr/bin/python3")
        process.arguments = ["-c", "import fcntl, os, sys\nf=open(sys.argv[1], 'a')\ntry: fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)\nexcept BlockingIOError: sys.exit(0)\nsys.exit(1)", root.appendingPathComponent("objects/.heed-synthetic-test-\(digest(data)).lock").path]
        try process.run(); process.waitUntilExit(); secondWriterBlocked = process.terminationStatus == 0
    }, input: { data.prefix($0) })
    try check(secondWriterBlocked, "Second-process writer remains excluded after rename until cleanup")
        // A real coordinated child writer must block our actual child reader, unlike an ordinary root read.
    let entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0), completed = DispatchSemaphore(value: 0)
    let target = root.appendingPathComponent("objects/fixture"), readResult = CoordinatedFixtureResult()
    DispatchQueue.global().async {
        var error: NSError?
        NSFileCoordinator().coordinate(writingItemAt: target, options: .forReplacing, error: &error) { _ in
            entered.signal(); _ = release.wait(timeout: .now() + 5)
        }
    }
    try check(entered.wait(timeout: .now() + 2) == .success, "Competing writer entered")
    DispatchQueue.global().async {
        defer { completed.signal() }
        let data = try? coordinated(root, binding: CloudBinding(bookmark: "", account: "", identity: io.identity), path: "objects/fixture", write: false) { try $0.read("objects/fixture", max: 100) }
        readResult.lock.lock(); readResult.data = data; readResult.lock.unlock()
    }
    let blocked = completed.wait(timeout: .now() + 0.1) == .timedOut
    release.signal()
    try check(blocked, "Child read waits for coordinated child writer")
    try check(completed.wait(timeout: .now() + 2) == .success, "Child read resumes after writer")
    readResult.lock.lock(); let coordinatedData = readResult.data; readResult.lock.unlock()
    try check(coordinatedData == data, "Coordinated child read returns intact fixture")
    try check(try io.listCommits().isEmpty, "Empty bounded discovery")
    let headerRoot = FileManager.default.temporaryDirectory.appendingPathComponent("heed-icloud-header-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: headerRoot, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: headerRoot) }
    let headerFiles = try ScopedFiles(root: headerRoot), destination = UUID().uuidString
    let staged = headerRoot.appendingPathComponent(".heed-library-create.pending")
    try Data("unknown personal content".utf8).write(to: staged)
    try rejects { _ = try createHeader(headerFiles, id: destination) }
    try check(try Data(contentsOf: staged) == Data("unknown personal content".utf8), "Unknown descriptor staging stays untouched")
    let descriptor: [String: Any] = ["format": "heed-portable-library", "schemaVersion": 1, "destinationId": destination]
    try JSONSerialization.data(withJSONObject: descriptor).write(to: staged)
    let restored = try createHeader(headerFiles, id: destination)
    try check(restored["destinationId"] as? String == destination, "Known interrupted descriptor recovers")
    try rejects { _ = try createHeader(headerFiles, id: UUID().uuidString) }
    try check(try header(headerFiles)?["destinationId"] as? String == destination, "Existing destination identity remains immutable")
    try check(try observe(root).state == "unsupported-folder", "Ordinary folders are never iCloud")
}
func admissionRecoveryTests() throws {
    let base=FileManager.default.temporaryDirectory.appendingPathComponent("heed-admission-\(UUID().uuidString)"), root=base.appendingPathComponent("remote"), privateRoot=base.appendingPathComponent("private")
    try FileManager.default.createDirectory(at:root,withIntermediateDirectories:true);try FileManager.default.createDirectory(at:privateRoot,withIntermediateDirectories:true);defer {try? FileManager.default.removeItem(at:base)}
    let files=try ScopedFiles(root:root),path="meetings/\(UUID().uuidString)/revisions/\(UUID().uuidString)/manifest.json",data=Data("Synthetic original manifest".utf8)
    func receipt(_ generation:String="original") throws -> CloudAdmission {try CloudAdmission(privateRoot:privateRoot.path,generation:generation,remoteIdentity:files.identity,path:path,bytes:data.count,hash:digest(data))}
    func write(_ receipt:CloudAdmission,after:() throws -> Void = {}) throws {var offset=0;try files.write(path,bytes:data.count,digest:digest(data),stagingId:"original",exclusive:true,existingAdmission:receipt.matches,beforePublication:receipt.prepare,afterPublication:after){count in defer {offset+=count};return data.subdata(in:offset..<offset+count)}}
    var prepared=false
    let earlyPath="meetings/\(UUID().uuidString)/revisions/\(UUID().uuidString)/manifest.json",earlyReceipt=try CloudAdmission(privateRoot:privateRoot.path,generation:"original",remoteIdentity:files.identity,path:earlyPath,bytes:data.count,hash:digest(data));var earlyOffset=0
    try files.write(earlyPath,bytes:data.count,digest:digest(data),stagingId:"early",exclusive:true,existingAdmission:earlyReceipt.matches,beforePublication:{fd in try earlyReceipt.prepare(fd);prepared=true}){count in guard prepared else {throw CloudFailure("Receipt must be durable before the first input chunk")};defer {earlyOffset+=count};return data.subdata(in:earlyOffset..<earlyOffset+count)}
    var refused=false
    do {var offset=0;let original=try receipt();try files.write(path,bytes:data.count,digest:digest(data),stagingId:"original",exclusive:true,existingAdmission:original.matches,beforePublication:{fd in try original.prepare(fd);throw CloudFailure("Interrupted before canonical rename")}){count in defer {offset+=count};return data.subdata(in:offset..<offset+count)}}catch {refused=true}
    guard refused,!FileManager.default.fileExists(atPath:root.appendingPathComponent(path).path) else {throw CloudFailure("Pre-rename interruption must preserve only original staging")}
    try write(receipt())
    let unknownPath="meetings/\(UUID().uuidString)/revisions/\(UUID().uuidString)/manifest.json";try files.ensureParents(unknownPath)
    let unknown=root.appendingPathComponent(unknownPath).deletingLastPathComponent().appendingPathComponent(".heed-unknown-\(digest(data)).pending"),unknownBytes=Data("Unproved staging bytes".utf8);try unknownBytes.write(to:unknown)
    refused=false;do {var offset=0;try files.write(unknownPath,bytes:data.count,digest:digest(data),stagingId:"unknown",exclusive:true){count in defer {offset+=count};return data.subdata(in:offset..<offset+count)}}catch {refused=true}
    guard refused,try Data(contentsOf:unknown)==unknownBytes else {throw CloudFailure("Unknown staging inode must be preserved before truncation")}
    refused=false;do {try write(receipt(),after:{throw CloudFailure("Lost acknowledgment")})}catch {refused=true};guard refused else {throw CloudFailure("Interruption must be observed")}
    try write(receipt());guard try files.read(path,max:1000)==data else {throw CloudFailure("Original admitted inode must recover")}
    refused=false;do {try write(receipt("changed"))}catch {refused=true};guard refused else {throw CloudFailure("New generation cannot adopt matching bytes")}
    let copiedRoot=base.appendingPathComponent("copied-private");try FileManager.default.copyItem(at:privateRoot,to:copiedRoot)
    refused=false;do {let copied=try CloudAdmission(privateRoot:copiedRoot.path,generation:"original",remoteIdentity:files.identity,path:path,bytes:data.count,hash:digest(data));try write(copied)}catch {refused=true};guard refused else {throw CloudFailure("Copied private receipt cannot grant admission authority")}
    let target=root.appendingPathComponent(path);try FileManager.default.removeItem(at:target);try data.write(to:target)
    refused=false;do {try write(receipt())}catch {refused=true};guard refused else {throw CloudFailure("Replicated equal bytes with a new inode must not recover")}
}
