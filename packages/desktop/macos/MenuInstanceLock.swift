import Foundation
import Darwin

// Darwin also exports a struct named flock; bind the C function explicitly.
@_silgen_name("flock")
private func osFileLock(_ descriptor: Int32, _ operation: Int32) -> Int32

/// Holds an OS lock for the menu app's lifetime. A stale file never blocks a new launch.
final class MenuInstanceLock {
    private let descriptor: Int32
    init?(url: URL) {
        do { try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true) }
        catch { return nil }
        let opened = Darwin.open(url.path, O_CREAT | O_RDWR | O_CLOEXEC, S_IRUSR | S_IWUSR)
        guard opened >= 0 else { return nil }
        guard osFileLock(opened, LOCK_EX | LOCK_NB) == 0 else { Darwin.close(opened); return nil }
        descriptor = opened
    }
    deinit { _ = osFileLock(descriptor, LOCK_UN); Darwin.close(descriptor) }
}

func menuInstanceLockSelfTests() {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("heed-lock-test-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: root) }
    let url = root.appendingPathComponent("menu.lock")
    var first = MenuInstanceLock(url: url)
    precondition(first != nil, "The first instance must acquire the lock")
    precondition(MenuInstanceLock(url: url) == nil, "A second instance must not acquire the live lock")
    first = nil
    let replacement = MenuInstanceLock(url: url)
    precondition(replacement != nil, "A closed instance must release the lock even while its file remains")
    withExtendedLifetime(replacement) {}
}
