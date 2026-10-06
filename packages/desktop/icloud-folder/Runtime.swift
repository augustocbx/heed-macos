import Foundation
import AppKit

func accountToken() throws -> Data {
    guard let token = FileManager.default.ubiquityIdentityToken else { throw CloudFailure("iCloud account unavailable") }
    return try NSKeyedArchiver.archivedData(withRootObject: token, requiringSecureCoding: false)
}
func sameAccount(_ archived: Data) throws -> Bool {
    guard let current = FileManager.default.ubiquityIdentityToken as? NSObject,
          let previous = try NSKeyedUnarchiver.unarchiveTopLevelObjectWithData(archived) as? NSObject else { return false }
    return current.isEqual(previous)
}
struct CloudBinding: Codable {
    let bookmark: String
    let account: String
    let identity: String
}
func selectedBinding() throws -> CloudBinding {
    let token = try accountToken()
    let panel = NSOpenPanel(); panel.canChooseDirectories = true; panel.canChooseFiles = false
    panel.allowsMultipleSelection = false; panel.canCreateDirectories = true
    panel.title = "Choose an iCloud Drive library folder"; panel.prompt = "Choose"
    NSApplication.shared.setActivationPolicy(.accessory); NSApplication.shared.activate(ignoringOtherApps: true)
    guard panel.runModal() == .OK, let selected = panel.url else { throw CloudFailure("Folder selection cancelled") }
    let root = selected.resolvingSymlinksInPath().standardizedFileURL
    let access = root.startAccessingSecurityScopedResource(); defer { if access { root.stopAccessingSecurityScopedResource() } }
    guard try observe(root).ubiquitous else { throw CloudFailure("Selected folder is not available as iCloud Drive") }
    guard try sameAccount(token) else { throw CloudFailure("iCloud account changed during selection") }
    let files = try ScopedFiles(root: root)
    let bookmark = try root.bookmarkData(options: .withSecurityScope, includingResourceValuesForKeys: nil, relativeTo: nil)
    return CloudBinding(bookmark: bookmark.base64EncodedString(), account: token.base64EncodedString(), identity: files.identity)
}
func withBinding<T>(_ binding: CloudBinding, operation: (URL) throws -> T) throws -> T {
    guard binding.bookmark.utf8.count <= 65536, binding.account.utf8.count <= 65536,
          let bookmark = Data(base64Encoded: binding.bookmark), let account = Data(base64Encoded: binding.account),
          try sameAccount(account) else { throw CloudFailure("iCloud account unavailable or changed") }
    var stale = false
    let root = try URL(resolvingBookmarkData: bookmark, options: [.withSecurityScope, .withoutUI], relativeTo: nil, bookmarkDataIsStale: &stale)
    guard !stale else { throw CloudFailure("Folder bookmark needs renewed access") }
    let access = root.startAccessingSecurityScopedResource(); defer { if access { root.stopAccessingSecurityScopedResource() } }
    let files = try ScopedFiles(root: root, expected: binding.identity)
    guard files.identity == binding.identity, try observe(root).ubiquitous else { throw CloudFailure("Selected iCloud folder unavailable") }
    return try operation(root)
}
func checkpoint(root: URL, binding: CloudBinding) throws {
    guard let token = Data(base64Encoded: binding.account), try sameAccount(token),
          try ScopedFiles(root: root, expected: binding.identity).identity == binding.identity else { throw CloudFailure("iCloud account or selected folder changed") }
}
func coordinated<T>(_ root: URL, binding: CloudBinding, path: String = "heed-library.json", temporary: String? = nil, write: Bool, operation: @escaping (ScopedFiles) throws -> T) throws -> T {
    var coordinatorError: NSError?, result: Result<T, Error>?
    let target = root.appendingPathComponent(path).standardizedFileURL
    guard target.resolvingSymlinksInPath().path == target.path else { throw CloudFailure("Unsafe coordinated path") }
    let accessor: (URL) -> Void = { url in result = Result {
        guard url.standardizedFileURL.path == target.path else { throw CloudFailure("Coordinated file moved outside selected scope") }
        return try operation(ScopedFiles(root: root, expected: binding.identity))
    } }
    // Upload observations happen after this accessor has returned, allowing provider work to proceed.
    let coordinator = NSFileCoordinator()
    if write, let temporary = temporary {
        let stage = root.appendingPathComponent(temporary).standardizedFileURL
        guard stage.resolvingSymlinksInPath().path == stage.path else { throw CloudFailure("Unsafe staging path") }
        coordinator.coordinate(writingItemAt: target, options: .forReplacing, writingItemAt: stage, options: .forReplacing, error: &coordinatorError) { url, temp in
            guard temp.standardizedFileURL.path == stage.path else { result = .failure(CloudFailure("Staging moved outside selected scope")); return }
            accessor(url)
        }
    } else if write { coordinator.coordinate(writingItemAt: target, options: .forReplacing, error: &coordinatorError, byAccessor: accessor) }
    else { coordinator.coordinate(readingItemAt: target, options: [], error: &coordinatorError, byAccessor: accessor) }
    if let error = coordinatorError { throw error }
    guard let result = result else { throw CloudFailure("File coordination unavailable") }
    return try result.get()
}
func header(_ files: ScopedFiles) throws -> [String: Any]? {
    let fd = openat(files.fd, "heed-library.json", O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
    if fd < 0 && errno == ENOENT { return nil }; guard fd >= 0 else { throw CloudFailure("Library descriptor unavailable") }; defer { close(fd) }
    var info = stat(); guard fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_size > 0, info.st_size <= 16384 else { throw CloudFailure("Invalid library descriptor") }
    var data = Data(), bytes = [UInt8](repeating: 0, count: 16385)
    let count = Darwin.read(fd, &bytes, bytes.count); guard count == info.st_size else { throw CloudFailure("Library descriptor changed") }; data.append(contentsOf: bytes.prefix(count))
    guard let value = try JSONSerialization.jsonObject(with: data) as? [String: Any], value.count == 3,
          value["format"] as? String == "heed-portable-library", value["schemaVersion"] as? Int == 1,
          let id = value["destinationId"] as? String, UUID(uuidString: id) != nil else { throw CloudFailure("Unsupported library descriptor") }
    return value
}
func createHeader(_ files: ScopedFiles, id: String, validate: () throws -> Void = {}) throws -> [String: Any] {
    guard UUID(uuidString: id) != nil else { throw CloudFailure("Invalid destination identity") }
    if let existing = try header(files) { guard existing["destinationId"] as? String == id else { throw CloudFailure("Destination identity changed") }; return existing }
    guard let entries = fdopendir(dup(files.fd)) else { throw CloudFailure("Folder unavailable") }; defer { closedir(entries) }
    while let item = readdir(entries) {
        let name = withUnsafePointer(to: item.pointee.d_name) { $0.withMemoryRebound(to: CChar.self, capacity: 1024) { String(cString: $0) } }
        guard [".", "..", ".DS_Store"].contains(name) else { throw CloudFailure("Create a new empty library folder") }
    }
    let value: [String: Any] = ["format": "heed-portable-library", "schemaVersion": 1, "destinationId": id]
    let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    let temporary = ".heed-header-\(id).pending", fd = openat(files.fd, temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
    guard fd >= 0 else { throw CloudFailure("Cannot create library descriptor") }; defer { unlinkat(files.fd, temporary, 0); close(fd) }
    try data.withUnsafeBytes { buffer in guard Darwin.write(fd, buffer.baseAddress, buffer.count) == buffer.count, fsync(fd) == 0 else { throw CloudFailure("Library descriptor write failed") } }
    try validate()
    guard renameatx_np(files.fd, temporary, files.fd, "heed-library.json", UInt32(RENAME_EXCL)) == 0, fsync(files.fd) == 0 else { throw CloudFailure("Library descriptor creation changed") }
    return value
}
func requireHeader(_ files: ScopedFiles, destinationId: String?) throws {
    guard let destinationId = destinationId, let value = try header(files), value["destinationId"] as? String == destinationId else { throw CloudFailure("Library identity changed") }
}
struct CloudRequest: Decodable {
    let action: String
    let binding: CloudBinding?
    let path: String?
    let destinationId: String?
    let maxBytes: Int?
    let bytes: Int?
    let sha256: String?
    let stagingId: String?
}
func outputJSON<T: Encodable>(_ value: T) throws { FileHandle.standardOutput.write(try JSONEncoder().encode(value)); FileHandle.standardOutput.write(Data([10])) }
func dictionaryJSON(_ value: Any) throws { FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .fragmentsAllowed])); FileHandle.standardOutput.write(Data([10])) }
func readRequest() throws -> CloudRequest {
    var header = Data()
    while let byte = try FileHandle.standardInput.read(upToCount: 1), !byte.isEmpty {
        if byte[0] == 10 { return try JSONDecoder().decode(CloudRequest.self, from: header) }
        header.append(byte); guard header.count <= 150000 else { throw CloudFailure("Request too large") }
    }
    throw CloudFailure("Incomplete request")
}
func asynchronousObservation(root: URL, target: URL, binding: CloudBinding) throws -> CloudObservation {
    let query = NSMetadataQuery()
    query.searchScopes = [root] // An empty scope would search outside the selected library.
    query.predicate = NSPredicate(format: "%K == %@", NSMetadataItemPathKey, target.path)
    var changed = false, accountChanged = false
    let center = NotificationCenter.default
    let finished = center.addObserver(forName: .NSMetadataQueryDidFinishGathering, object: query, queue: nil) { _ in changed = true }
    let updated = center.addObserver(forName: .NSMetadataQueryDidUpdate, object: query, queue: nil) { _ in changed = true }
    let account = center.addObserver(forName: .NSUbiquityIdentityDidChange, object: nil, queue: nil) { _ in accountChanged = true }
    defer { query.stop(); center.removeObserver(finished); center.removeObserver(updated); center.removeObserver(account) }
    guard query.start() else { throw CloudFailure("Provider observation unavailable") }
    let deadline = Date().addingTimeInterval(1)
    while !changed && !accountChanged && Date() < deadline { _ = RunLoop.current.run(mode: .default, before: min(deadline, Date().addingTimeInterval(0.05))) }
    guard !accountChanged, let token = Data(base64Encoded: binding.account), try sameAccount(token) else { throw CloudFailure("iCloud account changed") }
    return try observe(target)
}
func runtime() throws {
    let request = try readRequest()
    if request.action == "pick" { try outputJSON(selectedBinding()); return }
    guard let binding = request.binding else { throw CloudFailure("Missing folder binding") }
    try withBinding(binding) { root in
        switch request.action {
        case "probe":
            let value = try coordinated(root, binding: binding, write: false) { try header($0) }
            try dictionaryJSON(["header": value as Any? ?? NSNull(), "status": try observe(root).state, "remoteChecksumVerified": false])
        case "create":
            guard let id = request.destinationId else { throw CloudFailure("Missing library identity") }
            let value = try coordinated(root, binding: binding, temporary: ".heed-header-\(id).pending", write: true) { try checkpoint(root: root, binding: binding); return try createHeader($0, id: id, validate: { try checkpoint(root: root, binding: binding) }) }; try dictionaryJSON(value)
        case "list":
            let paths = try coordinated(root, binding: binding, path: "commits", write: false) { files in try requireHeader(files, destinationId: request.destinationId); return try files.listCommits() }; try outputJSON(paths)
        case "read", "write", "status", "hydrate", "watch":
            guard let path = request.path else { throw CloudFailure("Missing artifact path") }; _ = try artifactPath(path)
            if ["status", "hydrate", "watch"].contains(request.action) {
                try coordinated(root, binding: binding, write: false) { files in try requireHeader(files, destinationId: request.destinationId); _ = try artifactPath(path) }
                let target = root.appendingPathComponent(path)
                // Resolve symlinks before a provider request; coordinated descriptor I/O still validates every component.
                guard target.resolvingSymlinksInPath().standardizedFileURL.path == target.standardizedFileURL.path else { throw CloudFailure("Unsafe artifact path") }
                if request.action == "hydrate" { try FileManager.default.startDownloadingUbiquitousItem(at: target) }
                try outputJSON(request.action == "watch" ? asynchronousObservation(root: root, target: target, binding: binding) : observe(target)); return
            }
            if request.action == "read" {
                guard let max = request.maxBytes, max >= 0, max <= 8_000_000_000_000 else { throw CloudFailure("Invalid read bounds") }
                let state = try observe(root.appendingPathComponent(path))
                if state.ubiquitous && ![URLUbiquitousItemDownloadingStatus.current.rawValue, URLUbiquitousItemDownloadingStatus.downloaded.rawValue].contains(state.downloaded ?? "") { throw CloudFailure("Artifact hydration pending") }
                try coordinated(root, binding: binding, path: path, write: false) { files in try requireHeader(files, destinationId: request.destinationId); try files.stream(path, max: max, validate: { try checkpoint(root: root, binding: binding) }) { FileHandle.standardOutput.write($0) } }
            } else {
                guard let bytes = request.bytes, let hash = request.sha256 else { throw CloudFailure("Missing object bounds") }
                guard let owner = request.stagingId, UUID(uuidString: owner) != nil else { throw CloudFailure("Missing staging owner") }
                let parent = Array(try artifactPath(path).dropLast()).joined(separator: "/")
                let temporary = "\(parent)/.heed-\(owner)-\(hash).pending"
                try coordinated(root, binding: binding, path: path, temporary: temporary, write: true) { files in try requireHeader(files, destinationId: request.destinationId); try files.write(path, bytes: bytes, digest: hash, stagingId: owner, validate: { try checkpoint(root: root, binding: binding) }) { try FileHandle.standardInput.read(upToCount: $0) ?? Data() } }; try dictionaryJSON(["localWriteVerified": true, "remoteChecksumVerified": false])
            }
        default: throw CloudFailure("Unsupported folder operation")
        }
    }
}
