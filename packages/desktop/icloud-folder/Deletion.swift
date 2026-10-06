import Foundation

func deletionIntent(_ files: ScopedFiles, job: String, destination: String) throws -> [String: Any] {
    guard UUID(uuidString: job) != nil else { throw CloudFailure("Invalid deletion identity") }
    let bytes = try files.read("control/deletions/\(job).json", max: 2_000_000)
    guard let value = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
          value.count == 5, value["version"] as? Int == 1, value["jobId"] as? String == job,
          value["destinationId"] as? String == destination,
          let revisions = value["revisions"] as? [[String: Any]], !revisions.isEmpty, revisions.count <= 1000,
          let artifacts = value["artifacts"] as? [[String: Any]], !artifacts.isEmpty, artifacts.count <= 10000 else { throw CloudFailure("Invalid deletion intent") }
    for revision in revisions {
        guard revision.count == 5, ["libraryId", "meetingId", "revisionId"].allSatisfy({UUID(uuidString: revision[$0] as? String ?? "") != nil}),
              let hash = revision["manifestHash"] as? String, hash.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
              let parents = revision["parents"] as? [String], parents.count <= 32, Set(parents).count == parents.count,
              parents.allSatisfy({UUID(uuidString:$0) != nil && $0 != revision["revisionId"] as? String}) else { throw CloudFailure("Invalid deletion lineage") }
    }
    for artifact in artifacts {
        guard artifact.count == 3, let path = artifact["path"] as? String, let bytes = artifact["bytes"] as? Int, bytes > 0,
              let hash = artifact["sha256"] as? String, hash.range(of:"^[a-f0-9]{64}$",options:.regularExpression) != nil else { throw CloudFailure("Invalid exact deletion target") }
        let parts = try artifactPath(path)
        if parts[0] == "meetings" { guard parts.count == 5, parts[2] == "revisions", ["meeting.json", "manifest.json"].contains(parts[4]), revisions.contains(where: {$0["meetingId"] as? String == parts[1] && $0["revisionId"] as? String == parts[3] && (parts[4] != "manifest.json" || $0["manifestHash"] as? String == hash)}) else { throw CloudFailure("Broadened deletion target") } }
        else if parts[0] == "commits" { guard parts.count == 3, UUID(uuidString:parts[1]) != nil, parts[2].hasSuffix(".json"), revisions.contains(where: {($0["revisionId"] as? String ?? "") + ".json" == parts[2]}) else { throw CloudFailure("Broadened commit target") } }
        else { throw CloudFailure("Shared audio garbage collection is unavailable") }
    }
    return value
}
func exactCloudRemoval(_ files: ScopedFiles, job: String, destination: String, path: String, bytes: Int, hash: String, validate: () throws -> Void = {}) throws -> String {
    let record = try deletionIntent(files, job: job, destination: destination)
    let artifacts = record["artifacts"] as! [[String:Any]]
    guard let artifact = artifacts.first(where: {$0["path"] as? String == path}), artifact["bytes"] as? Int == bytes, artifact["sha256"] as? String == hash else { throw CloudFailure("Target is not in the confirmed intent") }
    let canonical = path.hasSuffix("/manifest.json")
    var fence: [String:Any]?
    if canonical {
        let revisions = record["revisions"] as! [[String:Any]]
        guard let revision = revisions.first(where: {"meetings/\($0["meetingId"]!)/revisions/\($0["revisionId"]!)/manifest.json" == path}) else { throw CloudFailure("Missing deletion lineage") }
        fence = ["kind":"heed-deleted-revision","version":1,"jobId":job,"destinationId":destination,"revision":revision,"artifact":artifact]
        if let current = try? files.read(path,max:65536), let stored = try? JSONSerialization.jsonObject(with:current) as? [String:Any],stored.count==6,stored["kind"] as? String=="heed-deleted-revision",stored["version"] as? Int==1,stored["destinationId"] as? String==destination,let otherJob=stored["jobId"] as? String,UUID(uuidString:otherJob) != nil,let otherRevision=stored["revision"] as? [String:Any],let otherArtifact=stored["artifact"] as? [String:Any],NSDictionary(dictionary:otherRevision).isEqual(to:revision),NSDictionary(dictionary:otherArtifact).isEqual(to:artifact) {
            let other=try deletionIntent(files,job:otherJob,destination:destination)
            guard (other["revisions"] as! [[String:Any]]).contains(where:{NSDictionary(dictionary:$0).isEqual(to:revision)}),(other["artifacts"] as! [[String:Any]]).contains(where:{NSDictionary(dictionary:$0).isEqual(to:artifact)}) else {throw CloudFailure("Unconfirmed equivalent deletion fence")}
            _=try files.removeMetadata(path,bytes:bytes,hash:hash,job:job,quarantineOnly:true,validate:validate)
            return "already-removed"
        }
    }
    let result = try files.removeMetadata(path,bytes:bytes,hash:hash,job:job,validate:validate)
    // Unlink and canonical fence creation share one local file coordinator accessor.
    if let fence = fence { let data = try JSONSerialization.data(withJSONObject:fence,options:[.sortedKeys]); var offset = 0; try files.write(path,bytes:data.count,digest:digest(data),stagingId:job,validate:validate) { count in defer {offset += count}; return data.subdata(in:offset..<offset+count) } }
    return result
}
func remoteDeletionTests() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("heed-icloud-delete-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at:root,withIntermediateDirectories:true); defer {try? FileManager.default.removeItem(at:root)}
    let files = try ScopedFiles(root:root), job = UUID().uuidString.lowercased(), destination = UUID().uuidString.lowercased(), meeting = UUID().uuidString.lowercased(), revision = UUID().uuidString.lowercased(), library = UUID().uuidString.lowercased()
    let path = "meetings/\(meeting)/revisions/\(revision)/manifest.json", data = Data("Synthetic exact manifest".utf8)
    func write(_ path:String,_ data:Data) throws { var offset=0;try files.write(path,bytes:data.count,digest:digest(data)) {count in defer {offset += count};return data.subdata(in:offset..<offset+count)} }
    let artifact:[String:Any] = ["path":path,"bytes":data.count,"sha256":digest(data)], descriptor:[String:Any] = ["libraryId":library,"meetingId":meeting,"revisionId":revision,"manifestHash":digest(data),"parents":[]]
    let record:[String:Any] = ["version":1,"jobId":job,"destinationId":destination,"revisions":[descriptor],"artifacts":[artifact]]
    try write(path,data);try write("objects/preserved",Data("Synthetic shared audio".utf8));try write("control/deletions/\(job).json",JSONSerialization.data(withJSONObject:record,options:[.sortedKeys]))
    var refused=false;do {_ = try exactCloudRemoval(files,job:job,destination:destination,path:path,bytes:data.count,hash:String(repeating:"0",count:64))}catch {refused=true};guard refused, try files.read(path,max:65536) == data else {throw CloudFailure("Mismatched target must be preserved")}
    let result = try coordinated(root,binding:CloudBinding(bookmark:"",account:"",identity:files.identity),path:path,write:true,deleting:true) {try exactCloudRemoval($0,job:job,destination:destination,path:path,bytes:data.count,hash:digest(data))}
    guard result == "removed", try files.read("objects/preserved",max:100) == Data("Synthetic shared audio".utf8), String(data:try files.read(path,max:65536),encoding:.utf8)!.contains("heed-deleted-revision") else {throw CloudFailure("Exact removal must preserve shared audio and replace manifest contents")}
    guard try exactCloudRemoval(files,job:job,destination:destination,path:path,bytes:data.count,hash:digest(data)) == "already-removed" else {throw CloudFailure("Deletion retry must be idempotent")}
    let secondJob=UUID().uuidString.lowercased();var second=record;second["jobId"]=secondJob;try write("control/deletions/\(secondJob).json",JSONSerialization.data(withJSONObject:second,options:[.sortedKeys]))
    let quarantine=root.appendingPathComponent(path).deletingLastPathComponent().appendingPathComponent(".heed-delete-\(secondJob)-\(digest(data)).quarantine");try data.write(to:quarantine)
    guard try exactCloudRemoval(files,job:secondJob,destination:destination,path:path,bytes:data.count,hash:digest(data)) == "already-removed" else {throw CloudFailure("Equivalent independently confirmed deletion must not wedge")}
    guard !FileManager.default.fileExists(atPath:quarantine.path) else {throw CloudFailure("Equivalent fence must not strand the confirmed original quarantine")}
    refused=false;do {try files.write(path,bytes:data.count,digest:digest(data),exclusive:true,input:{$0 > 0 ? data : Data()})}catch {refused=true};guard refused else {throw CloudFailure("Deleted canonical admission must fail closed")}
}
