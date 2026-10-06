import Foundation
import Darwin

struct ServiceNoticeInfo: Codable {
 let service:String
 let port:Int
 let state:String
 let application:String?
 // Unknown inspection never overrides the fresh identity-protected controller.
 // A failed controller poll still clears that state.
 var blocksVerifiedStart:Bool { ["api","transcription"].contains(service) && !["ready","unavailable"].contains(state) }
 static func permitsVerifiedStart(_ notices:[ServiceNoticeInfo],freshController:Bool)->Bool {
  !notices.contains{$0.blocksVerifiedStart} && (freshController || !notices.contains{["api","transcription"].contains($0.service) && $0.state == "unavailable"})
 }
 static func decode(_ data:Data,ports:[String:Int])->[ServiceNoticeInfo]? {
  guard data.count <= 8192, let objects = try? JSONSerialization.jsonObject(with:data) as? [[String:Any]],objects.count == 3,
        objects.allSatisfy({Set($0.keys).isSubset(of:["service","port","state","application"])}),
        let values = try? JSONDecoder().decode([ServiceNoticeInfo].self,from:data),Set(values.map{$0.service}) == Set(ports.keys) else{return nil}
  for value in values {
   guard value.port == ports[value.service], ["ready","stopped","starting","unhealthy","conflict","unavailable"].contains(value.state) else{return nil}
   if let name=value.application {guard value.state == "conflict",name.range(of:#"^[A-Za-z][A-Za-z0-9._-]{0,63}$"#,options:.regularExpression) != nil else{return nil}}
  }
  return values
 }
 func message(locale:String)->String {
  let role = MenuLocalization.text(service == "api" ? "Heed API" : service == "ui" ? "Heed interface" : "Transcription engine",locale:locale)
  let keys=["conflict":"Another application is using %@ port %@.","stopped":"%@ is stopped on port %@.","starting":"%@ is starting on port %@.","unhealthy":"%@ is not healthy on port %@.","unavailable":"Could not diagnose %@ on port %@."]
  let summary = String(format:MenuLocalization.text(keys[state] ?? "Could not diagnose %@ on port %@.",locale:locale),role,String(port))
  return summary + (application.map{" " + MenuLocalization.format("Application: %@",locale:locale,value:$0)} ?? "")
 }
 static func recovery(locale:String)->String { MenuLocalization.text("Heed preserved the other application. Stop it yourself, or configure a free allowed Heed port and retry startup. Installed app and LaunchAgent port settings must match; rerun the idle installer with those settings if necessary.",locale:locale) }
}

/// The same local helper works when both web services are unavailable. Output is bounded and contains no process details.
final class NativeServiceDiagnostics {
 private let queue = DispatchQueue(label:"heed.service-diagnostics")
 private var cached: (String,Date,[ServiceNoticeInfo])?
 func check(endpoints:ServiceEndpoints,refresh:Bool=false,completion:@escaping([ServiceNoticeInfo])->Void) {
  queue.async {
   let environment=endpoints.launchEnvironment(base:ProcessInfo.processInfo.environment)
   var ports=["api":endpoints.apiPort,"ui":endpoints.uiPort,"transcription":endpoints.transcriptionPort]
   if let raw=environment["HEED_TRANSCRIPTION_URL"],let url=URL(string:raw){ports["transcription"]=url.port ?? (url.scheme == "https" ? 443 : 80)}
   let context=endpoints.checkoutRoot + ports.sorted{$0.key<$1.key}.description + (environment["HEED_TRANSCRIPTION_URL"] ?? "")
   if !refresh,let cached=self.cached,cached.0 == context,Date().timeIntervalSince(cached.1) >= 0,Date().timeIntervalSince(cached.1)<5 {completion(cached.2);return}
   let process=Process(),output=Pipe()
   process.executableURL=URL(fileURLWithPath:"/usr/bin/python3")
   process.arguments=[endpoints.checkoutRoot+"/scripts/service_diagnostics.py","--root",endpoints.checkoutRoot]+(refresh ? ["--refresh"] : [])
   process.currentDirectoryURL=URL(fileURLWithPath:endpoints.checkoutRoot)
   process.environment=environment;process.standardOutput=output;process.standardError=FileHandle.nullDevice
   func stopOwnedHelper(){
    guard process.isRunning,process.processIdentifier>1 else{return}
    let pid=process.processIdentifier
    // Only this tracked child's freshly verified private process group may be signalled.
    if getpgid(pid) == pid{kill(-pid,SIGKILL)}else{kill(pid,SIGKILL)}
   }
   var notices:[ServiceNoticeInfo]?
   do {
    try process.run()
    defer{stopOwnedHelper();process.waitUntilExit();try? output.fileHandleForReading.close()}
    try output.fileHandleForWriting.close()
    let descriptor=output.fileHandleForReading.fileDescriptor
    guard fcntl(descriptor,F_SETFL,fcntl(descriptor,F_GETFL)|O_NONBLOCK) != -1 else{throw NSError(domain:"Diagnostics unavailable",code:1)}
    var data=Data()
    let deadline=ProcessInfo.processInfo.systemUptime+6
    var eof=false
    while data.count <= 8192 && (!eof || process.isRunning) {
        // An exited helper's unverified descendant may retain stdout. Never
        // block this queue or signal a group after its tracked leader exits.
        guard ProcessInfo.processInfo.systemUptime<deadline else{throw NSError(domain:"Diagnostics unavailable",code:1)}
        if eof{Thread.sleep(forTimeInterval:0.02);continue}
        var descriptorState=pollfd(fd:descriptor,events:Int16(POLLIN|POLLHUP),revents:0)
        let available=poll(&descriptorState,1,50)
        if available<0{if errno==EINTR{continue};throw NSError(domain:"Diagnostics unavailable",code:1)}
        if available==0{continue}
        var bytes=[UInt8](repeating:0,count:min(4096,8193-data.count))
        let count=bytes.withUnsafeMutableBytes{Darwin.read(descriptor,$0.baseAddress,$0.count)}
        if count>0{data.append(contentsOf:bytes.prefix(count))}
        else if count==0{eof=true}
        else if errno != EAGAIN && errno != EINTR{throw NSError(domain:"Diagnostics unavailable",code:1)}
    }
    if data.count > 8192{stopOwnedHelper()}
    process.waitUntilExit()
    if process.terminationStatus == 0 {notices=ServiceNoticeInfo.decode(data,ports:ports)}
   }catch {/* Raw process errors are never shown to the user. */}
   let result=notices ?? ports.sorted{$0.key<$1.key}.map{ServiceNoticeInfo(service:$0.key,port:$0.value,state:"unavailable",application:nil)}
   self.cached=(context,Date(),result);completion(result)
  }
 }
}
