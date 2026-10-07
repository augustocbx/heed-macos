import Foundation
final class CoordinatedFixtureResult { var data: Data?; let lock = NSLock() }
func protocolTests() throws {
    // No account or bookmark lookup is involved in failure serialization tests.
    let sentinel = "/private/sentinel-root SECRET_BOOKMARK localized diagnostic"
    for code in [CloudIssue.accountUnavailable, .accountChanged, .bookmarkStale, .folderUnavailable, .permissionDenied, .hydrationPending, .unavailable] {
        let bytes = try cloudFailureEnvelope(CloudFailure(sentinel, issue: code))
        guard let value = try JSONSerialization.jsonObject(with: bytes) as? [String: Any], value.count == 3, value["code"] as? String == code.rawValue, !String(decoding: bytes, as: UTF8.self).contains(sentinel) else { throw CloudFailure("Failure protocol must preserve only the allowlisted issue") }
    }
    for domain in [NSCocoaErrorDomain, NSPOSIXErrorDomain, "UnknownPrivateDomain"] {
        let known = domain == NSCocoaErrorDomain ? NSFileReadNoPermissionError : Int(EACCES)
        let issue = cloudIssue(NSError(domain: domain, code: known, userInfo: [NSLocalizedDescriptionKey: sentinel]))
        guard issue == (domain == "UnknownPrivateDomain" ? .unavailable : .permissionDenied) else { throw CloudFailure("Only known permission domains may classify a failure") }
    }
    guard cloudIssue(NSError(domain: NSCocoaErrorDomain, code: 999999, userInfo: [NSLocalizedDescriptionKey: "iCloud account changed " + sentinel])) == .unavailable else { throw CloudFailure("Raw descriptions cannot classify failures") }
    try acceptanceObserverTests();try acceptanceOwnershipTests();try acceptanceQueryTests()
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

func acceptanceObserverTests() throws {
    let base = FileManager.default.temporaryDirectory.appendingPathComponent("heed-qa-observer-\(UUID().uuidString)").resolvingSymlinksInPath()
    try FileManager.default.createDirectory(at: base, withIntermediateDirectories: false)
    defer { try? FileManager.default.removeItem(at: base) }
    let files = try ScopedFiles(root: base)
    let bookmark = try base.bookmarkData(options: .withSecurityScope, includingResourceValuesForKeys: nil, relativeTo: nil)
    let binding = CloudBinding(bookmark: bookmark.base64EncodedString(), account: Data("synthetic".utf8).base64EncodedString(), identity: files.identity)
    var accounts = 0, starts = 0, stops = 0, resolutions = 0
    let environment = AcceptanceEnvironment(resolve: { data, options, stale in
        guard options.contains(.withoutUI), options.contains(.withoutMounting), options.contains(.withSecurityScope) else { throw CloudFailure("Observer resolution must suppress mounts and UI") }
        resolutions += 1
        return try URL(resolvingBookmarkData: data, options: options, relativeTo: nil, bookmarkDataIsStale: &stale)
    }, account: { _ in accounts += 1 }, ubiquitous: { _ in true }, start: { _ in starts += 1; return true }, stop: { _ in stops += 1 })
    let result = try acceptanceObserve(binding, environment: environment)
    guard result["identity"] as? String == files.identity, accounts >= 2, resolutions == 1, starts == 1, stops == 1,
          !FileManager.default.fileExists(atPath: base.appendingPathComponent("heed-library.json").path),
          try FileManager.default.contentsOfDirectory(atPath: base.path).isEmpty else { throw CloudFailure("Metadata observer must not create state") }
    var refused = false
    do { _ = try acceptanceObserve(CloudBinding(bookmark:binding.bookmark,account:binding.account,identity:"1:2"),environment:environment) } catch { refused = true }
    guard refused, starts == stops else { throw CloudFailure("Changed identity refuses with balanced scope") }
    refused = false
    do { _ = try acceptanceJSON(Data("{\"action\":\"qa-observe-parent\",\"action\":\"probe\"}".utf8)) } catch { refused = true }
    guard refused else { throw CloudFailure("Duplicate action must refuse") }
}

func acceptanceOwnershipTests() throws {
    let base=URL(fileURLWithPath:"/private/tmp").appendingPathComponent("heed-qa-ownership-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at:base,withIntermediateDirectories:false,attributes:[.posixPermissions:0o700]);defer {try? FileManager.default.removeItem(at:base)}
    let parent=base.appendingPathComponent("parent");try FileManager.default.createDirectory(at:parent,withIntermediateDirectories:false,attributes:[.posixPermissions:0o700])
    let run=UUID().uuidString.lowercased(),destination=UUID().uuidString.lowercased()
    let spec:[String:Any]=["version":1,"runId":run,"destinationId":destination,"provider":"icloud","destinationVersion":2,"child":"heed-qa-\(run)","aliases":["a","b"],"locales":["en","pt"],"fixtureSchema":1,"fixtureHash":String(repeating:"a",count:64)]
    func workspace(_ name:String) throws -> [String:Any] {
        let root=base.appendingPathComponent(name)
        for url in [root,root.appendingPathComponent("acceptance"),root.appendingPathComponent("quota")] {try FileManager.default.createDirectory(at:url,withIntermediateDirectories:false,attributes:[.posixPermissions:0o700])}
        let names=["guard","receipt","checkpoint","parent-binding","child-binding"].map {root.appendingPathComponent("acceptance/\($0)").path}.sorted()
        let ledger:[String:Any]=["version":1,"reservations":["qa-ledger-\(run)":["bytes":8192,"paths":[]],"qa-bootstrap-\(run)":["bytes":332768,"paths":names]],"atomicWrites":[:]]
        let file=root.appendingPathComponent("quota/ledger");let fd=open(file.path,O_RDWR|O_APPEND|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC,0o600);guard fd>=0 else {throw CloudFailure("Fixture ledger unavailable")};defer {close(fd)}
        var info=stat();guard fstat(fd,&info)==0 else {throw CloudFailure("Fixture ledger identity unavailable")};let identity=["device":String(info.st_dev),"inode":String(info.st_ino),"birth":String(Int64(info.st_birthtimespec.tv_sec)*1000+Int64(info.st_birthtimespec.tv_nsec)/1_000_000)]
        let first:[String:Any]=["version":1,"reservations":["qa-ledger-\(run)":["bytes":8192,"paths":[]]],"atomicWrites":[:]]
        for record in [["format":"heed-qa-ledger","version":2,"identity":identity] as [String:Any],first,ledger] {try AcceptanceIO.system.append(fd,acceptanceCanonical(record)+Data([10]))};try AcceptanceIO.system.sync(fd)
        return ["path":root.path,"identity":try acceptanceLocalDescriptor(root),"receipts":try acceptanceLocalDescriptor(root.appendingPathComponent("acceptance")),"quota":try acceptanceLocalDescriptor(root.appendingPathComponent("quota"))]
    }
    let environment=AcceptanceEnvironment(resolve:{data,options,stale in try URL(resolvingBookmarkData:data,options:options,relativeTo:nil,bookmarkDataIsStale:&stale)},account:{_ in},ubiquitous:{_ in true},start:{$0.startAccessingSecurityScopedResource()},stop:{$0.stopAccessingSecurityScopedResource()})
    func binding(_ url:URL) throws -> CloudBinding {CloudBinding(bookmark:try url.bookmarkData(options:.withSecurityScope,includingResourceValuesForKeys:nil,relativeTo:nil).base64EncodedString(),account:Data("synthetic-account".utf8).base64EncodedString(),identity:try ScopedFiles(root:url).identity)}
    let a=try workspace("a"),parentBinding=try binding(parent)
    let first=try acceptanceBootstrap(action:"qa-create-child",binding:parentBinding,generation:"fixture-generation",spec:spec,workspace:a,evidence:nil,environment:environment,machine:{"synthetic-physical-a"})
    guard FileManager.default.fileExists(atPath:(a["path"] as! String)+"/acceptance/parent-binding"),FileManager.default.fileExists(atPath:(a["path"] as! String)+"/acceptance/child-binding") else {throw CloudFailure("Private acceptance bindings must be durable")}
    let second=try acceptanceBootstrap(action:"qa-create-child",binding:parentBinding,generation:"fixture-generation",spec:spec,workspace:a,evidence:nil,environment:environment,machine:{"synthetic-physical-a"})
    guard first["phase"] as? String=="initialized",second["phase"] as? String=="initialized" else {throw CloudFailure("Original allocated child must resume")}
    let originalAuthorityBytes=try Data(contentsOf:URL(fileURLWithPath:(a["path"] as! String)+"/acceptance/receipt"))
    try withExistingAcceptanceAuthority(binding:parentBinding,generation:"fixture-generation",spec:spec,workspace:a,role:"creator",environment:environment,machine:{"synthetic-physical-a"}) { issued,generation,verify in
        try verify();guard acceptanceEqual(issued,first["binding"] as! [String:Any]),generation==first["generation"] as? String else {throw CloudFailure("Original authority must return its immutable binding")}
        var concurrentRefused=false
        do {try withExistingAcceptanceAuthority(binding:parentBinding,generation:"fixture-generation",spec:spec,workspace:a,role:"creator",environment:environment,machine:{"synthetic-physical-a"}) { _,_,_ in }}catch{concurrentRefused=true}
        guard concurrentRefused else {throw CloudFailure("Original guard must remain held")}
    }
    guard try Data(contentsOf:URL(fileURLWithPath:(a["path"] as! String)+"/acceptance/receipt"))==originalAuthorityBytes else {throw CloudFailure("Authorization cannot append receipt records")}
    let child=parent.appendingPathComponent("heed-qa-\(run)"),childFiles=try ScopedFiles(root:child)
    guard try header(childFiles)?["destinationId"] as? String==destination else {throw CloudFailure("Actual v2 header required")}
    let b=try workspace("b"),childBinding=try binding(child)
    let evidence:[String:Any]=["runId":run,"destinationId":destination,"provider":"icloud","destinationVersion":2,"child":"heed-qa-\(run)","initialized":true]
    let joined=try acceptanceBootstrap(action:"qa-join-child",binding:childBinding,generation:"participant-generation",spec:spec,workspace:b,evidence:evidence,environment:environment,machine:{"synthetic-physical-b"})
    guard joined["role"] as? String=="participant" else {throw CloudFailure("Independent participant role required")}
    try withExistingAcceptanceAuthority(binding:childBinding,generation:"participant-generation",spec:spec,workspace:b,role:"participant",environment:environment,machine:{"synthetic-physical-b"}) { issued,_,verify in try verify();guard acceptanceEqual(issued,joined["binding"] as! [String:Any]) else {throw CloudFailure("Participant must consume its own binding")} }
    let liveReceipt=URL(fileURLWithPath:(a["path"] as! String)+"/acceptance/receipt"),retained=liveReceipt.appendingPathExtension("retained-live")
    try withExistingAcceptanceAuthority(binding:parentBinding,generation:"fixture-generation",spec:spec,workspace:a,role:"creator",environment:environment,machine:{"synthetic-physical-a"}) { _,_,verify in
        let bytes=try Data(contentsOf:liveReceipt);try FileManager.default.moveItem(at:liveReceipt,to:retained);try bytes.write(to:liveReceipt);try FileManager.default.setAttributes([.posixPermissions:0o600],ofItemAtPath:liveReceipt.path)
        var rejected=false;do {try verify()}catch{rejected=true};guard rejected,try Data(contentsOf:liveReceipt)==bytes else {throw CloudFailure("Live substituted receipt must be retained and refused")}
        try FileManager.default.removeItem(at:liveReceipt);try FileManager.default.moveItem(at:retained,to:liveReceipt)
    }
    for control in ["{\"sequence\":1,\"action\":\"check\"}\n","{\"sequence\":1,\"sequence\":2,\"action\":\"check\"}\n","{\"sequence\":1,\"action\":\"check\"}\r\n"] {
        var descriptors:[Int32]=[0,0];guard pipe(&descriptors)==0 else {throw CloudFailure("Fixture pipe unavailable")};defer {close(descriptors[0]);close(descriptors[1])}
        let data=Data(control.utf8);try data.withUnsafeBytes {buffer in guard Darwin.write(descriptors[1],buffer.baseAddress!,data.count)==data.count else {throw CloudFailure("Fixture pipe write failed")}}
        var accepted=false;do {_=try acceptanceAuthorityFrame(deadline:ProcessInfo.processInfo.systemUptime+1,input:descriptors[0]);accepted=true}catch{}
        guard accepted == (!control.contains("sequence\":2") && !control.utf8.contains(13)) else {throw CloudFailure("Strict original authority control framing required")}
    }
    var refused=false
    do {_=try acceptanceBootstrap(action:"qa-create-child",binding:parentBinding,generation:"fixture-generation",spec:spec,workspace:a,evidence:nil,environment:environment,machine:{"copied-physical-device"})}catch{refused=true}
    guard refused else {throw CloudFailure("Copied device authority must refuse")}
    let receiptURL=URL(fileURLWithPath:(a["path"] as! String)+"/acceptance/receipt")
    let original=try Data(contentsOf:receiptURL);var records=try original.split(separator:10).map{try acceptanceJSON(Data($0))};records[records.count-1]["phase"]="joined"
    func writeRecords(_ records:[[String:Any]]) throws {var bytes=Data();for record in records {bytes += try acceptanceCanonical(record)+Data([10])};try bytes.write(to:receiptURL)}
    try writeRecords(records)
    var resolutions=0;var guarded=environment;guarded.resolve={_,_,_ in resolutions+=1;throw CloudFailure("Unexpected resolution")}
    refused=false;do {_=try acceptanceBootstrap(action:"qa-create-child",binding:parentBinding,generation:"fixture-generation",spec:spec,workspace:a,evidence:nil,environment:guarded,machine:{"synthetic-physical-a"})}catch{refused=true}
    guard refused,resolutions==0 else {throw CloudFailure("Creator cannot resume participant phase")}
    records=try original.split(separator:10).map{try acceptanceJSON(Data($0))};try writeRecords(Array(records.prefix(3)))
    refused=false;do {_=try acceptanceBootstrap(action:"qa-create-child",binding:parentBinding,generation:"fixture-generation",spec:spec,workspace:a,evidence:nil,environment:guarded,machine:{"synthetic-physical-a"})}catch{refused=true}
    guard refused,resolutions==0,FileManager.default.fileExists(atPath:child.path) else {throw CloudFailure("Ambiguous child must retain and refuse before resolution")}
    try original.write(to:receiptURL)
    let oldReceipt=receiptURL.appendingPathExtension("original");try FileManager.default.moveItem(at:receiptURL,to:oldReceipt);try original.write(to:receiptURL);try FileManager.default.setAttributes([.posixPermissions:0o600],ofItemAtPath:receiptURL.path)
    refused=false;do {_=try acceptanceBootstrap(action:"qa-create-child",binding:parentBinding,generation:"fixture-generation",spec:spec,workspace:a,evidence:nil,environment:guarded,machine:{"synthetic-physical-a"})}catch{refused=true}
    guard refused,resolutions==0 else {throw CloudFailure("Byte-identical foreign receipt must refuse before resolution")}
    var malformed=spec;malformed["fixtureSchema"]=true;refused=false;do {_=try acceptanceSpec(malformed)}catch{refused=true}
    guard refused else {throw CloudFailure("Boolean schema must refuse")}
    for boundary in ["source","destination","torn"] {
        // The workspace ledger is scoped to the original fixture run; use the same run
        // with a different selected empty parent to isolate each native allocation.
        let selected=base.appendingPathComponent("parent-"+boundary);try FileManager.default.createDirectory(at:selected,withIntermediateDirectories:false,attributes:[.posixPermissions:0o700])
        let selectedBinding=try binding(selected),local=try workspace("replace-"+boundary),path=URL(fileURLWithPath:(local["path"] as! String)+"/acceptance/receipt");var injected=false
        func substitute() throws {try FileManager.default.moveItem(at:path,to:path.appendingPathExtension("original"));try Data("foreign fixture sentinel".utf8).write(to:path);try FileManager.default.setAttributes([.posixPermissions:0o600],ofItemAtPath:path.path);injected=true}
        var io=AcceptanceIO.system
        io.append={fd,data in if boundary=="torn",String(data:data,encoding:.utf8)?.contains("\"phase\":\"allocating\"")==true,!injected {injected=true;try AcceptanceIO.system.append(fd,Data(data.prefix(data.count/2)));throw CloudFailure("Synthetic torn append")};if boundary=="source",String(data:data,encoding:.utf8)?.contains("\"phase\":\"allocating\"")==true,!injected {try substitute()};try AcceptanceIO.system.append(fd,data)}
        io.sync={fd in try AcceptanceIO.system.sync(fd);if boundary=="destination",!injected,let bytes=try? acceptanceFileBytes(fd,16384),String(data:bytes,encoding:.utf8)?.hasSuffix("\"phase\":\"allocating\"}\n")==true {try substitute()}}
        refused=false;do {_=try acceptanceBootstrap(action:"qa-create-child",binding:selectedBinding,generation:"fixture-generation",spec:spec,workspace:local,evidence:nil,environment:environment,machine:{"synthetic-physical-a"},io:io)}catch{refused=true}
        guard refused,injected,!FileManager.default.fileExists(atPath:selected.appendingPathComponent("heed-qa-\(run)").path),(boundary=="torn" ? try Data(contentsOf:path).last != 10:try Data(contentsOf:path)==Data("foreign fixture sentinel".utf8)) else {throw CloudFailure("Receipt substitution must retain foreign bytes without allocation")}
        if boundary=="torn" {resolutions=0;refused=false;do {_=try acceptanceBootstrap(action:"qa-create-child",binding:selectedBinding,generation:"fixture-generation",spec:spec,workspace:local,evidence:nil,environment:guarded,machine:{"synthetic-physical-a"})}catch{refused=true};guard refused,resolutions==0 else {throw CloudFailure("Torn append must refuse before resolution")}}
    }


}

func acceptanceQueryTests() throws {
    let value=try acceptancePhysicalQuery(executable:URL(fileURLWithPath:"/usr/bin/printf"),arguments:["\"IOPlatformUUID\" = \"11111111-1111-4111-8111-111111111111\""])
    guard value=="11111111-1111-4111-8111-111111111111" else {throw CloudFailure("Synthetic query failed")}
    let started=ProcessInfo.processInfo.systemUptime;var refused=false
    do {_=try acceptancePhysicalQuery(executable:URL(fileURLWithPath:"/bin/sleep"),arguments:["3"],timeout:0.05)}catch{refused=true}
    guard refused,ProcessInfo.processInfo.systemUptime-started<1 else {throw CloudFailure("Owned query deadline must kill and reap")}
}
