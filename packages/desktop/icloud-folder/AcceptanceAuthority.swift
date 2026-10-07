/** Existing original authority stays pinned while production providers perform artifact I/O. */
func withExistingAcceptanceAuthority<T>(binding:CloudBinding,generation:String,spec raw:[String:Any],workspace:[String:Any],role:String,environment:AcceptanceEnvironment = .system,machine:() throws -> String = acceptanceMachine,operation:([String:Any],String,@escaping () throws -> Void) throws -> T) throws -> T {
    let spec=try acceptanceSpec(raw)
    guard ["creator","participant"].contains(role),let path=workspace["path"] as? String else {throw CloudFailure("Invalid original authority")}
    let files=try AcceptanceChain(path+"/acceptance");try files.requirePrivate()
    guard let prior=try acceptanceReadReceipt(files.fd),prior["phase"] as? String==(role=="creator" ? "initialized":"joined"),let parent=prior["parent"] as? [String] else {throw CloudFailure("Original completed receipt required")}
    let owner=try AcceptanceOwnership(workspace:workspace,spec:spec,binding:binding,generation:generation,parent:parent,role:role,machine:machine,existingOnly:true)
    try owner.check() // Original physical origin is checked before Foundation resolution.
    return try withAcceptanceParent(binding,environment:environment) {selected,parentChain,validateParent in
        guard parentChain.identities==parent,role=="creator" || selected.lastPathComponent==spec["child"] as? String else {throw CloudFailure("Original selected scope changed")}
        let childURL=role=="creator" ? selected.appendingPathComponent(spec["child"] as! String):selected
        guard let saved=owner.value["childFile"] as? [String:Any],let childGeneration=owner.value["childGeneration"] as? String else {throw CloudFailure("Original child file required")}
        let issued=try acceptanceVerifiedBinding(owner.files.fd,"child-binding",saved),bytes=try JSONSerialization.data(withJSONObject:issued),childBinding=try JSONDecoder().decode(CloudBinding.self,from:bytes)
        return try withAcceptanceParent(childBinding,environment:environment) {resolved,child,validateChild in
            var active=true;defer {active=false}
            let check:() throws -> Void = {
                guard active else {throw CloudFailure("Original authority closed")}
                try validateParent();try owner.check();try validateChild()
                guard resolved.path==childURL.path,try acceptanceIdentity(child.fd)==owner.value["child"] as? String,childBinding.account==binding.account else {throw CloudFailure("Original child changed")}
                let actual=try coordinated(resolved,binding:childBinding,write:false){try header($0)}
                guard actual?["destinationId"] as? String==spec["destinationId"] as? String,acceptanceInteger(actual?["schemaVersion"],2) else {throw CloudFailure("Original actual header changed")}
                try owner.check();try validateParent();try validateChild()
            }
            try check();let result=try operation(issued,childGeneration,check);try check();return result
        }
    }
}
func acceptanceAuthorityFrame(deadline:Double,input:Int32 = STDIN_FILENO) throws -> [String:Any]? {
    var bytes=Data();let controlDeadline=min(deadline,ProcessInfo.processInfo.systemUptime+30)
    while bytes.count<=4096 {
        let remaining=controlDeadline-ProcessInfo.processInfo.systemUptime
        guard remaining>0 else {throw CloudFailure("Authority deadline")}
        var descriptor=pollfd(fd:input,events:Int16(POLLIN),revents:0)
        let result=poll(&descriptor,1,Int32(remaining*1000))
        guard result>0 else {throw CloudFailure("Authority input unavailable")}
        var byte:UInt8=0;let count=Darwin.read(input,&byte,1)
        if count==0 {return nil};guard count==1 else {throw CloudFailure("Authority control unavailable")}
        if byte==10 {guard !bytes.contains(13) else {throw CloudFailure("Invalid control framing")};return try acceptanceJSON(bytes,maximum:4096)}
        bytes.append(byte)
    }
    throw CloudFailure("Authority control bound")
}
func acceptanceAuthorityRuntime(_ request:[String:Any],binding:CloudBinding,generation:String) throws {
    guard let spec=request["spec"] as? [String:Any],let workspace=request["workspace"] as? [String:Any],let role=request["role"] as? String,["creator","participant"].contains(role),request["selectedScope"] as? String==(role=="creator" ? "parent":"child") else {throw CloudFailure("Invalid authority startup")}
    let deadline=ProcessInfo.processInfo.systemUptime+120
    try withExistingAcceptanceAuthority(binding:binding,generation:generation,spec:spec,workspace:workspace,role:role) {issued,childGeneration,verify in
        try dictionaryJSON(["ok":true,"value":["role":role,"binding":issued,"generation":childGeneration]])
        for sequence in 1...513 {
            guard let frame=try acceptanceAuthorityFrame(deadline:deadline) else {return}
            guard Set(frame.keys)==Set(["sequence","action"]),acceptanceInteger(frame["sequence"],sequence) else {throw CloudFailure("Invalid authority sequence")}
            if frame["action"] as? String=="close" {try dictionaryJSON(["sequence":sequence,"ok":true]);return}
            guard sequence<=512,frame["action"] as? String=="check" else {throw CloudFailure("Invalid authority control")}
            try verify();try dictionaryJSON(["sequence":sequence,"ok":true])
        }
    }
}
