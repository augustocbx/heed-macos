import Foundation
import CryptoKit
import Darwin

enum CloudIssue: String, Encodable { case unavailable, accountUnavailable = "account-unavailable", accountChanged = "account-changed", bookmarkStale = "bookmark-stale", folderUnavailable = "folder-unavailable", permissionDenied = "permission-denied", hydrationPending = "hydration-pending" }
struct CloudFailure: Error { let message: String; let issue: CloudIssue; init(_ message: String, issue: CloudIssue = .unavailable) { self.message = message; self.issue = issue } }
func cloudIssue(_ error: Error) -> CloudIssue {
    if let failure = error as? CloudFailure { return failure.issue }
    let value = error as NSError
    if value.domain == NSCocoaErrorDomain && [NSFileReadNoPermissionError, NSFileWriteNoPermissionError].contains(value.code) { return .permissionDenied }
    if value.domain == NSPOSIXErrorDomain && [Int(EACCES), Int(EPERM)].contains(value.code) { return .permissionDenied }
    return .unavailable
}
struct CloudFailureEnvelope: Encodable { let `protocol` = "heed-icloud-failure"; let version = 1; let code: CloudIssue }
func cloudFailureEnvelope(_ error: Error) throws -> Data { try JSONEncoder().encode(CloudFailureEnvelope(code: cloudIssue(error))) }
func digest(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
func artifactPath(_ path: String) throws -> [String] {
    let parts = path.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
    guard path.utf8.count <= 512, !path.contains("\\"), !path.contains("%"), parts.count >= 2,
          ["meetings", "objects", "commits", "control"].contains(parts[0]),
          parts.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." && $0.range(of: "^[A-Za-z0-9_.-]+$", options: .regularExpression) != nil }) else { throw CloudFailure("Invalid artifact path") }
    if parts[0] == "control" { guard parts.count == 3, ["deletions", "pending"].contains(parts[1]), parts[2].hasSuffix(".json"), UUID(uuidString: String(parts[2].dropLast(5))) != nil else { throw CloudFailure("Invalid control path") } }
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
        guard fd >= 0 else { throw CloudFailure("Selected folder unavailable", issue: [EACCES, EPERM].contains(errno) ? .permissionDenied : errno == ENOENT ? .folderUnavailable : .unavailable) }
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
    func ensureParents(_ path: String) throws { let parent = try self.parent(artifactPath(path), create: true); close(parent) }
    func stream(_ path: String, max: Int, validate: () throws -> Void = {}, emit: (Data) throws -> Void) throws {
        let parts = try artifactPath(path), parent = try self.parent(parts, create: false); defer { close(parent) }
        let file = openat(parent, parts.last!, O_RDONLY | O_NOFOLLOW | O_CLOEXEC); guard file >= 0 else { throw CloudFailure("Artifact unavailable or not hydrated") }; defer { close(file) }
        var info = stat(); guard fstat(file, &info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_size >= 0, info.st_size <= max else { throw CloudFailure("Artifact exceeds declared size") }
        var received = 0, buffer = [UInt8](repeating: 0, count: 65536)
        while true { try validate(); let count = Darwin.read(file, &buffer, buffer.count); guard count >= 0 else { throw CloudFailure("Artifact read failed") }; if count == 0 { break }; received += count; guard received <= max else { throw CloudFailure("Artifact grew during read") }; try emit(Data(buffer.prefix(count))) }
        try validate(); guard received == info.st_size else { throw CloudFailure("Artifact changed during read") }
    }
    func read(_ path: String, max: Int) throws -> Data { var data = Data(); try stream(path, max: max) { data.append($0) }; return data }
    func write(_ path: String, bytes: Int, digest expected: String, stagingId: String = "synthetic-test", exclusive: Bool = false, existingAdmission: ((Int32) throws -> Bool)? = nil, beforePublication: (Int32) throws -> Void = {_ in}, afterPublication: () throws -> Void = {}, validate: () throws -> Void = {}, input: (Int) throws -> Data) throws {
        let parts = try artifactPath(path), parent = try self.parent(parts, create: true); defer { close(parent) }
        guard bytes >= 0, bytes <= 8_000_000_000_000, expected.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else { throw CloudFailure("Invalid object bounds") }
        guard stagingId.range(of: "^[A-Za-z0-9-]{1,64}$", options: .regularExpression) != nil else { throw CloudFailure("Invalid staging owner") }
        let temporary = ".heed-\(stagingId)-\(expected).pending"
        let lockName = ".heed-\(stagingId)-\(expected).lock"
        let lock = openat(parent, lockName, O_WRONLY | O_CREAT | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard lock >= 0 else { throw CloudFailure("Cannot lock artifact") }
        var lockInfo = stat()
        guard fstat(lock, &lockInfo) == 0, lockInfo.st_mode & S_IFMT == S_IFREG, lockInfo.st_nlink == 1,
              flock(lock, LOCK_EX | LOCK_NB) == 0 else { close(lock); throw CloudFailure("Artifact writer busy") }
        defer { close(lock) } // The stable lock name remains; removing it could split ownership across inodes.
        if exclusive, let original = existingAdmission {
            let existing = openat(parent, parts.last!, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
            if existing >= 0 {
                defer {close(existing)}
                guard try original(existing) else {throw CloudFailure("Canonical admission is ambiguous or fenced")}
                var retained = stat();guard fstat(existing,&retained)==0,retained.st_size==bytes else {throw CloudFailure("Original admission changed")}
                var checksum=SHA256(),length=0,buffer=[UInt8](repeating:0,count:65536)
                while true {try validate();let count=Darwin.read(existing,&buffer,buffer.count);guard count>=0 else {throw CloudFailure("Original admission read failed")};if count==0 {break};length+=count;guard length<=bytes else {throw CloudFailure("Original admission grew")};checksum.update(data:Data(buffer.prefix(count)))}
                guard length==bytes,checksum.finalize().map({String(format:"%02x",$0)}).joined()==expected else {throw CloudFailure("Original admission integrity changed")}
                var current=stat();guard fstatat(parent,parts.last!,&current,AT_SYMLINK_NOFOLLOW)==0,current.st_ino==retained.st_ino,current.st_dev==retained.st_dev else {throw CloudFailure("Original admission namespace changed")}
                try validate();try afterPublication();return
            } else if errno != ENOENT {throw CloudFailure("Canonical admission unavailable")}
        }
        var file = openat(parent, temporary, O_WRONLY | O_CREAT | O_NOFOLLOW | O_CLOEXEC | (exclusive ? O_EXCL : 0), 0o600)
        var recovering = false
        if exclusive && file < 0 && errno == EEXIST {file=openat(parent,temporary,O_WRONLY|O_NOFOLLOW|O_CLOEXEC);recovering=true}
        guard file >= 0 else { throw CloudFailure("Cannot stage artifact") }
        var info = stat()
        do {
            guard fstat(file, &info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_nlink == 1,flock(file, LOCK_EX | LOCK_NB) == 0 else {throw CloudFailure("Artifact staging busy or unsafe")}
            if recovering {guard let original=existingAdmission,try original(file) else {throw CloudFailure("Unknown canonical staging must be preserved")}}
            try beforePublication(file)
            guard ftruncate(file,0)==0 else {throw CloudFailure("Artifact staging unavailable")}
        }catch {close(file);throw error}
        defer {if !exclusive || ((try? existingAdmission?(file)) ?? false) != true {unlinkat(parent,temporary,0)};close(file)}
        var hash = SHA256(), received = 0
        while received < bytes {
            try validate()
            let chunk = try input(min(65536, bytes - received)); guard !chunk.isEmpty, chunk.count <= bytes - received else { throw CloudFailure("Incomplete object") }
            hash.update(data: chunk); received += chunk.count
            try chunk.withUnsafeBytes { pointer in var offset = 0; while offset < chunk.count { let count = Darwin.write(file, pointer.baseAddress!.advanced(by: offset), chunk.count - offset); guard count > 0 else { throw CloudFailure("Artifact write failed") }; offset += count } }
        }
        try validate()
        guard hash.finalize().map({ String(format: "%02x", $0) }).joined() == expected, fsync(file) == 0 else { throw CloudFailure("Artifact integrity failed") }
        try validate()
        if renameatx_np(parent, temporary, parent, parts.last!, UInt32(RENAME_EXCL)) != 0 {
            guard errno == EEXIST, !exclusive else { throw CloudFailure("Canonical admission is ambiguous or fenced") }
            var existing = SHA256(), length = 0
            try stream(path, max: bytes) { chunk in length += chunk.count; existing.update(data: chunk) }
            guard length == bytes, existing.finalize().map({ String(format: "%02x", $0) }).joined() == expected else { throw CloudFailure("Immutable artifact conflict") }
        }
        try afterPublication()
        guard fsync(parent) == 0 else { throw CloudFailure("Artifact directory synchronization failed") }
    }
    /** Only exact metadata authorized by a durable deletion intent is removable. */
    func removeMetadata(_ path: String, bytes: Int, hash: String, job: String, quarantineOnly:Bool=false, validate: () throws -> Void = {}) throws -> String {
        let parts = try artifactPath(path)
        guard ["meetings", "commits", "control"].contains(parts[0]), UUID(uuidString: job) != nil,
              bytes > 0, bytes <= 16_000_000, hash.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else { throw CloudFailure("Unsupported physical target") }
        let parent = try self.parent(parts, create: false); defer { close(parent) }
        let quarantine = ".heed-delete-\(job)-\(hash).quarantine"
        func verified(_ name: String) throws -> stat? {
            let file = openat(parent, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
            if file < 0 && errno == ENOENT { return nil }
            guard file >= 0 else { throw CloudFailure("Unsafe deletion target") }; defer { close(file) }
            var info = stat(); guard fstat(file, &info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_nlink == 1, info.st_size == bytes else { throw CloudFailure("Deletion target changed") }
            var sha = SHA256(), size = 0, buffer = [UInt8](repeating: 0, count: 65536)
            while true { try validate(); let count = Darwin.read(file, &buffer, buffer.count); guard count >= 0 else { throw CloudFailure("Deletion read failed") }; if count == 0 { break }; size += count; guard size <= bytes else { throw CloudFailure("Deletion target grew") }; sha.update(data: Data(buffer.prefix(count))) }
            guard size == bytes, sha.finalize().map({String(format: "%02x", $0)}).joined() == hash else { throw CloudFailure("Deletion integrity changed") }
            return info
        }
        try validate()
        if let quarantined = try verified(quarantine) {
            var current = stat(); guard fstatat(parent, quarantine, &current, AT_SYMLINK_NOFOLLOW) == 0, current.st_ino == quarantined.st_ino, current.st_dev == quarantined.st_dev else { throw CloudFailure("Quarantine changed") }
            try validate(); guard unlinkat(parent, quarantine, 0) == 0, fsync(parent) == 0 else { throw CloudFailure("Quarantine removal failed") }; return "removed"
        }
        if quarantineOnly {return "already-removed"}
        guard let original = try verified(parts.last!) else { return "already-removed" }
        try validate()
        guard renameatx_np(parent, parts.last!, parent, quarantine, UInt32(RENAME_EXCL)) == 0, fsync(parent) == 0 else { throw CloudFailure("Deletion quarantine changed") }
        let retained = try verified(quarantine)
        guard let retained = retained, retained.st_ino == original.st_ino, retained.st_dev == original.st_dev else { throw CloudFailure("Deletion target substituted; preserve quarantine") }
        try validate(); guard unlinkat(parent, quarantine, 0) == 0, fsync(parent) == 0 else { throw CloudFailure("Metadata removal failed") }; return "removed"
    }
    func listControls(_ category: String) throws -> [String] {
        guard ["deletions", "pending"].contains(category) else { throw CloudFailure("Invalid control inventory") }
        let control = openat(fd, "control", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        if control < 0 && errno == ENOENT { return [] }; guard control >= 0 else { throw CloudFailure("Control folder unavailable") }; defer { close(control) }
        let directory = openat(control, category, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        if directory < 0 && errno == ENOENT { return [] }; guard directory >= 0, let entries = fdopendir(dup(directory)) else { if directory >= 0 { close(directory) }; throw CloudFailure("Control discovery unavailable") }; defer { closedir(entries); close(directory) }
        var paths = [String]()
        while let item = readdir(entries) {
            let name = withUnsafePointer(to:item.pointee.d_name) { $0.withMemoryRebound(to:CChar.self,capacity:1024) { String(cString:$0) } }
            if name == "." || name == ".." || name.hasPrefix(".heed-") { continue }
            var info = stat(); guard fstatat(directory,name,&info,AT_SYMLINK_NOFOLLOW) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_nlink == 1, name.hasSuffix(".json"), UUID(uuidString:String(name.dropLast(5))) != nil else { throw CloudFailure("Unknown control entry") }
            paths.append("control/\(category)/\(name)"); guard paths.count <= 10000 else { throw CloudFailure("Control discovery limit") }
        }
        return paths.sorted()
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
