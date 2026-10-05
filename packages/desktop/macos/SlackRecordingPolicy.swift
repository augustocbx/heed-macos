import Foundation

/// Política sem acesso à rede. `nil` significa que não foi possível observar o Slack.
struct SlackRecordingPolicy {
    struct Status {
        var recording: Bool
        var processing: Bool
        var pending: Bool
        var starting: Bool
        var ready: Bool
        var clientConnected: Bool
    }

    enum Effect: Equatable {
        case openInterface
        case start(callID: Int)
    }

    var enabled = true
    private(set) var callID = 0
    private var inCall = false
    private var trueSince: TimeInterval?
    private var consumed = false
    private var commandInFlight = false
    private var attempts = 0
    private var retryAfter: TimeInterval = 0
    private var openedAt: TimeInterval?

    /// Chamar no mesmo executor serial que recebe o resultado do comando.
    mutating func evaluate(signal: Bool?, status: Status?, now: TimeInterval) -> [Effect] {
        if signal == false {
            inCall = false
            trueSince = nil
            consumed = false
            commandInFlight = false
            attempts = 0
            retryAfter = 0
            openedAt = nil
            return []
        }
        guard signal == true else {
            // Uma observação indisponível não encerra a chamada, mas interrompe
            // a confirmação de início para evitar disparos com evidência antiga.
            trueSince = nil
            return []
        }
        if !inCall {
            inCall = true
            callID += 1
        }
        if let status = status, status.recording || status.starting {
            // Também cobre gravação iniciada manualmente: não reiniciar quando parar.
            consumed = true
        }
        guard enabled else { trueSince = nil; return [] }
        if trueSince == nil { trueSince = now }
        guard let since = trueSince, now - since >= 3,
              !consumed, !commandInFlight, attempts < 3,
              now >= retryAfter, let status = status,
              !status.recording, !status.processing, !status.pending,
              !status.starting, status.ready else { return [] }
        guard status.clientConnected else {
            if openedAt == nil || now - openedAt! >= 15 {
                openedAt = now
                return [.openInterface]
            }
            return []
        }
        commandInFlight = true
        attempts += 1
        return [.start(callID: callID)]
    }

    /// Um HTTP aceito consome a chamada, mesmo enquanto o início está na fila.
    /// Respostas de chamadas antigas não podem alterar uma nova chamada.
    mutating func commandCompleted(callID completedID: Int, accepted: Bool, now: TimeInterval) {
        guard inCall, callID == completedID, commandInFlight else { return }
        commandInFlight = false
        if accepted { consumed = true }
        else { retryAfter = now + 5 }
    }
}

/// Executável sem Slack, modelos ou permissões, pelo modo --self-test do ícone.
func slackRecordingPolicySelfTest() throws {
    struct Failure: Error { let message: String }
    func check(_ value: Bool, _ message: String) throws {
        if !value { throw Failure(message: message) }
    }
    let ready = SlackRecordingPolicy.Status(recording: false, processing: false,
        pending: false, starting: false, ready: true, clientConnected: true)
    var policy = SlackRecordingPolicy()
    try check(policy.evaluate(signal: true, status: ready, now: 0).isEmpty, "Início deve ser estável")
    try check(policy.evaluate(signal: true, status: ready, now: 2).isEmpty, "Não iniciar antes de três segundos")
    try check(policy.evaluate(signal: true, status: ready, now: 3) == [.start(callID: 1)], "Iniciar chamada confirmada")
    try check(policy.evaluate(signal: true, status: ready, now: 4).isEmpty, "Não duplicar comando em andamento")
    policy.commandCompleted(callID: 1, accepted: true, now: 4)
    try check(policy.evaluate(signal: true, status: ready, now: 10).isEmpty, "Não reiniciar após parada manual")
    _ = policy.evaluate(signal: nil, status: ready, now: 11)
    try check(policy.evaluate(signal: true, status: ready, now: 20).isEmpty, "Desconhecido não encerra chamada")
    _ = policy.evaluate(signal: false, status: ready, now: 21)
    _ = policy.evaluate(signal: true, status: ready, now: 22)
    try check(policy.evaluate(signal: true, status: ready, now: 25) == [.start(callID: 2)], "Nova chamada pode iniciar")
    policy.commandCompleted(callID: 1, accepted: true, now: 26)
    policy.commandCompleted(callID: 2, accepted: false, now: 26)
    try check(policy.evaluate(signal: true, status: ready, now: 30).isEmpty, "Respeitar intervalo de tentativa")
    try check(policy.evaluate(signal: true, status: ready, now: 31) == [.start(callID: 2)], "Repetir falha transitória")
    policy.commandCompleted(callID: 2, accepted: false, now: 32)
    try check(policy.evaluate(signal: true, status: ready, now: 37) == [.start(callID: 2)], "Permitir terceira tentativa")
    policy.commandCompleted(callID: 2, accepted: false, now: 38)
    try check(policy.evaluate(signal: true, status: ready, now: 100).isEmpty, "Limitar tentativas")

    var waiting = SlackRecordingPolicy()
    var busy = ready
    busy.ready = false
    _ = waiting.evaluate(signal: true, status: busy, now: 0)
    try check(waiting.evaluate(signal: true, status: busy, now: 5).isEmpty, "Aguardar modelo")
    _ = waiting.evaluate(signal: false, status: busy, now: 6)
    try check(waiting.evaluate(signal: false, status: ready, now: 7).isEmpty, "Não iniciar chamada encerrada na espera")
    var disconnected = ready
    disconnected.clientConnected = false
    _ = waiting.evaluate(signal: true, status: disconnected, now: 8)
    try check(waiting.evaluate(signal: true, status: disconnected, now: 11) == [.openInterface], "Abrir interface antes de iniciar")
    try check(waiting.evaluate(signal: true, status: disconnected, now: 12).isEmpty, "Não abrir várias abas")
    try check(waiting.evaluate(signal: true, status: ready, now: 13) == [.start(callID: 2)], "Iniciar somente após interface conectada")

    for field in 0..<3 {
        var blocked = ready
        if field == 0 { blocked.processing = true }
        if field == 1 { blocked.pending = true }
        if field == 2 { blocked.starting = true }
        var candidate = SlackRecordingPolicy()
        _ = candidate.evaluate(signal: true, status: blocked, now: 0)
        try check(candidate.evaluate(signal: true, status: blocked, now: 5).isEmpty, "Respeitar estado ocupado")
    }
    var manual = SlackRecordingPolicy()
    var recording = ready
    recording.recording = true
    _ = manual.evaluate(signal: true, status: recording, now: 0)
    try check(manual.evaluate(signal: true, status: ready, now: 5).isEmpty, "Respeitar gravação manual")
    var disabled = SlackRecordingPolicy()
    disabled.enabled = false
    _ = disabled.evaluate(signal: true, status: ready, now: 0)
    try check(disabled.evaluate(signal: true, status: ready, now: 5).isEmpty, "Respeitar opção desabilitada")
    disabled.enabled = true
    _ = disabled.evaluate(signal: true, status: ready, now: 6)
    try check(disabled.evaluate(signal: true, status: ready, now: 9) == [.start(callID: 1)], "Confirmar sinal novamente ao habilitar")
}
