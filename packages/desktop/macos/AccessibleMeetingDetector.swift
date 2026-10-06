import AppKit
import ApplicationServices
import Foundation

struct AccessibleMeetingEvidence {
    let buttons: Set<String>
    let complete: Bool
    let destroyed: Bool
    static func normalize(_ text: String) -> String { text.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
    static let leave = Set(["end", "end meeting", "leave", "leave meeting", "leave call", "hang up", "sair", "sair da reunião", "sair da chamada", "desligar", "quitter", "quitter la réunion", "quitter l’appel", "raccrocher", "verlassen", "meeting verlassen", "besprechung verlassen", "anruf beenden"])
    static let microphone = Set(["mute my audio", "unmute my audio", "mute", "unmute", "mute audio", "unmute audio", "mute mic", "unmute mic", "mute microphone", "unmute microphone", "silenciar", "ativar som", "desativar som", "ativar microfone", "desativar microfone", "silenciar microfone", "reativar microfone", "couper le micro", "activer le micro", "désactiver le micro", "rétablir le son", "stumm schalten", "stummschaltung aufheben", "mikrofon aktivieren", "mikrofon deaktivieren"])
    static let camera = Set(["start my video", "stop my video", "start video", "stop video", "turn camera on", "turn camera off", "camera", "iniciar vídeo", "parar vídeo", "ativar câmera", "desativar câmera", "câmera", "démarrer la vidéo", "arrêter la vidéo", "activer la caméra", "désactiver la caméra", "caméra", "video starten", "video beenden", "kamera einschalten", "kamera ausschalten", "kamera"])
    static let afterCall = Set(["rejoin", "rejoin meeting", "join again", "return to home screen", "voltar a participar", "entrar novamente", "retornar à tela inicial", "rejoindre à nouveau", "revenir à l’accueil", "erneut teilnehmen", "zur startseite zurückkehren"])
    var inCall: Bool { complete && !buttons.isDisjoint(with: Self.leave) && !buttons.isDisjoint(with: Self.microphone) && !buttons.isDisjoint(with: Self.camera) }
    var ended: Bool { destroyed || (complete && !inCall && !buttons.isDisjoint(with: Self.afterCall)) }
}

/// Uses public, user-authorized macOS AX APIs. No actions are performed, and no
/// window titles, chat, participants, URLs, or arbitrary text are retained.
final class AccessibleMeetingDetector {
    let bundleIdentifiers: Set<String>
    private var ownedWindow: AXUIElement?
    private var ownedPID: pid_t?
    private var observer: AXObserver?
    private var destroyed = false
    private var endedCall = false
    init(bundleIdentifiers: Set<String>) { self.bundleIdentifiers = bundleIdentifiers }

    static var authorized: Bool { AXIsProcessTrusted() }
    static func requestAccess() { _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary) }
    private func value(_ element: AXUIElement, _ attribute: String) -> CFTypeRef? {
        var result: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &result) == .success else { return nil }
        return result
    }
    private func evidence(_ window: AXUIElement) -> AccessibleMeetingEvidence {
        var labels = Set<String>(), pending = [window], visited = 0
        var complete = true
        let deadline = ProcessInfo.processInfo.systemUptime + 0.3
        while let element = pending.popLast() {
            visited += 1
            guard visited <= 2500 && ProcessInfo.processInfo.systemUptime < deadline else { complete = false; break }
            // Only inspect action-control labels, never arbitrary text values.
            let role = value(element, kAXRoleAttribute) as? String
            if role == kAXButtonRole || role == kAXMenuButtonRole || role == kAXCheckBoxRole {
                for attr in [kAXTitleAttribute, kAXDescriptionAttribute, kAXHelpAttribute] {
                    if let label = value(element, attr) as? String {
                        let normalized = AccessibleMeetingEvidence.normalize(label)
                        // Labels sometimes include a documented keyboard shortcut suffix.
                        labels.insert(normalized.split(separator: "(", maxSplits: 1).first.map { String($0).trimmingCharacters(in: .whitespaces) } ?? normalized)
                    }
                }
            }
            var children: CFTypeRef?
            let code = AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &children)
            if code == .success, let elements = children as? [AXUIElement] { pending.append(contentsOf: elements) }
            else if code != .noValue && code != .attributeUnsupported { complete = false }
        }
        return AccessibleMeetingEvidence(buttons: labels, complete: complete, destroyed: false)
    }
    private func track(_ window: AXUIElement, pid: pid_t) {
        if let observer = observer { CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .commonModes) }
        self.observer = nil; ownedWindow = window; ownedPID = pid; destroyed = false; endedCall = false
        var created: AXObserver?
        let code = AXObserverCreate(pid, { _, _, notification, context in
            guard notification as String == kAXUIElementDestroyedNotification, let context = context else { return }
            Unmanaged<AccessibleMeetingDetector>.fromOpaque(context).takeUnretainedValue().destroyed = true
        }, &created)
        if code == .success, let observer = created {
            if AXObserverAddNotification(observer, window, kAXUIElementDestroyedNotification as CFString, Unmanaged.passUnretained(self).toOpaque()) == .success {
                self.observer = observer; CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .commonModes)
            }
        }
    }
    /// true requires the leave/microphone/camera controls in the same window.
    /// false requires process exit, destruction of that exact call window, or
    /// an explicit after-call control. Missing/hidden controls remain unknown.
    func poll() -> (Bool?, String) {
        guard Self.authorized else { return (nil, "permission-required") }
        let apps = NSWorkspace.shared.runningApplications.filter { bundleIdentifiers.contains($0.bundleIdentifier ?? "") && !$0.isTerminated }
        if apps.isEmpty { ownedWindow = nil; ownedPID = nil; return (false, "ready") }
        for app in apps {
            let element = AXUIElementCreateApplication(app.processIdentifier)
            AXUIElementSetMessagingTimeout(element, 0.05)
            guard let windows = value(element, kAXWindowsAttribute) as? [AXUIElement] else { continue }
            for window in windows {
                if evidence(window).inCall {
                    if ownedWindow == nil || !CFEqual(ownedWindow, window) { track(window, pid: app.processIdentifier) }
                    return (true, "ready")
                }
            }
        }
        if let pid = ownedPID, !apps.contains(where: { $0.processIdentifier == pid }) { ownedWindow = nil; ownedPID = nil; endedCall = true; return (false, "ready") }
        if destroyed { ownedWindow = nil; ownedPID = nil; destroyed = false; endedCall = true; return (false, "ready") }
        if let owned = ownedWindow, evidence(owned).ended { ownedWindow = nil; ownedPID = nil; endedCall = true; return (false, "ready") }
        if endedCall { return (false, "ready") }
        return (nil, "degraded")
    }
    deinit { if let observer = observer { CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .commonModes) } }
}

