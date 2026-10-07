import Foundation
import Darwin

/** Opt-in QA resolution uses the real Foundation API with noninteractive, nonmounting policy. */
struct AcceptanceEnvironment {
    var resolve: (Data, URL.BookmarkResolutionOptions, inout Bool) throws -> URL
    var account: (Data) throws -> Void
    var ubiquitous: (URL) throws -> Bool
    var start: (URL) -> Bool
    var stop: (URL) -> Void
    static let system = AcceptanceEnvironment(resolve: { data, options, stale in
        try URL(resolvingBookmarkData:data, options:options, relativeTo:nil, bookmarkDataIsStale:&stale)
    }, account:requireAccount, ubiquitous: { url in
        var fresh = url; fresh.removeAllCachedResourceValues()
        return try fresh.resourceValues(forKeys:[.isUbiquitousItemKey]).isUbiquitousItem == true
    }, start: { $0.startAccessingSecurityScopedResource() }, stop: { $0.stopAccessingSecurityScopedResource() })
}
func acceptanceIdentity(_ fd:Int32) throws -> String {
    var value=stat(); guard fstat(fd,&value)==0 else {throw CloudFailure("Acceptance identity unavailable")}
    return "\(value.st_dev):\(value.st_ino):\(value.st_birthtimespec.tv_sec):\(value.st_birthtimespec.tv_nsec)"
}
/** Hold the complete physical chain; reopen each immediate component through its retained parent. */
final class AcceptanceChain {
    let path:String; let components:[String]; var descriptors:[Int32]=[]; var identities:[String]=[]
    var fd:Int32 {descriptors.last!}
    init(_ path:String) throws {
        self.path=path; components=path.split(separator:"/",omittingEmptySubsequences:false).dropFirst().map(String.init)
        guard path.hasPrefix("/"),path.utf8.count<=4096,!path.contains("\0"),!components.isEmpty,components.count<64,components.allSatisfy({!$0.isEmpty && $0 != "." && $0 != ".."}) else {throw CloudFailure("Invalid acceptance directory")}
        do {
            let root=open("/",O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);guard root>=0 else {throw CloudFailure("Acceptance root unavailable")};descriptors.append(root)
            for component in components {let next=openat(fd,component,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);guard next>=0 else {throw CloudFailure("Acceptance ancestor unavailable")};descriptors.append(next)}
            identities=try descriptors.map(acceptanceIdentity);try check()
        } catch {for descriptor in descriptors {close(descriptor)};descriptors=[];throw error}
    }
    deinit {for descriptor in descriptors {close(descriptor)}}
    func check() throws {
        for index in descriptors.indices {
            guard try acceptanceIdentity(descriptors[index])==identities[index] else {throw CloudFailure("Acceptance ancestor changed")}
            if index>0 {let other=openat(descriptors[index-1],components[index-1],O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);guard other>=0 else {throw CloudFailure("Acceptance ancestor changed")};defer {close(other)};guard try acceptanceIdentity(other)==identities[index] else {throw CloudFailure("Acceptance ancestor changed")}}
        }
    }
    func requirePrivate() throws {var info=stat();guard fstat(fd,&info)==0,info.st_uid==getuid(),info.st_mode&0o777==0o700 else {throw CloudFailure("Private acceptance ownership unavailable")}}
}
func withAcceptanceParent<T>(_ binding:CloudBinding,environment:AcceptanceEnvironment = .system,operation:(URL,AcceptanceChain,@escaping () throws -> Void) throws -> T) throws -> T {
    guard binding.bookmark.utf8.count<=65536,binding.account.utf8.count<=65536,let bookmark=Data(base64Encoded:binding.bookmark),let account=Data(base64Encoded:binding.account) else {throw CloudFailure("Invalid acceptance binding")}
    try environment.account(account)
    var stale=false
    let root=try environment.resolve(bookmark,[.withSecurityScope,.withoutUI,.withoutMounting],&stale)
    guard !stale else {throw CloudFailure("Acceptance bookmark stale",issue:.bookmarkStale)}
    let started=environment.start(root);defer {if started {environment.stop(root)}}
    let chain=try AcceptanceChain(root.path)
    let check:() throws -> Void = {try chain.check();try environment.account(account);guard try descriptorIdentity(chain.fd)==binding.identity,try environment.ubiquitous(root) else {throw CloudFailure("Acceptance parent changed",issue:.folderUnavailable)}}
    // A false scope start can be valid for an unsandboxed helper; descriptor and account proof are still required.
    try check();let result=try operation(root,chain,check);try check();return result
}
func acceptanceObserve(_ binding:CloudBinding,environment:AcceptanceEnvironment = .system) throws -> [String:Any] {
    try withAcceptanceParent(binding,environment:environment) { _,chain,check in
        try check();return ["identity":try descriptorIdentity(chain.fd),"ancestors":chain.identities,"accountMatched":true,"ubiquitous":true]
    }
}
/** Validate duplicate keys and nesting before Foundation decodes an opt-in request or private receipt. */
func acceptanceJSON(_ data:Data,maximum:Int=150000) throws -> [String:Any] {
    guard data.count<=maximum else {throw CloudFailure("Acceptance frame too large")}
    let bytes=Array(data);var offset=0
    func space(){while offset<bytes.count && [UInt8(9),10,13,32].contains(bytes[offset]) {offset+=1}}
    func string() throws -> String {
        guard offset<bytes.count,bytes[offset]==34 else {throw CloudFailure("Invalid acceptance JSON")};let start=offset;offset+=1
        while offset<bytes.count {let byte=bytes[offset];offset+=1;if byte==92 {offset+=1;continue};if byte==34 {let wrapped=Data([91])+Data(bytes[start..<offset])+Data([93]);guard let decoded=try JSONSerialization.jsonObject(with:wrapped) as? [String],decoded.count==1 else {throw CloudFailure("Invalid acceptance string")};return decoded[0]}}
        throw CloudFailure("Invalid acceptance JSON")
    }
    func value(_ depth:Int) throws {
        guard depth<=64 else {throw CloudFailure("Acceptance nesting limit")};space();guard offset<bytes.count else {throw CloudFailure("Invalid acceptance JSON")}
        if bytes[offset]==34 {_=try string();return}
        if bytes[offset]==123 {offset+=1;space();var keys=Set<String>();if offset<bytes.count && bytes[offset]==125 {offset+=1;return};while true {space();let key=try string();guard keys.insert(key).inserted else {throw CloudFailure("Duplicate acceptance key")};space();guard offset<bytes.count,bytes[offset]==58 else {throw CloudFailure("Invalid acceptance JSON")};offset+=1;try value(depth+1);space();guard offset<bytes.count else {throw CloudFailure("Invalid acceptance JSON")};let end=bytes[offset];offset+=1;if end==125 {return};guard end==44 else {throw CloudFailure("Invalid acceptance JSON")}}}
        if bytes[offset]==91 {offset+=1;space();if offset<bytes.count && bytes[offset]==93 {offset+=1;return};while true {try value(depth+1);space();guard offset<bytes.count else {throw CloudFailure("Invalid acceptance JSON")};let end=bytes[offset];offset+=1;if end==93 {return};guard end==44 else {throw CloudFailure("Invalid acceptance JSON")}}}
        let start=offset;while offset<bytes.count && ![UInt8(9),10,13,32,44,93,125].contains(bytes[offset]) {offset+=1};guard offset>start else {throw CloudFailure("Invalid acceptance JSON")}
    }
    try value(0);space();guard offset==bytes.count,let result=try JSONSerialization.jsonObject(with:data) as? [String:Any] else {throw CloudFailure("Invalid acceptance JSON")};return result
}

