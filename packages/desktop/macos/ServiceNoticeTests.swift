import Foundation
import Darwin

func serviceNoticeSelfTests() throws {
 let ports = ["api":48100,"ui":48101,"transcription":48102]
 let fixture: [[String:Any]] = [["service":"api","port":48100,"state":"conflict","application":"Ruby"],["service":"ui","port":48101,"state":"stopped"],["service":"transcription","port":48102,"state":"starting"]]
 let data = try JSONSerialization.data(withJSONObject:fixture)
 let notices = ServiceNoticeInfo.decode(data,ports:ports)!
 precondition(notices.count == 3)
 for locale in MenuLocalization.locales {
  let text = notices[0].message(locale:locale)
  precondition(text.contains("48100") && text.contains("Ruby") && !text.contains("/private"))
  if locale != "en" {precondition(!text.contains("Another application"))}
  precondition(!ServiceNoticeInfo.recovery(locale:locale).isEmpty)
 }
 precondition(notices[1].message(locale:"en").contains("stopped"))
 precondition(notices[2].message(locale:"en").contains("starting"))
 precondition(!ServiceNoticeInfo(service:"api",port:48100,state:"unavailable",application:nil).blocksVerifiedStart)
 precondition(!ServiceNoticeInfo(service:"transcription",port:48102,state:"unavailable",application:nil).blocksVerifiedStart)
 precondition(ServiceNoticeInfo(service:"transcription",port:48102,state:"conflict",application:nil).blocksVerifiedStart)
 let unknown=[ServiceNoticeInfo(service:"api",port:48100,state:"unavailable",application:nil)]
 precondition(ServiceNoticeInfo.permitsVerifiedStart(unknown,freshController:true))
 precondition(!ServiceNoticeInfo.permitsVerifiedStart(unknown,freshController:false))
 for name in ["/private/Ruby","token=secret","Ruby\n"] {
  var invalid=fixture;invalid[0]["application"]=name
  let body=try JSONSerialization.data(withJSONObject:invalid)
  precondition(ServiceNoticeInfo.decode(body,ports:ports) == nil)
 }
 for invalid in [
  fixture.map{ var value=$0;value["cwd"]="/private/account";return value },
  [["service":"api","port":48100,"state":"conflict","application":"/private/Ruby"]],
  [["service":"api","port":5001,"state":"conflict"]],
  [["service":"api","port":48100,"state":"conflict","application":"token=secret"]],
  [["service":"api","port":48100,"state":"conflict"],["service":"api","port":48100,"state":"ready"],["service":"transcription","port":48102,"state":"ready"]]
 ] {let body=try JSONSerialization.data(withJSONObject:invalid);precondition(ServiceNoticeInfo.decode(body,ports:ports) == nil)}
 precondition(ServiceNoticeInfo.decode(Data("<html>Other app</html>".utf8),ports:ports) == nil)
 precondition(ServiceNoticeInfo.decode(Data(repeating:65,count:8193),ports:ports) == nil)
 try serviceNoticeChildCleanupTest()
 try serviceNoticeExitedParentTest()
}

