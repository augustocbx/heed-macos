# Backend-owned recording

The local backend owns capture, live transcription, finalization and the saved meeting. The menu and browser tabs send request IDs and observe one durable revision sequence. Closing every browser tab does not cancel these workers. Recording and finalization are separate acknowledged states.

The recovery manifest is written atomically before capture and stop intents. State and request receipts share one transaction, so a failed disk write leaves the previous state available for retry. A final ASR checkpoint survives failed metadata saves and avoids unnecessary retranscription. Command targets prevent an old tab from stopping a later meeting.

If capture or finalization fails, the interface offers retry. **Keep audio and leave recovery** archives the complete failed checkpoint, including manual speaker names, then releases the capture slot without deleting audio. The retained file appears in Recovery; successful manual recovery restores speaker names using channel/timing evidence and the original meeting identity. Installation/update maintenance has an owner token; another installer cannot release it. Quit checks fresh backend state.

Completed snapshots read current saved meeting data. Later names/notes edits appear to new clients, and deleted meetings do not reappear from the recording manifest. Older revisions, including replies from a previous meeting, cannot replace a newer active state.

## Automated validation

The isolated suites cover no-browser durable save, duplicate/concurrent commands, multiple subscribers, cross-meeting stale replies, permission failure, helper startup failure, interrupted backend recovery, ASR/save failure, receipt-write faults, abandonment/archive faults, current saved-data hydration, deletion, and hostile origins. Synthetic English/Portuguese transcript fixtures preserve real segment coordinates and manual names. The interface includes English, Brazilian Portuguese, French and German recovery copy.

Local validation: 127 server tests (607 assertions), 163 interface tests, production build, 18 Python tests, Python/installer/update syntax checks, native capture self-test and menu build/self-tests passed. The native capture compiler still reports two existing Sendable warnings.

These checks exercise adapters and native builds without physical audio devices. Real menu capture with all tabs closed, actual WAV/transcription quality and equivalent acceptance on the MacBook Air M1 and MacBook Pro M4 Pro remain to be exercised. Compiling for macOS 14 establishes the build target, not end-to-end testing on every macOS release.