func acceptanceLocalDescriptor(_ url:URL) throws -> [String:String] {
    let chain=try AcceptanceChain(url.path);var s=stat();guard fstat(chain.fd,&s)==0 else {throw CloudFailure("Acceptance descriptor unavailable")}
    return ["device":String(s.st_dev),"inode":String(s.st_ino),"birth":String(Int64(s.st_birthtimespec.tv_sec)*1000+Int64(s.st_birthtimespec.tv_nsec)/1_000_000)]
}
/** Keep the private physical-origin query bounded, then reap its owned process on every path. */
func acceptancePhysicalQuery(executable:URL,arguments:[String],timeout:TimeInterval=5) throws -> String {
    guard timeout>0,timeout<=5 else {throw CloudFailure("Acceptance origin deadline invalid")}
    let process=Process(),pipe=Pipe();process.executableURL=executable;process.arguments=arguments
    process.standardOutput=pipe;process.standardError=FileHandle.nullDevice
    try process.run();try pipe.fileHandleForWriting.close()
    defer {if process.isRunning {kill(process.processIdentifier,SIGKILL)};process.waitUntilExit();try? pipe.fileHandleForReading.close()}
    let fd=pipe.fileHandleForReading.fileDescriptor
    guard fcntl(fd,F_SETFL,fcntl(fd,F_GETFL)|O_NONBLOCK)==0 else {throw CloudFailure("Acceptance physical origin unavailable")}
    let deadline=ProcessInfo.processInfo.systemUptime+timeout;var output=Data(),buffer=[UInt8](repeating:0,count:4096)
    while true {
        let count=Darwin.read(fd,&buffer,buffer.count)
        if count>0 {output.append(contentsOf:buffer.prefix(count));guard output.count<=65536 else {throw CloudFailure("Acceptance physical origin unavailable")}}
        else if count==0 {break}
        else if errno != EAGAIN && errno != EINTR {throw CloudFailure("Acceptance physical origin unavailable")}
        guard ProcessInfo.processInfo.systemUptime<deadline else {throw CloudFailure("Acceptance physical origin unavailable")}
        if count<0 {Thread.sleep(forTimeInterval:0.005)}
    }
    while process.isRunning {guard ProcessInfo.processInfo.systemUptime<deadline else {throw CloudFailure("Acceptance physical origin unavailable")};Thread.sleep(forTimeInterval:0.005)}
    guard process.terminationStatus==0,let text=String(data:output,encoding:.utf8),
          let expression=try? NSRegularExpression(pattern:"\"IOPlatformUUID\"\\s*=\\s*\"([A-Fa-f0-9-]{36})\""),
          let match=expression.firstMatch(in:text,range:NSRange(text.startIndex...,in:text)),let range=Range(match.range(at:1),in:text) else {throw CloudFailure("Acceptance physical origin unavailable")}
    let value=String(text[range]).lowercased()
    guard UUID(uuidString:value) != nil,value != "00000000-0000-0000-0000-000000000000" else {throw CloudFailure("Acceptance physical origin unavailable")};return value
}
func acceptanceMachine() throws -> String {try acceptancePhysicalQuery(executable:URL(fileURLWithPath:"/usr/sbin/ioreg"),arguments:["-rd1","-c","IOPlatformExpertDevice"])}
func acceptanceInteger(_ value:Any?,_ expected:Int) -> Bool {guard let number=value as? NSNumber,CFGetTypeID(number) != CFBooleanGetTypeID() else {return false};return number.doubleValue==Double(expected)}
func acceptanceEqual(_ left:[String:Any],_ right:[String:Any]) -> Bool {guard let a=try? JSONSerialization.data(withJSONObject:left,options:[.sortedKeys]),let b=try? JSONSerialization.data(withJSONObject:right,options:[.sortedKeys]) else {return false};return a==b}
func acceptancePrivateJSON(_ directory:Int32,_ name:String,_ maximum:Int) throws -> [String:Any]? {
    let file=openat(directory,name,O_RDONLY|O_NOFOLLOW|O_NONBLOCK|O_CLOEXEC);if file<0 && errno==ENOENT {return nil};guard file>=0 else {throw CloudFailure("Acceptance private state unavailable")};defer {close(file)}
    var s=stat();guard fstat(file,&s)==0,s.st_mode&S_IFMT==S_IFREG,s.st_uid==getuid(),s.st_mode&0o777==0o600,s.st_nlink==1,s.st_size>0,s.st_size<=maximum else {throw CloudFailure("Unsafe acceptance state")}
    var bytes=[UInt8](repeating:0,count:Int(s.st_size)+1);let count=Darwin.read(file,&bytes,bytes.count);guard count==s.st_size else {throw CloudFailure("Acceptance private state changed")};return try acceptanceJSON(Data(bytes.prefix(count)),maximum:maximum)
}
func acceptanceAbsent(_ directory:Int32,_ name:String) throws {var s=stat();guard fstatat(directory,name,&s,AT_SYMLINK_NOFOLLOW)<0,errno==ENOENT else {throw CloudFailure("Unknown acceptance checkpoint retained")}}
func acceptanceSpec(_ value:[String:Any]) throws -> [String:Any] {
    guard Set(value.keys)==Set(["version","runId","destinationId","provider","destinationVersion","child","aliases","locales","fixtureSchema","fixtureHash"]),acceptanceInteger(value["version"],1),value["provider"] as? String=="icloud",acceptanceInteger(value["destinationVersion"],2),acceptanceInteger(value["fixtureSchema"],1),
          let run=value["runId"] as? String,UUID(uuidString:run) != nil,run==run.lowercased(),let destination=value["destinationId"] as? String,UUID(uuidString:destination) != nil,destination==destination.lowercased(),value["child"] as? String=="heed-qa-\(run)",value["aliases"] as? [String]==["a","b"],value["locales"] as? [String]==["en","pt"],let hash=value["fixtureHash"] as? String,hash.range(of:"^[a-f0-9]{64}$",options:.regularExpression) != nil else {throw CloudFailure("Invalid acceptance specification")};return value
}
func acceptanceBindingObject(_ binding:CloudBinding) throws -> [String:Any] {let encoder=JSONEncoder();encoder.outputFormatting = .sortedKeys;return try JSONSerialization.jsonObject(with:encoder.encode(binding)) as! [String:Any]}
func acceptanceExclusiveBinding(_ directory:Int32,_ name:String,_ value:[String:Any]) throws -> [String:Any] {
    let data=try JSONSerialization.data(withJSONObject:value,options:[.sortedKeys]);guard data.count<=150000 else {throw CloudFailure("Acceptance binding exceeded bounds")}
    let fd=openat(directory,name,O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC,0o600);guard fd>=0 else {throw CloudFailure("Unknown acceptance binding retained")};defer {close(fd)}
    try data.withUnsafeBytes {buffer in var offset=0;while offset<data.count {let size=Darwin.write(fd,buffer.baseAddress!.advanced(by:offset),data.count-offset);guard size>0 else {throw CloudFailure("Acceptance binding checkpoint failed")};offset+=size}}
    guard fsync(fd)==0,fsync(directory)==0 else {throw CloudFailure("Acceptance binding checkpoint failed")};return ["identity":try acceptanceIdentity(fd),"digest":digest(data)]
}
func acceptanceVerifiedBinding(_ directory:Int32,_ name:String,_ expected:[String:Any]) throws -> [String:Any] {
    guard Set(expected.keys)==Set(["identity","digest"]),let value=try acceptancePrivateJSON(directory,name,150000) else {throw CloudFailure("Original acceptance binding unavailable")}
    let fd=openat(directory,name,O_RDONLY|O_NOFOLLOW|O_NONBLOCK|O_CLOEXEC);guard fd>=0 else {throw CloudFailure("Original acceptance binding unavailable")};defer {close(fd)}
    guard try acceptanceIdentity(fd)==expected["identity"] as? String,digest(try JSONSerialization.data(withJSONObject:value,options:[.sortedKeys]))==expected["digest"] as? String else {throw CloudFailure("Acceptance binding changed")};return value
}
func acceptanceCanonical(_ value:[String:Any]) throws -> Data {try JSONSerialization.data(withJSONObject:value,options:[.sortedKeys,.withoutEscapingSlashes])}
func acceptanceFileBytes(_ fd:Int32,_ maximum:Int) throws -> Data {
    var info=stat();guard fstat(fd,&info)==0,info.st_mode&S_IFMT==S_IFREG,info.st_uid==getuid(),info.st_mode&0o777==0o600,info.st_nlink==1,info.st_size>=0,info.st_size<=maximum else {throw CloudFailure("Unsafe acceptance file")}
    var buffer=[UInt8](repeating:0,count:Int(info.st_size)+1);let count=pread(fd,&buffer,buffer.count,0)
    guard count==info.st_size else {throw CloudFailure("Acceptance file changed")};return Data(buffer.prefix(count))
}
func acceptanceOriginalEntry(_ directory:Int32,_ name:String,_ fd:Int32,_ expected:Data) throws {
    let other=openat(directory,name,O_RDONLY|O_NOFOLLOW|O_NONBLOCK|O_CLOEXEC);guard other>=0 else {throw CloudFailure("Original acceptance file unavailable")};defer {close(other)}
    guard try acceptanceIdentity(other)==acceptanceIdentity(fd),try acceptanceFileBytes(fd,expected.count)==expected,try acceptanceFileBytes(other,expected.count)==expected else {throw CloudFailure("Original acceptance file changed")}
}
func acceptanceLog(_ fd:Int32,_ maximum:Int,_ kind:String) throws -> ([String:Any],[[String:Any]],Data) {
    let bytes=try acceptanceFileBytes(fd,maximum);guard bytes.last==10 else {throw CloudFailure("Incomplete acceptance append retained")}
    let lines=bytes.dropLast().split(separator:10,omittingEmptySubsequences:false);guard lines.count>=2,lines.count<=(kind=="receipt" ? 5:3) else {throw CloudFailure("Acceptance append bound exceeded")}
    let values=try lines.map{try acceptanceJSON(Data($0),maximum:maximum)};let header=values[0]
    guard Set(header.keys)==Set(kind=="receipt" ? ["format","version","identity","scope"]:["format","version","identity"]),header["format"] as? String=="heed-qa-"+kind,acceptanceInteger(header["version"],2) else {throw CloudFailure("Original acceptance format required")}
    if kind=="receipt" {guard try header["identity"] as? String==acceptanceIdentity(fd) else {throw CloudFailure("Original receipt inode required")}}
    else {var info=stat();guard fstat(fd,&info)==0 else {throw CloudFailure("Original ledger unavailable")};let identity=["device":String(info.st_dev),"inode":String(info.st_ino),"birth":String(Int64(info.st_birthtimespec.tv_sec)*1000+Int64(info.st_birthtimespec.tv_nsec)/1_000_000)];guard header["identity"] as? [String:String]==identity else {throw CloudFailure("Original ledger inode required")}}
    return (header,Array(values.dropFirst()),bytes)
}
func acceptanceReceipt(_ fd:Int32) throws -> ([String:Any],[String:Any],Data) {
    let (header,records,bytes)=try acceptanceLog(fd,16384,"receipt")
    guard let scope=header["scope"] as? [String:Any],acceptanceInteger(scope["version"],2),let role=scope["role"] as? String,["creator","participant"].contains(role) else {throw CloudFailure("Invalid receipt scope")}
    let phases=role=="creator" ? ["prepared","allocating","allocated","initialized"]:["prepared","joined"]
    guard records.count<=phases.count else {throw CloudFailure("Invalid receipt phase count")}
    for (index,record) in records.enumerated() {
        guard Set(record.keys)==Set(["phase","child","childFile"]),record["phase"] as? String==phases[index] else {throw CloudFailure("Invalid receipt phase chain")}
        if index==0 || phases[index]=="allocating" {guard record["child"] is NSNull,record["childFile"] is NSNull else {throw CloudFailure("Invalid unallocated receipt")}}
        else {guard let child=record["child"] as? String,child.range(of:"^[0-9]+:[0-9]+:[0-9]+:[0-9]+$",options:.regularExpression) != nil,(phases[index]=="allocated" ? record["childFile"] is NSNull:record["childFile"] is [String:Any]) else {throw CloudFailure("Invalid allocated receipt")}}
    }
    return (header,scope.merging(records.last!){_,new in new},bytes)
}
func acceptanceReadReceipt(_ directory:Int32) throws -> [String:Any]? {
    let fd=openat(directory,"receipt",O_RDONLY|O_NOFOLLOW|O_NONBLOCK|O_CLOEXEC);if fd<0 && errno==ENOENT {return nil};guard fd>=0 else {throw CloudFailure("Original receipt unavailable")};defer {close(fd)}
    let (_,value,bytes)=try acceptanceReceipt(fd);try acceptanceOriginalEntry(directory,"receipt",fd,bytes);return value
}
struct AcceptanceIO {
    var append:(Int32,Data) throws -> Void
    var sync:(Int32) throws -> Void
    static let system=AcceptanceIO(append:{fd,data in try data.withUnsafeBytes {pointer in var offset=0;while offset<data.count {let size=Darwin.write(fd,pointer.baseAddress!.advanced(by:offset),data.count-offset);guard size>0 else {throw CloudFailure("Acceptance append failed")};offset+=size}}},sync:{fd in guard fsync(fd)==0 else {throw CloudFailure("Acceptance fsync failed")}})
}
func acceptanceBudget(workspace:AcceptanceChain,files:AcceptanceChain,quota:AcceptanceChain,spec:[String:Any]) throws {
    let run=spec["runId"] as! String
    let inventory=openat(quota.fd,".",O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);guard inventory>=0 else {throw CloudFailure("Acceptance quota unavailable")};guard let entries=fdopendir(inventory) else {close(inventory);throw CloudFailure("Acceptance quota unavailable")};defer {closedir(entries)};var count=0
    while let entry=readdir(entries) {let name=withUnsafePointer(to:entry.pointee.d_name){$0.withMemoryRebound(to:CChar.self,capacity:1024){String(cString:$0)}};if name=="."||name==".."{continue};count+=1;guard count<=3,name=="ledger" else {throw CloudFailure("Unknown quota checkpoint retained")}}
    let names=["guard","receipt","checkpoint","parent-binding","child-binding"],paths=names.map{workspace.path+"/acceptance/"+$0}.sorted()
    let expected:[String:Any]=["version":1,"reservations":["qa-ledger-\(run)":["bytes":8192,"paths":[]],"qa-bootstrap-\(run)":["bytes":332768,"paths":paths]],"atomicWrites":[:]]
    let ledgerFD=openat(quota.fd,"ledger",O_RDONLY|O_NOFOLLOW|O_NONBLOCK|O_CLOEXEC);guard ledgerFD>=0 else {throw CloudFailure("Acceptance quota reservation required")};defer {close(ledgerFD)}
    let (_,updates,ledgerBytes)=try acceptanceLog(ledgerFD,4096,"ledger");try acceptanceOriginalEntry(quota.fd,"ledger",ledgerFD,ledgerBytes);try AcceptanceIO.system.sync(ledgerFD);try AcceptanceIO.system.sync(quota.fd);try acceptanceOriginalEntry(quota.fd,"ledger",ledgerFD,ledgerBytes)
    let first:[String:Any]=["version":1,"reservations":["qa-ledger-\(run)":["bytes":8192,"paths":[]]],"atomicWrites":[:]]
    guard updates.count==2,acceptanceEqual(updates[0],first),acceptanceEqual(updates[1],expected) else {throw CloudFailure("Acceptance quota reservation required")}
    var total:Int64=0
    for name in names {let file=openat(files.fd,name,O_RDONLY|O_NOFOLLOW|O_NONBLOCK|O_CLOEXEC);if file<0 && errno==ENOENT {continue};guard file>=0 else {throw CloudFailure("Acceptance budget unavailable")};defer {close(file)};var s=stat();let maximum:Int64=name=="guard" ? 0:["receipt","checkpoint"].contains(name) ? 16384:150000;guard fstat(file,&s)==0,s.st_mode&S_IFMT==S_IFREG,s.st_uid==getuid(),s.st_mode&0o777==0o600,s.st_nlink==1,s.st_size<=maximum else {throw CloudFailure("Invalid acceptance budget file")};total+=s.st_size}
    guard total<=332768 else {throw CloudFailure("Acceptance budget exceeded")}
}
final class AcceptanceOwnership {
    let workspace:AcceptanceChain;let files:AcceptanceChain;let quota:AcceptanceChain;var guardFD:Int32 = -1;var machine:String = ""
    let spec:[String:Any];var origin:[String:Any]=[:];var value:[String:Any]=[:];var previous:[String:Any]?;var receiptFD:Int32 = -1;var committed=Data();var receiptHeader:[String:Any]=[:];let io:AcceptanceIO
    init(workspace descriptor:[String:Any],spec:[String:Any],binding:CloudBinding,generation:String,parent:[String],role:String,machine:() throws -> String,io:AcceptanceIO = .system) throws {
        self.io=io
        guard Set(descriptor.keys)==Set(["path","identity","receipts","quota"]),let path=descriptor["path"] as? String,!generation.isEmpty,generation.utf8.count<=128 else {throw CloudFailure("Invalid acceptance workspace")}
        self.spec=spec;workspace=try AcceptanceChain(path);files=try AcceptanceChain(path+"/acceptance");quota=try AcceptanceChain(path+"/quota")
        for (chain,key) in [(workspace,"identity"),(files,"receipts"),(quota,"quota")] {try chain.requirePrivate();guard let expected=descriptor[key] as? [String:String],try acceptanceLocalDescriptor(URL(fileURLWithPath:chain.path))==expected else {throw CloudFailure("Acceptance workspace changed")}}
        try acceptanceAbsent(files.fd,"checkpoint")
        receiptFD=openat(files.fd,"receipt",O_RDWR|O_APPEND|O_NOFOLLOW|O_NONBLOCK|O_CLOEXEC)
        let prior:[String:Any]?
        if receiptFD>=0 {let (header,value,bytes)=try acceptanceReceipt(receiptFD);receiptHeader=header;committed=bytes;prior=value;try acceptanceOriginalEntry(files.fd,"receipt",receiptFD,bytes)}else {guard errno==ENOENT else {throw CloudFailure("Original receipt unavailable")};prior=nil}
        let fd=openat(files.fd,"guard",O_RDWR|O_NOFOLLOW|O_NONBLOCK|O_CLOEXEC|(prior==nil ? O_CREAT|O_EXCL:0),0o600)
        guard fd>=0 else {throw CloudFailure("Original acceptance guard unavailable")}
        var info=stat();guard fstat(fd,&info)==0,info.st_mode&S_IFMT==S_IFREG,info.st_uid==getuid(),info.st_mode&0o777==0o600,info.st_nlink==1,info.st_size==0,flock(fd,LOCK_EX|LOCK_NB)==0 else {close(fd);throw CloudFailure("Acceptance guard unavailable")}
        guardFD=fd
        do {self.machine=try machine();origin=["physical":digest(Data("heed-qa-origin-v1/\(self.machine)".utf8)),"workspace":try acceptanceIdentity(workspace.fd),"receipts":try acceptanceIdentity(files.fd),"guard":try acceptanceIdentity(fd)]
            let bindingEncoder=JSONEncoder();bindingEncoder.outputFormatting = .sortedKeys;let bindingData=try bindingEncoder.encode(binding)
            let parentObject=try acceptanceBindingObject(binding)
            let parentFile:[String:Any]
            if let prior=prior,let saved=prior["parentFile"] as? [String:Any] {guard try acceptanceEqual(acceptanceVerifiedBinding(files.fd,"parent-binding",saved),parentObject) else {throw CloudFailure("Original parent binding changed")};parentFile=saved}
            else if prior==nil {parentFile=try acceptanceExclusiveBinding(files.fd,"parent-binding",parentObject)}
            else {throw CloudFailure("Original parent binding unavailable")}
            var initial:[String:Any]=["parentFile":parentFile,"version":2,"role":role,"spec":spec,"bindingHash":digest(bindingData),"generation":generation,"parent":parent,"origin":origin]
            if let prior=prior {guard Set(prior.keys)==Set(initial.keys).union(["phase","child","childGeneration","childFile"]),initial.allSatisfy({key,item in acceptanceEqual([key:item],[key:prior[key] as Any])}),let phase=prior["phase"] as? String,(role=="creator" ? ["prepared","allocating","allocated","initialized"]:["prepared","joined"]).contains(phase),let childGeneration=prior["childGeneration"] as? String,UUID(uuidString:childGeneration) != nil else {throw CloudFailure("Original acceptance receipt required")};value=prior;previous=prior}
            else {initial["phase"]="prepared";initial["child"]=NSNull();initial["childFile"]=NSNull();initial["childGeneration"]=UUID().uuidString.lowercased();value=initial;previous=nil;guard fsync(fd)==0,fsync(files.fd)==0 else {throw CloudFailure("Acceptance guard checkpoint failed")}}
        } catch {throw error}
        if prior==nil {receiptFD=openat(files.fd,"receipt",O_RDWR|O_APPEND|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC,0o600);guard receiptFD>=0 else {throw CloudFailure("Exclusive original receipt required")};let scope=value.filter{!["phase","child","childFile"].contains($0.key)};receiptHeader=["format":"heed-qa-receipt","version":2,"identity":try acceptanceIdentity(receiptFD),"scope":scope]}
        try check();if prior==nil {try save()}else {try io.sync(receiptFD);try io.sync(files.fd);try check()}
    }
    deinit {if receiptFD>=0 {close(receiptFD)};if guardFD>=0 {close(guardFD)}}
    func budget() throws {try acceptanceBudget(workspace:workspace,files:files,quota:quota,spec:spec)}