/// Keeps identity across a detector restart. A short reconnect is the same
/// call; only a confirmed five-second end permits a fresh call identity.
struct MeetingSignalIdentity {
    private(set) var callId: String?
    private var inactiveSince: TimeInterval?
    init(callId: String? = nil) { self.callId = callId }
    mutating func observe(_ state: Bool?, now: TimeInterval) -> String? {
        if state == true { inactiveSince = nil; if callId == nil { callId = UUID().uuidString }; return callId }
        if state == false {
            if inactiveSince == nil { inactiveSince = now }
            if now - inactiveSince! >= 5 { callId = nil }
        } else { inactiveSince = nil }
        return state == false ? nil : callId
    }
}

func accessibleMeetingDetectorSelfTests() throws {
    func check(_ value: Bool, _ message: String) throws {
        if !value { throw NSError(domain: "AccessibleMeetingDetector", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
    }
    for labels in [["End", "Mute my audio", "Stop my video"], ["Leave", "Mute mic", "Turn camera off"], ["Sair", "Silenciar", "Parar vídeo"], ["Quitter", "Couper le micro", "Arrêter la vidéo"], ["Verlassen", "Stumm schalten", "Video beenden"]] {
        try check(AccessibleMeetingEvidence(buttons: Set(labels.map(AccessibleMeetingEvidence.normalize)), complete: true, destroyed: false).inCall, "Recognize explicit controls in each supported locale")
    }
    for labels in [["Join now", "Mute mic", "Turn camera off"], ["Leave", "Mute mic"], ["Start meeting"], []] {
        let evidence = AccessibleMeetingEvidence(buttons: Set(labels.map(AccessibleMeetingEvidence.normalize)), complete: true, destroyed: false)
        try check(!evidence.inCall && !evidence.ended, "Prejoin, app launch, silence and hidden toolbar are not proof")
    }
    try check(!AccessibleMeetingEvidence(buttons: ["leave", "mute", "camera"], complete: false, destroyed: false).inCall, "A truncated or inaccessible hierarchy must be unknown")
    try check(AccessibleMeetingEvidence(buttons: [], complete: true, destroyed: true).ended, "Only the tracked call window destruction is positive end evidence")
    var identity = MeetingSignalIdentity()
    let call = identity.observe(true, now: 0)
    _ = identity.observe(false, now: 1); try check(identity.observe(true, now: 4) == call, "A transient disconnect is the same call")
    _ = identity.observe(nil, now: 5); try check(identity.observe(true, now: 20) == call, "Unknown access does not change call identity")
    _ = identity.observe(false, now: 21); _ = identity.observe(false, now: 26)
    try check(identity.observe(true, now: 27) != call, "A confirmed leave and rejoin creates a fresh call")
    var restored = MeetingSignalIdentity(callId: call)
    try check(restored.observe(true, now: 100) == call, "Restart retains manual-stop suppression identity")
}