private func serviceNoticeExitedParentTest() throws {
 let root=FileManager.default.temporaryDirectory.appendingPathComponent("heed-notice-exited-"+UUID().uuidString)
 try FileManager.default.createDirectory(at:root.appendingPathComponent("scripts"),withIntermediateDirectories:true)
 defer{try? FileManager.default.removeItem(at:root)}
 let previous=ProcessInfo.processInfo.environment["HEED_APP_DIR"]
 setenv("HEED_APP_DIR",root.path,1)
 defer{if let previous=previous{setenv("HEED_APP_DIR",previous,1)}else{unsetenv("HEED_APP_DIR")}}
 let script=root.appendingPathComponent("scripts/service_diagnostics.py")
 try Data("""
 import os,pathlib,subprocess,sys
 if os.getpgrp() != os.getpid():os.setsid()
 child=subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)'])
 pathlib.Path(os.environ['HEED_APP_DIR'],'child-pid').write_text(str(child.pid))
 """.utf8).write(to:script)
 let config=Data("{\"api\":48100,\"ui\":48101,\"transcription\":48102,\"forbiddenRanges\":[[3000,3999],[5000,5999],[7000,7999],[8000,8999]]}".utf8)
 let endpoints=try ServiceEndpoints.resolve(configData:config,checkoutRoot:root.path,environment:[:])
 let diagnostics=NativeServiceDiagnostics()
 var result:[ServiceNoticeInfo]?
 diagnostics.check(endpoints:endpoints,refresh:true){values in DispatchQueue.main.async{result=values}}
 let deadline=Date().addingTimeInterval(8)
 while result==nil && Date()<deadline{RunLoop.current.run(until:Date().addingTimeInterval(0.01))}
 guard let child=Int32(try String(contentsOf:root.appendingPathComponent("child-pid"),encoding:.utf8)),child>1 else{throw NSError(domain:"Diagnostic child fixture missing",code:1)}
 defer{if kill(child,0)==0{kill(child,SIGKILL)}}
 guard result?.allSatisfy({$0.state == "unavailable"})==true else{throw NSError(domain:"Exited helper blocked diagnostics",code:1)}
 precondition(kill(child,0)==0,"An unverified descendant after leader exit must be preserved")
 try Data("print('[]')\n".utf8).write(to:script)
 result=nil
 diagnostics.check(endpoints:endpoints,refresh:true){values in DispatchQueue.main.async{result=values}}
 let next=Date().addingTimeInterval(2)
 while result==nil && Date()<next{RunLoop.current.run(until:Date().addingTimeInterval(0.01))}
 guard result?.allSatisfy({$0.state == "unavailable"})==true else{throw NSError(domain:"Diagnostics queue did not recover",code:1)}
}

private func serviceNoticeChildCleanupTest() throws {
 let root=FileManager.default.temporaryDirectory.appendingPathComponent("heed-notice-child-"+UUID().uuidString)
 try FileManager.default.createDirectory(at:root.appendingPathComponent("scripts"),withIntermediateDirectories:true)
 defer{try? FileManager.default.removeItem(at:root)}
 let previous=ProcessInfo.processInfo.environment["HEED_APP_DIR"]
 setenv("HEED_APP_DIR",root.path,1)
 defer{if let previous=previous{setenv("HEED_APP_DIR",previous,1)}else{unsetenv("HEED_APP_DIR")}}
 let fixture="""
 import os,pathlib,subprocess,sys,time
 if os.getpgrp() != os.getpid():os.setsid()
 child=subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)'])
 pathlib.Path(os.environ['HEED_APP_DIR'],'child-pid').write_text(str(child.pid))
 sys.stdout.write('x'*9000);sys.stdout.flush()
 time.sleep(60)
 """
 try Data(fixture.utf8).write(to:root.appendingPathComponent("scripts/service_diagnostics.py"))
 let config=Data("{\"api\":48100,\"ui\":48101,\"transcription\":48102,\"forbiddenRanges\":[[3000,3999],[5000,5999],[7000,7999],[8000,8999]]}".utf8)
 let endpoints=try ServiceEndpoints.resolve(configData:config,checkoutRoot:root.path,environment:[:])
 var result:[ServiceNoticeInfo]?
 NativeServiceDiagnostics().check(endpoints:endpoints,refresh:true){values in DispatchQueue.main.async{result=values}}
 let deadline=Date().addingTimeInterval(10)
 while result == nil && Date()<deadline{RunLoop.current.run(until:Date().addingTimeInterval(0.01))}
 guard result?.allSatisfy({$0.state == "unavailable"}) == true,
       let child=Int32(try String(contentsOf:root.appendingPathComponent("child-pid"),encoding:.utf8)),child>1 else{throw NSError(domain:"Diagnostic fixture did not complete",code:1)}
 defer{if kill(child,0) == 0{kill(child,SIGKILL)}}
 let reaping=Date().addingTimeInterval(2)
 while kill(child,0) == 0 && Date()<reaping{RunLoop.current.run(until:Date().addingTimeInterval(0.01))}
 guard kill(child,0) != 0 else{throw NSError(domain:"Owned diagnostic descendant survived helper cleanup",code:1)}
}
