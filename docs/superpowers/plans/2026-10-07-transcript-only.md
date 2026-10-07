# Transcript-only archival mode

Extend the existing backend-owned recording coordinator and managed quota. Capture mode and live preview remain independent of archival mode. A device preference is frozen at admission; missing legacy metadata means audio plus transcript.

1. Add failing coordinator regressions for save-before-delete, pending cleanup retry/restart, save/cleanup failure, preference freezing, and confirmed discard. Add shared exact-owned-path cleanup regressions.
2. Add `MeetingMode`, durable cleanup metadata, a canonical-session cleanup helper, and config normalization. Keep original and derived audio protected by the existing capture allocation until deletion and metadata persistence are confirmed. One unresolved capture blocks another; failed transcript-only recovery cannot be archived into unbounded additional captures.
3. Extend `RecordingCoordinator` with cleanup and discard adapter hooks. Preserve authoritative `finalCapture`, reuse atomic session creation, resume saved cleanup at startup, and never substitute provisional text. Retry recognizes already saved/current sessions and never rewrites accepted corrections.
4. Extend existing recording settings and four-locale browser/native controls with pre-enable processing/lost-playback disclosure and immutable active mode. Playback/retranscription/archived downloads reject transcript-only sessions, including pending cleanup.
5. Verify focused server/client regressions, full required suites and production/native builds through the coordinator. Publish a criterion-by-criterion QA ledger with physical-device/model/macOS acceptance limits. No private audio/logs/transcripts or generated artifacts are committed.

Cleanup does not promise secure erasure from SSDs, snapshots or backups. Explicit discard of unsaved recovery loses that meeting; saved transcripts remain. Startup retries only cleanup after finding the canonical finalized saved meeting. Unsaved interrupted capture requires explicit retry/discard.
