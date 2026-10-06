# Recording worker deadlines

## Problem

Stopping physical capture precedes transcription cleanup and full-audio finalization. An unresponsive Python HTTP handler or native Parakeet stdio worker can nevertheless leave finalization pending indefinitely. A partial response line, blocked stdin write, or request-lock contention is sufficient; counting stdout lines does not bound elapsed time. The existing native close path also waits behind the request lock.

## Approved behavior

HTTP GET and POST deadlines cover headers and the complete JSON body. GET health allows 5 seconds; other GET operations allow 120 seconds. Ordinary requests allow 120 seconds, stream/diarization finish allows 60 seconds, and offline finalize/transcribe/diarize allows 90 minutes. The last is a conservative upper bound for long recordings, not a delay before physical capture stops. Explicit shorter budgets and HTTP AbortSignals are supported. Failures retain the existing null-result contract. HTTP cancellation does not terminate a shared native singleton.

Singleton-factory lock admission has its own 300-second budget; an expired waiter does not cancel another initialization. Once admitted, the native transport has a separate 300-second readiness deadline and a 120-second live request deadline. Offline requests allow `max(300, 120 + 2 * durationSeconds)` seconds, capped at 3,600 seconds. Serialization lock acquisition, nonblocking stdin writes, stdout partial lines, and noisy stdout all consume the same total request budget. A single response line is limited to 32 MiB. Injected short budgets exercise synthetic subprocesses without models.

A deadline after any request byte was written, EOF, or a real transport I/O failure invalidates the native worker. A caller whose deadline expires before the first protocol byte (including after lock admission), or whose request serialization fails, owns no native state and fails alone, preserving the admitted request and healthy worker. Close can cancel a blocked request without taking its request lock. Only the worker's newly created process group is signaled: SIGTERM, one-second grace, then SIGKILL, followed by a bounded wait/reap of the direct child and pipe closure. Descendants receive SIGKILL even when the leader exited on SIGTERM. Exit checks use waitid(WNOWAIT), retaining the unreaped direct child as process-group identity through every signal; reap occurs only after group cleanup. Lost ownership refuses stale group signals. macOS CPython 3.12 omits os.waitid; the transport uses the public Darwin libc waitid API with the LP64 siginfo_t ABI from sys/signal.h and sys/wait.h. It does not require replacing an existing virtual environment. Stderr uses DEVNULL; shutdown does not join a drainer thread. A dead singleton is closed and recreated on the next request.

No code deletes or rewrites the source WAV. Finalization failure remains a durable recording-coordinator failure with the original audio path available for recovery. Startup ignores noise and unrelated JSON until explicit ready:true within the same deadline. Successful native protocol responses, noise-prefixed JSON, and timestamp output remain compatible. This does not add an HTTP-to-worker cancellation protocol or claim to diagnose the user's actual private recording.

## Validation boundary

Use synthetic stdio processes and an ephemeral loopback HTTP fixture only. No installed service, physical capture, model download, private recording, or heavy full suite is needed. Physical capture stop ordering and failed-state/audio preservation are exercised through the real RecordingCoordinator with a bounded HTTP fixture; installation and real model acceptance remain separate gates.
