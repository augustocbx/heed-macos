import Foundation
import CryptoKit
import Darwin

struct CloudFailure: Error { let message: String; init(_ message: String) { self.message = message } }
func digest(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
func artifactPath(_ path: String) throws -> [String] {
    let parts = path.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
    guard path.utf8.count <= 512, !path.contains("\\"), !path.contains("%"), parts.count >= 2,
          ["meetings", "objects", "commits"].contains(parts[0]),
          parts.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." && $0.range(of: "^[A-Za-z0-9_.-]+$", options: .regularExpression) != nil }) else { throw CloudFailure("Invalid artifact path") }
    return parts
}
func descriptorIdentity(_ fd: Int32) throws -> String {
    var info = stat(); guard fstat(fd, &info) == 0 else { throw CloudFailure("Folder unavailable") }
    return "\(info.st_dev):\(info.st_ino)"
}
/** Descriptor-relative access rejects symlinks and retains the selected root throughout an operation. */
final class ScopedFiles {
    let root: URL; let fd: Int32; let identity: String
    init(root: URL, expected: String? = nil) throws {
        self.root = root
        fd = open(root.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else { throw CloudFailure("Selected folder unavailable") }
        do { identity = try descriptorIdentity(fd); if let expected = expected, identity != expected { throw CloudFailure("Selected folder identity changed") } }
        catch { close(fd); throw error }
    }
    deinit { close(fd) }
    private func parent(_ parts: [String], create: Bool) throws -> Int32 {
        var current = dup(fd); guard current >= 0 else { throw CloudFailure("Folder unavailable") }
        do {
            for part in parts.dropLast() {
                var next = openat(current, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
                if next < 0 && errno == ENOENT && create {
                    guard mkdirat(current, part, 0o700) == 0 || errno == EEXIST else { throw CloudFailure("Cannot create artifact folder") }
                    next = openat(current, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
                }
                guard next >= 0 else { throw CloudFailure("Artifact path unavailable") }
                close(current); current = next
            }
            return current
        } catch { close(current); throw error }
    }
    func stream(_ path: String, max: Int, emit: (Data) throws -> Void) throws {
        let parts = try artifactPath(path), parent = try self.parent(parts, create: false); defer { close(parent) }
        let file = openat(parent, parts.last!, O_RDONLY | O_NOFOLLOW | O_CLOEXEC); guard file >= 0 else { throw CloudFailure("Artifact unavailable or not hydrated") }; defer { close(file) }
        var info = stat(); guard fstat(file, &info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_size >= 0, info.st_size <= max else { throw CloudFailure("Artifact exceeds declared size") }
        var received = 0, buffer = [UInt8](repeating: 0, count: 65536)
        while true { let count = Darwin.read(file, &buffer, buffer.count); guard count >= 0 else { throw CloudFailure("Artifact read failed") }; if count == 0 { break }; received += count; guard received <= max else { throw CloudFailure("Artifact grew during read") }; try emit(Data(buffer.prefix(count))) }
        guard received == info.st_size else { throw CloudFailure("Artifact changed during read") }
    }
    func read(_ path: String, max: Int) throws -> Data { var data = Data(); try stream(path, max: max) { data.append($0) }; return data }
    func write(_ path: String, bytes: Int, digest expected: String, stagingId: String = "synthetic-test", input: (Int) throws -> Data) throws {
        let parts = try artifactPath(path), parent = try self.parent(parts, create: true); defer { close(parent) }
        guard bytes >= 0, bytes <= 8_000_000_000_000, expected.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else { throw CloudFailure("Invalid object bounds") }
        guard stagingId.range(of: "^[A-Za-z0-9-]{1,64}$", options: .regularExpression) != nil else { throw CloudFailure("Invalid staging owner") }
        let temporary = ".heed-\(stagingId)-\(expected).pending"
        let file = openat(parent, temporary, O_WRONLY | O_CREAT | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard file >= 0 else { throw CloudFailure("Cannot stage artifact") }
        var info = stat()
        guard fstat(file, &info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_nlink == 1,
              flock(file, LOCK_EX | LOCK_NB) == 0, ftruncate(file, 0) == 0 else { close(file); throw CloudFailure("Artifact staging busy or unsafe") }
        defer { close(file); unlinkat(parent, temporary, 0) }
        var hash = SHA256(), received = 0
        while received < bytes {
            let chunk = try input(min(65536, bytes - received)); guard !chunk.isEmpty, chunk.count <= bytes - received else { throw CloudFailure("Incomplete object") }
            hash.update(data: chunk); received += chunk.count
            try chunk.withUnsafeBytes { pointer in var offset = 0; while offset < chunk.count { let count = Darwin.write(file, pointer.baseAddress!.advanced(by: offset), chunk.count - offset); guard count > 0 else { throw CloudFailure("Artifact write failed") }; offset += count } }
        }
        guard hash.finalize().map({ String(format: "%02x", $0) }).joined() == expected, fsync(file) == 0 else { throw CloudFailure("Artifact integrity failed") }
        if renameatx_np(parent, temporary, parent, parts.last!, UInt32(RENAME_EXCL)) != 0 {
            guard errno == EEXIST else { throw CloudFailure("Artifact publication failed") }
            var existing = SHA256(), length = 0
            try stream(path, max: bytes) { chunk in length += chunk.count; existing.update(data: chunk) }
            guard length == bytes, existing.finalize().map({ String(format: "%02x", $0) }).joined() == expected else { throw CloudFailure("Immutable artifact conflict") }
        }
        guard fsync(parent) == 0 else { throw CloudFailure("Artifact directory synchronization failed") }
    }
    func listCommits() throws -> [String] {
        var result = [String](), visited = 0
        func walk(_ directory: Int32, _ prefix: String, _ depth: Int) throws {
            guard depth <= 2, let entries = fdopendir(dup(directory)) else { throw CloudFailure("Discovery unavailable") }; defer { closedir(entries) }
            while let item = readdir(entries) {
                let name = withUnsafePointer(to: item.pointee.d_name) { $0.withMemoryRebound(to: CChar.self, capacity: 1024) { String(cString: $0) } }
                if name == "." || name == ".." || name.hasPrefix(".heed-") { continue }
                visited += 1; guard visited <= 20000 else { throw CloudFailure("Library discovery limit exceeded") }
                var info = stat(); guard fstatat(directory, name, &info, AT_SYMLINK_NOFOLLOW) == 0 else { throw CloudFailure("Incomplete discovery") }
                if depth == 0 && info.st_mode & S_IFMT == S_IFDIR { let next = openat(directory, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC); guard next >= 0 else { throw CloudFailure("Discovery changed") }; defer { close(next) }; try walk(next, "commits/\(name)", 1) }
                else if depth == 1 && info.st_mode & S_IFMT == S_IFREG && name.hasSuffix(".json") { result.append("\(prefix)/\(name)"); guard result.count <= 10000 else { throw CloudFailure("Commit limit exceeded") } }
                else { throw CloudFailure("Unsupported commit entry") }
            }
        }
        let commits = openat(fd, "commits", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        if commits < 0 && errno == ENOENT { return [] }; guard commits >= 0 else { throw CloudFailure("Commit folder unavailable") }; defer { close(commits) }
        try walk(commits, "commits", 0); return result.sorted()
    }
}
