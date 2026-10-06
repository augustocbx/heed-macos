import AppKit
import Foundation
import Darwin

struct SmbDesktopCommand: Decodable { let id: String; let action: String; let address: String? }

/// macOS owns mounting, credentials and folder authorization. Heed never asks for a password.
final class SmbFolderAccess {
    private let defaults: UserDefaults
    private var scoped: URL?
    private var started = false
    private var executing: String?
    private var completed: String?
    private let session: URLSession
    private let endpoints = try? ServiceEndpoints.load()
    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 6
        session = ServiceEndpoints.session(configuration: configuration)
    }
    static func address(_ value: String) -> URL? {
        guard value.count <= 2048, !value.contains("@"), !value.contains("\\"),
              value.unicodeScalars.allSatisfy({ !CharacterSet.controlCharacters.contains($0) }),
              let components = URLComponents(string: value), components.scheme == "smb",
              components.user == nil, components.password == nil, components.port == nil,
              components.query == nil, components.fragment == nil, let host = components.host, !host.isEmpty,
              components.path.split(separator: "/").count == 1,
              !components.path.contains(".."), !components.path.contains("@"),
              components.path.unicodeScalars.allSatisfy({ !CharacterSet.controlCharacters.contains($0) }) else { return nil }
        return components.url
    }
    static func isSmbFolder(_ url: URL) -> Bool {
        var info = statfs()
        guard url.withUnsafeFileSystemRepresentation({ path in
            guard let path = path else { return false }
            let descriptor = Darwin.open(path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
            guard descriptor >= 0 else { return false }
            defer { Darwin.close(descriptor) }
            return Darwin.fstatfs(descriptor, &info) == 0
        }) else { return false }
        let type = withUnsafePointer(to: &info.f_fstypename) {
            $0.withMemoryRebound(to: CChar.self, capacity: 16) { String(cString: $0) }
        }
        return type == "smbfs"
    }
    private func retain(_ url: URL) {
        if started { scoped?.stopAccessingSecurityScopedResource() }
        scoped = url
        started = url.startAccessingSecurityScopedResource()
    }
    func restore() {
        guard let data = defaults.data(forKey: "HeedSmbFolderBookmark") else { return }
        var stale = false
        guard let url = try? URL(resolvingBookmarkData: data, options: [.withSecurityScope, .withoutUI], relativeTo: nil, bookmarkDataIsStale: &stale) else { return }
        retain(url)
        if stale, let data = try? url.bookmarkData(options: [.withSecurityScope], includingResourceValuesForKeys: nil, relativeTo: nil) {
            defaults.set(data, forKey: "HeedSmbFolderBookmark")
        }
    }
    func execute(_ command: SmbDesktopCommand, locale: String) {
        guard executing == nil, completed != command.id else { return }
        executing = command.id
        if command.action == "mount" {
            guard let value = command.address, let url = Self.address(value) else { finish(command.id, folder: nil, failed: true); return }
            finish(command.id, folder: nil, failed: !NSWorkspace.shared.open(url))
            return
        }
        guard command.action == "folder" else { finish(command.id, folder: nil, failed: true); return }
        let panel = NSOpenPanel()
        panel.title = MenuLocalization.text("Select mounted SMB share", locale: locale)
        panel.message = MenuLocalization.text("Select a folder on the mounted share. Heed uses a dedicated Heed Library subfolder.", locale: locale)
        panel.prompt = MenuLocalization.text("Select share folder", locale: locale)
        panel.canChooseDirectories = true; panel.canChooseFiles = false
        panel.canCreateDirectories = false; panel.allowsMultipleSelection = false
        NSApp.activate(ignoringOtherApps: true)
        panel.begin { [weak self] response in
            guard let self = self else { return }
            guard response == .OK, let url = panel.url, Self.isSmbFolder(url) else { self.finish(command.id, folder: nil, failed: true); return }
            self.retain(url)
            guard let data = try? url.bookmarkData(options: [.withSecurityScope], includingResourceValuesForKeys: nil, relativeTo: nil) else { self.finish(command.id, folder: nil, failed: true); return }
            self.defaults.set(data, forKey: "HeedSmbFolderBookmark")
            self.finish(command.id, folder: url.resolvingSymlinksInPath().standardizedFileURL.path, failed: false)
        }
    }
    private func finish(_ id: String, folder: String?, failed: Bool) {
        guard let endpoints = endpoints else { executing = nil; return }
        var request = URLRequest(url: endpoints.apiURL("/api/smb"))
        request.httpMethod = "POST"; request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = Self.reportBody(id, folder: folder, failed: failed)
        endpoints.perform(session: session, request: request) { [weak self] _, response, _ in
            DispatchQueue.main.async {
                self?.executing = nil
                if (response as? HTTPURLResponse)?.statusCode == 200 { self?.completed = id }
            }
        }
    }
    static func reportBody(_ id: String, folder: String?, failed: Bool) -> Data? {
        return try? JSONSerialization.data(withJSONObject: ["action": "desktop-report", "id": id,
            "folder": folder.map { $0 as Any } ?? NSNull(), "failed": failed])
    }
    deinit { if started { scoped?.stopAccessingSecurityScopedResource() } }
}

func smbFolderAccessSelfTests() throws {
    func check(_ value: Bool) throws { if !value { throw NSError(domain: "SmbFolderAccess", code: 1) } }
    try check(SmbFolderAccess.address("smb://server/share") != nil)
    for value in ["smb://user:secret@server/share", "smb://user@server/share", "https://server/share", "smb://server/share?secret=1", "smb://server/share/../other", "smb://server/share#secret", "smb://server/share%2Fother"] {
        try check(SmbFolderAccess.address(value) == nil)
    }
    let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: folder) }
    try check(!SmbFolderAccess.isSmbFolder(folder))
    let canceled = try JSONSerialization.jsonObject(with: SmbFolderAccess.reportBody("request", folder: nil, failed: true)!) as! [String: Any]
    try check(canceled["folder"] is NSNull)
    let selected = try JSONSerialization.jsonObject(with: SmbFolderAccess.reportBody("request", folder: "/synthetic/share", failed: false)!) as! [String: Any]
    try check(selected["folder"] as? String == "/synthetic/share")
}
