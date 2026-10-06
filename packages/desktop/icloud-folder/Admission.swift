import Foundation
import CryptoKit
import IOKit
import Darwin

/** A private original-inode receipt permits local recovery, never adoption of matching replicas. */
final class CloudAdmission {
    private let directory:Int32
    private let name:String
    private let scope:[String:Any]
    private var receipt:[String:Any]?
    init(privateRoot:String,generation:String,remoteIdentity:String,path:String,bytes:Int,hash:String) throws {
        guard privateRoot.hasPrefix("/"),generation.range(of:"^[A-Za-z0-9_-]{1,128}$",options:.regularExpression) != nil,bytes>0,bytes<=65536,path.hasSuffix("/manifest.json"),hash.range(of:"^[a-f0-9]{64}$",options:.regularExpression) != nil else {throw CloudFailure("Invalid original admission scope")}
        _=try artifactPath(path)
        let root=URL(fileURLWithPath:privateRoot).standardizedFileURL
        guard root.resolvingSymlinksInPath().path==root.path else {throw CloudFailure("Unsafe private admission root")}
        let rootFD=open(root.path,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);guard rootFD>=0 else {throw CloudFailure("Private admission root unavailable")};defer {close(rootFD)}
        let service=IOServiceGetMatchingService(kIOMainPortDefault,IOServiceMatching("IOPlatformExpertDevice"));guard service != 0 else {throw CloudFailure("Admission device identity unavailable")};defer {IOObjectRelease(service)}
        guard let hardware=IORegistryEntryCreateCFProperty(service,"IOPlatformUUID" as CFString,kCFAllocatorDefault,0)?.takeRetainedValue() as? String,!hardware.isEmpty else {throw CloudFailure("Admission device identity unavailable")}
        // Raw hardware identity never enters the journal, portable data, API, or logs.
        let origin=digest(Data("\(hardware)/\(root.path)/\(try descriptorIdentity(rootFD))".utf8))
        var current=dup(rootFD);guard current>=0 else {throw CloudFailure("Private admission unavailable")}
        do {for part in ["library","catalog","icloud-admissions"] {guard mkdirat(current,part,0o700)==0||errno==EEXIST else {throw CloudFailure("Private admission unavailable")};let next=openat(current,part,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);guard next>=0 else {throw CloudFailure("Unsafe admission directory")};close(current);current=next}}
        catch {close(current);throw error}
        directory=current
        scope=["version":1,"origin":origin,"directory":try descriptorIdentity(directory),"generation":generation,"remoteIdentity":remoteIdentity,"path":path,"bytes":bytes,"sha256":hash]
        let encoded=try JSONSerialization.data(withJSONObject:scope,options:[.sortedKeys]);name=digest(encoded)+".json"
        guard let entries=fdopendir(dup(directory)) else {close(directory);throw CloudFailure("Admission inventory unavailable")};var count=0;while let _=readdir(entries){count+=1;guard count<=20002 else {closedir(entries);close(directory);throw CloudFailure("Private admission limit reached")}};closedir(entries)
        let file=openat(directory,name,O_RDONLY|O_NOFOLLOW|O_CLOEXEC)
        if file>=0 {defer {close(file)};var info=stat();guard fstat(file,&info)==0,info.st_mode&S_IFMT==S_IFREG,info.st_nlink==1,info.st_size>0,info.st_size<=4096 else {throw CloudFailure("Unsafe admission receipt")};var buffer=[UInt8](repeating:0,count:Int(info.st_size));guard Darwin.read(file,&buffer,buffer.count)==buffer.count,let value=try JSONSerialization.jsonObject(with:Data(buffer)) as? [String:Any],value.count==scope.count+4 else {throw CloudFailure("Invalid admission receipt")};for (key,item) in scope {guard NSDictionary(dictionary:[key:item]).isEqual(to:[key:value[key] as Any]) else {throw CloudFailure("Changed admission scope")}};receipt=value}
        else if errno != ENOENT {throw CloudFailure("Admission receipt unavailable")}
    }
    deinit {close(directory)}
    func matches(_ fd:Int32) throws -> Bool {
        guard let receipt=receipt else {return false};var info=stat();guard fstat(fd,&info)==0,info.st_mode&S_IFMT==S_IFREG,info.st_nlink==1 else {throw CloudFailure("Unsafe admitted inode")}
        return receipt["device"] as? UInt64 == UInt64(info.st_dev) && receipt["inode"] as? UInt64 == UInt64(info.st_ino) && receipt["birthSeconds"] as? Int64 == Int64(info.st_birthtimespec.tv_sec) && receipt["birthNanos"] as? Int64 == Int64(info.st_birthtimespec.tv_nsec)
    }
    func prepare(_ fd:Int32) throws {
        if receipt != nil {guard try matches(fd) else {throw CloudFailure("Original admission inode is unavailable; preserve its receipt")};return}
        var info=stat();guard fstat(fd,&info)==0,info.st_mode&S_IFMT==S_IFREG,info.st_nlink==1 else {throw CloudFailure("Unsafe staged admission")}
        var value=scope;value["device"]=UInt64(info.st_dev);value["inode"]=UInt64(info.st_ino);value["birthSeconds"]=Int64(info.st_birthtimespec.tv_sec);value["birthNanos"]=Int64(info.st_birthtimespec.tv_nsec)
        let data=try JSONSerialization.data(withJSONObject:value,options:[.sortedKeys]),temporary=".admission-\(UUID().uuidString).pending"
        let file=openat(directory,temporary,O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC,0o600);guard file>=0 else {throw CloudFailure("Cannot reserve original admission")};defer {close(file);unlinkat(directory,temporary,0)}
        try data.withUnsafeBytes {pointer in var offset=0;while offset<data.count {let size=Darwin.write(file,pointer.baseAddress!.advanced(by:offset),data.count-offset);guard size>0 else {throw CloudFailure("Admission receipt write failed")};offset+=size}}
        guard fsync(file)==0,renameatx_np(directory,temporary,directory,name,UInt32(RENAME_EXCL))==0,fsync(directory)==0 else {throw CloudFailure("Admission receipt checkpoint failed")};receipt=value
    }
}
