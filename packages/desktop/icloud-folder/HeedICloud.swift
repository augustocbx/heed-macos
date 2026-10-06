import Foundation
import AppKit

struct CloudObservation: Codable {
    let ubiquitous: Bool
    let uploaded: Bool?
    let uploading: Bool?
    let downloaded: String?
    let errorCode: Int?
    var state: String {
        if !ubiquitous { return "unsupported-folder" }
        if errorCode != nil { return "provider-error" }
        if uploaded == true { return "system-reported-uploaded" }
        if uploading == true { return "uploading" }
        return "pending-upload"
    }
    var remoteChecksumVerified: Bool { false }
}
func observe(_ url: URL) throws -> CloudObservation {
    // A one-shot read outside a coordinated accessor cannot prevent the provider's coordinated work.
    var refreshed=url
    refreshed.removeAllCachedResourceValues()
    let values = try refreshed.resourceValues(forKeys: [.isUbiquitousItemKey,.ubiquitousItemIsUploadedKey,.ubiquitousItemIsUploadingKey,.ubiquitousItemDownloadingStatusKey,.ubiquitousItemUploadingErrorKey,.ubiquitousItemDownloadingErrorKey])
    return CloudObservation(ubiquitous: values.isUbiquitousItem == true, uploaded: values.ubiquitousItemIsUploaded, uploading: values.ubiquitousItemIsUploading, downloaded: values.ubiquitousItemDownloadingStatus?.rawValue, errorCode: (values.ubiquitousItemUploadingError ?? values.ubiquitousItemDownloadingError)?.code)
}
func selfTests() throws {
    func check(_ condition: Bool, _ message: String) throws { if !condition { throw NSError(domain:"HeedICloud",code:1,userInfo:[NSLocalizedDescriptionKey:message]) } }
    let pending = CloudObservation(ubiquitous:true,uploaded:false,uploading:false,downloaded:nil,errorCode:nil)
    let uploaded = CloudObservation(ubiquitous:true,uploaded:true,uploading:false,downloaded:nil,errorCode:nil)
    try check(pending.state == "pending-upload" && !pending.remoteChecksumVerified,"Local saved data is not a remote receipt")
    try check(uploaded.state == "system-reported-uploaded" && !uploaded.remoteChecksumVerified,"System upload status is distinct from remote checksum verification")
    try check(CloudObservation(ubiquitous:true,uploaded:true,uploading:false,downloaded:nil,errorCode:4354).state == "provider-error","Provider errors outrank an old upload flag")
    let folder = FileManager.default.temporaryDirectory.appendingPathComponent("heed-icloud-prototype-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at:folder,withIntermediateDirectories:true)
    defer { try? FileManager.default.removeItem(at:folder) }
    let file=folder.appendingPathComponent("synthetic.txt")
    try Data("Synthetic fixture".utf8).write(to:file)
    try check(try observe(file).state == "unsupported-folder","Ordinary disposable folders never masquerade as iCloud")
    var error:NSError?,read:Data?
    NSFileCoordinator().coordinate(readingItemAt:file,options:[],error:&error){url in read=try? Data(contentsOf:url)}
    if let error=error { throw error }
    try check(read == Data("Synthetic fixture".utf8),"Public file coordination preserves local content")
}
if CommandLine.arguments == [CommandLine.arguments[0],"--self-test"] {
    do { try selfTests(); try protocolTests(); print("iCloud capability prototype self-tests passed") }
    catch { fputs("iCloud capability prototype failed\n",stderr);exit(1) }
} else if CommandLine.arguments.count == 1 {
    do { try runtime() } catch { fputs("iCloud folder operation unavailable. Check account, access, hydration and library integrity.\n", stderr); exit(1) }
} else { fputs("Usage: heed-icloud [--self-test]\n",stderr);exit(2) }
