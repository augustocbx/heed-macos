import Foundation

/// Keeps an older heartbeat from arriving after a newly requested permission check.
final class SerializedPermissionReports {
    private var pending: [(@escaping () -> Void) -> Void] = []
    private(set) var active = false

    func enqueue(keepIfBusy: Bool, _ work: @escaping (@escaping () -> Void) -> Void) {
        if !keepIfBusy && (active || !pending.isEmpty) { return }
        pending.append(work)
        startNext()
    }

    private func startNext() {
        guard !active && !pending.isEmpty else { return }
        active = true
        let work = pending.removeFirst()
        work { [weak self] in
            self?.active = false
            self?.startNext()
        }
    }
}

func serializedPermissionReportSelfTests() {
    let reports = SerializedPermissionReports()
    var sampled = [String]()
    var completions = [() -> Void]()
    var permission = "denied"
    reports.enqueue(keepIfBusy: false) { finish in sampled.append(permission); completions.append(finish) }
    reports.enqueue(keepIfBusy: false) { finish in sampled.append("redundant heartbeat"); completions.append(finish) }
    reports.enqueue(keepIfBusy: true) { finish in sampled.append(permission); completions.append(finish) }
    precondition(sampled == ["denied"] && reports.active, "A requested recheck must wait for the older heartbeat")
    permission = "authorized"
    completions[0]()
    precondition(sampled == ["denied", "authorized"] && reports.active,
                 "Queued rechecks must sample current permissions only when their report starts")
    completions[1]()
    precondition(!reports.active)
}