    func check() throws {
        for chain in [workspace,files,quota] {try chain.check();try chain.requirePrivate()}
        guard try acceptanceIdentity(workspace.fd)==origin["workspace"] as? String,try acceptanceIdentity(files.fd)==origin["receipts"] as? String,try acceptanceIdentity(guardFD)==origin["guard"] as? String else {throw CloudFailure("Acceptance origin changed")}
        let fd=openat(files.fd,"guard",O_RDONLY|O_NOFOLLOW|O_NONBLOCK|O_CLOEXEC);guard fd>=0 else {throw CloudFailure("Acceptance guard changed")};defer {close(fd)};guard try acceptanceIdentity(fd)==origin["guard"] as? String else {throw CloudFailure("Acceptance guard changed")}
        try budget()
        guard let parentFile=value["parentFile"] as? [String:Any] else {throw CloudFailure("Parent binding receipt required")};_=try acceptanceVerifiedBinding(files.fd,"parent-binding",parentFile)
        if let childFile=value["childFile"] as? [String:Any] {_=try acceptanceVerifiedBinding(files.fd,"child-binding",childFile)}else {try acceptanceAbsent(files.fd,"child-binding")}
        try acceptanceOriginalEntry(files.fd,"receipt",receiptFD,committed)
    }
    func save() throws {
        try check();try acceptanceAbsent(files.fd,"checkpoint")
        if let previous=previous,acceptanceEqual(previous,value) {return}
        let scope=value.filter{!["phase","child","childFile"].contains($0.key)}
        guard let originalScope=receiptHeader["scope"] as? [String:Any],acceptanceEqual(scope,originalScope) else {throw CloudFailure("Immutable receipt scope changed")}
        let phases=value["role"] as? String=="creator" ? ["prepared","allocating","allocated","initialized"]:["prepared","joined"]
        let count=committed.isEmpty ? 0:committed.split(separator:10).count-1
        guard count<phases.count,value["phase"] as? String==phases[count] else {throw CloudFailure("Invalid receipt phase transition")}
        let record=value.filter{["phase","child","childFile"].contains($0.key)}
        var addition=committed.isEmpty ? try acceptanceCanonical(receiptHeader)+Data([10]):Data();addition += try acceptanceCanonical(record)+Data([10])
        let expected=committed+addition;guard expected.count<=16384 else {throw CloudFailure("Receipt append bound exceeded")}
        try io.append(receiptFD,addition);try io.sync(receiptFD);try io.sync(files.fd)
        try acceptanceOriginalEntry(files.fd,"receipt",receiptFD,expected)
        let (_,actual,raw)=try acceptanceReceipt(receiptFD);guard acceptanceEqual(actual,value),raw==expected else {throw CloudFailure("Receipt append unverified")}
        committed=expected;previous=value;try check()
    }
}
func acceptancePreflight(workspace descriptor:[String:Any],spec:[String:Any],binding:CloudBinding,generation:String,role:String,machine:() throws -> String) throws {
    guard Set(descriptor.keys)==Set(["path","identity","receipts","quota"]),let path=descriptor["path"] as? String else {throw CloudFailure("Invalid acceptance workspace")}
    let workspace=try AcceptanceChain(path),files=try AcceptanceChain(path+"/acceptance"),quota=try AcceptanceChain(path+"/quota")
    for (chain,key) in [(workspace,"identity"),(files,"receipts"),(quota,"quota")] {try chain.requirePrivate();guard let expected=descriptor[key] as? [String:String],try acceptanceLocalDescriptor(URL(fileURLWithPath:chain.path))==expected else {throw CloudFailure("Acceptance workspace changed")}}
    try acceptanceBudget(workspace:workspace,files:files,quota:quota,spec:spec);try acceptanceAbsent(files.fd,"checkpoint")
    if let prior=try acceptanceReadReceipt(files.fd) {
        guard let parent=prior["parent"] as? [String] else {throw CloudFailure("Original acceptance parent required")}
        let receipt=try AcceptanceOwnership(workspace:descriptor,spec:spec,binding:binding,generation:generation,parent:parent,role:role,machine:machine)
        try receipt.check();guard receipt.value["phase"] as? String != "allocating" else {throw CloudFailure("Ambiguous allocation retained")}
    } else {for name in ["guard","parent-binding","child-binding"] {try acceptanceAbsent(files.fd,name)}}
}
func acceptanceBootstrap(action:String,binding:CloudBinding,generation:String,spec raw:[String:Any],workspace:[String:Any],evidence:[String:Any]?,environment:AcceptanceEnvironment = .system,machine:() throws -> String = acceptanceMachine,io:AcceptanceIO = .system) throws -> [String:Any] {
    let spec=try acceptanceSpec(raw),creator=action=="qa-create-child",role=creator ? "creator":"participant",component=spec["child"] as! String,destination=spec["destinationId"] as! String
    guard ["qa-create-child","qa-join-child"].contains(action) else {throw CloudFailure("Invalid acceptance action")}
    if !creator {var expected:[String:Any]=["initialized":true];for key in ["runId","destinationId","provider","destinationVersion","child"] {expected[key]=spec[key]};guard let evidence=evidence,acceptanceEqual(evidence,expected) else {throw CloudFailure("Successful creator evidence required")}}
    try acceptancePreflight(workspace:workspace,spec:spec,binding:binding,generation:generation,role:role,machine:machine)
    return try withAcceptanceParent(binding,environment:environment) {root,parent,validate in
        guard creator || root.lastPathComponent==component else {throw CloudFailure("Select the exact synthetic child")}
        guard !creator || parent.descriptors.count<64 else {throw CloudFailure("Acceptance ancestry bound exceeded")}
        let receipt=try AcceptanceOwnership(workspace:workspace,spec:spec,binding:binding,generation:generation,parent:parent.identities,role:role,machine:machine,io:io)
        guard receipt.value["phase"] as? String != "allocating" else {throw CloudFailure("Ambiguous allocation retained")}
        try receipt.check();try validate()
        let allocating=creator && receipt.value["phase"] as? String=="prepared"
        if allocating {receipt.value["phase"]="allocating";try receipt.save();try validate();try receipt.check();guard mkdirat(parent.fd,component,0o700)==0 else {throw CloudFailure("Exclusive acceptance child unavailable")};guard fsync(parent.fd)==0 else {throw CloudFailure("Acceptance allocation uncertain")}}
        let childURL=creator ? root.appendingPathComponent(component):root,child=try AcceptanceChain(childURL.path)
        let check:() throws -> Void = {try validate();try receipt.check();try child.check()}
        try check();let childIdentity=try acceptanceIdentity(child.fd)
        if allocating {receipt.value["child"]=childIdentity;receipt.value["phase"]="allocated";try receipt.save()}
        else if creator || receipt.value["phase"] as? String=="joined" {guard receipt.value["child"] as? String==childIdentity else {throw CloudFailure("Original allocated child changed")}}
        let temporaryBinding=CloudBinding(bookmark:"",account:binding.account,identity:try descriptorIdentity(child.fd))
        var actual=try coordinated(childURL,binding:temporaryBinding,write:false){files in try check();return try header(files)}
        if creator && receipt.value["phase"] as? String=="allocated" && actual==nil {actual=try coordinated(childURL,binding:temporaryBinding,temporary:".heed-library-create.pending",write:true){files in try check();return try createHeader(files,id:destination,version:2,validate:check)}}
        guard actual?["destinationId"] as? String==destination,actual?["schemaVersion"] as? Int==2 else {throw CloudFailure("Actual acceptance header required")}
        try check()
        let result:[String:Any]
        if let saved=receipt.value["childFile"] as? [String:Any] {
            result=try acceptanceVerifiedBinding(receipt.files.fd,"child-binding",saved)
            let bytes=try JSONSerialization.data(withJSONObject:result);let previousBinding=try JSONDecoder().decode(CloudBinding.self,from:bytes)
            guard previousBinding.identity==temporaryBinding.identity,previousBinding.account==binding.account else {throw CloudFailure("Original child binding changed")}
            _=try withAcceptanceParent(previousBinding,environment:environment) {url,chain,validate in try validate();guard url.path==childURL.path,try acceptanceIdentity(chain.fd)==childIdentity else {throw CloudFailure("Original child bookmark changed")};return true}
        } else {
            let bookmark=try childURL.bookmarkData(options:.withSecurityScope,includingResourceValuesForKeys:nil,relativeTo:nil);try check()
            result=try acceptanceBindingObject(CloudBinding(bookmark:bookmark.base64EncodedString(),account:binding.account,identity:try descriptorIdentity(child.fd)))
            receipt.value["childFile"]=try acceptanceExclusiveBinding(receipt.files.fd,"child-binding",result)
        }
        receipt.value["child"]=childIdentity;receipt.value["phase"]=creator ? "initialized":"joined";try receipt.save();try check()

        return ["role":role,"binding":result,"generation":receipt.value["childGeneration"] as Any,"phase":receipt.value["phase"] as Any,"cleanup":"retained-owned-child-and-immutable-audio"]
    }
}
