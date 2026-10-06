# Backend-owned recording design

Approved implementation of issue #4. The backend owns capture, one live ASR worker, finalization, speaker mappings and durable session persistence. Browser tabs and the menu subscribe to authoritative snapshots and issue idempotent commands. Closing all tabs never ends the worker or prevents saving.

## Lifecycle and durability

Use idle, starting, recording, stopping, finalizing, completed and failed states. Create a stable meeting UUID before capture. Persist transition intent and the recording path before launching capture; acknowledge start only after writer readiness. Persist final ASR output before saving a finalized session. Completion is acknowledged only after the session save and its manifest checkpoint are durable. Repeated stop/retry reuses the saved result and meeting identity. Target IDs prevent a stale tab stopping a later meeting.

A versioned manifest in the application data directory retains path, timestamps, mode, manual speaker mappings, provisional segments, final output, saved session and failure stage. Interrupted recording becomes a recoverable failure after restart, never a false recording indicator. Retry uses retained audio or a final-result checkpoint; audio is preserved on ASR/save failure. A corrupt manifest fails closed rather than silently resetting the recording identity.

## Clients and integration

One backend live worker feeds bounded latest segments and SSE subscribers. Reconnecting clients receive a snapshot; disconnecting only removes their subscription. English live preview and final en/pt detection stay unchanged. Final timestamps/duration come from the existing WAV finalizer. Speaker changes are revision checked and reconciled by channel/timing when final diarization changes identities. Every new mutation requires the existing loopback/origin guard. Bind remains 127.0.0.1.

The menu's red icon represents actual capture; finalization has a separate status. Quit supports stop/save or cancellation, and installation/update use a maintenance guard preventing new capture during shutdown. Browser visualization is optional and never controls capture lifetime.

## Acceptance evidence

Test no-tab start/stop/save, reconnect/replay, simultaneous commands, denied permissions, helper exit, ASR/save failures, restart at each durable boundary, stale stop targets, speaker edits and maintenance races using synthetic fixtures. Run server/client/Python/native CI checks and independent review before merge. Physical M1/M4 capture and supported OS acceptance are recorded separately. Only evidenced issue checklist items are checked; this PR does not automatically close #4.
