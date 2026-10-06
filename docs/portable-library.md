# Portable meeting library, schema v1

The private device root is `HEED_APP_DIR/library`. Catalog state, identity aliases, sync checkpoints and migration journals are local only. Existing session files remain the authoritative application/AI store. Imported previews never enter that store; a complete verified transcript is atomically saved before import success. Legacy session IDs remain local aliases so task and chat links survive identity migration.

## Portable representation

Logical provider layout:

```
meetings/<meeting UUID>/revisions/<revision UUID>/meeting.json
meetings/<meeting UUID>/revisions/<revision UUID>/manifest.json
commits/<device UUID>/<revision UUID>.json
objects/<audio SHA-256>
```

`meeting.json` explicitly includes schemaVersion=1, meeting UUID, title, created/updated dates, duration, language and transcription/live model names, finalized transcript and timed speaker segments, speaker names, tags, notes, summary and pinned state. Optional audio references include SHA-256, byte count, WAV format, `archived` mode and the exact `objects/<hash>` path. Biometric embeddings, credentials, native/live databases, absolute paths, local expiration/cache state, job metadata and unknown fields are rejected. Global accepted tasks remain local, independent of media eviction. Task/chat portable artifacts require a later explicitly versioned schema extension; they are not silently embedded in v1.

The manifest contains schema, library, meeting and revision UUIDs, at most 32 unique parent revision UUIDs, and exactly one required transcript artifact (`meeting.json`) with exact byte length and lowercase SHA-256. Transcript artifacts are capped at 16 MB; segments at 100,000. Unknown versions/fields, invalid timing, nonfinal transcripts, malformed UUIDs, parent self-cycles, path traversal and hash/identity mismatches fail closed. Hashes use exact compact UTF-8 JSON bytes. The commit contains the device UUID, identities, exact relative manifest path and manifest hash. Provider adapters map this logical layout to their own IDs if needed.

Publish optional audio objects first, then transcript, then manifest, then immutable device marker. An adapter must reject conflicting writes at an existing immutable path. Discovery accepts only valid commit records and verifies their manifests/transcript metadata, never fetching audio. Missing/incomplete records are ignored by adapters; failed or partial listing does not delete previously seen records. The service caps discovery at 100 pages of 100 records, detects repeated cursors and marks truncated/failed discovery incomplete. Import ordering is newest-created first, with stable meeting and revision tie-breakers. Creation dates order import priority, never resolve divergent content.

Queuing a local meeting streams the current local WAV to compute its size and hash, then records an audio reference with the portable revision. Its source path stays in the private catalog and remains protected until publication is verified. Cached audio is also verified with bounded streaming reads before playback; neither operation buffers the entire recording.

Destination registries track their own publication acknowledgments. They can pass additional revision IDs to `protectedPaths` so a copy verified on one destination remains protected while another destination still needs it; existing pending/conflict protections remain included.

Provider registries run each complete discovery/import/publication tick under `withProvider`, an exclusive lease on the single catalog owner. Competing ticks and manual mutations fail busy, and the previously selected provider is restored afterward. Remote-only snapshots are scoped to the current provider; fully validated duplicate discovery can rebind availability to a healthy destination without changing revision identity.

## Revisions and recovery

Library/meeting identity, not local legacy paths, defines reconciliation. Duplicate UUIDs across different libraries receive different device aliases. Exact revision retries are idempotent. Descendants can advance a head when local content has not changed; ancestors do not replace descendants. Divergent branches and unsynchronized local corrections remain conflicts. Explicitly selecting a conflict preserves the current local correction as an immutable revision, then creates a merge revision whose parents include the current head and preserved conflict candidates. Previously committed content remains recoverable in the private catalog.

Import reserves staged copies, immutable catalog artifacts, session replacement and catalog/index overhead before transfer. The durable commit intent distinguishes a complete-session acknowledgment failure from a missing session. Restart reconciles matching complete data, preserves later user corrections as conflicts and releases abandoned staging claims. Staging uses UUID directories and is bounded per operation; no remote text becomes partially visible to AI. Quota failures skip that revision and report imported/skipped/pending counts, preserving retained text. Text is never automatically replaced by summaries or evicted.

Deleting a local meeting first persists a private per-meeting tombstone. Queued publications require the source to remain present, including immediately before writing the remote commit marker. Automatic imports respect tombstones across restart; explicitly importing selected revisions restores that meeting. Tombstones never leave the device and never delete remote history.

Conflict selection persists a commit intent before replacing the complete local session. Restart preserves the selected merge as pending publication, or retains later local corrections as a conflict if the final catalog acknowledgment failed.

Migration streams a verified copy into content-addressed managed media, fsyncs it, verifies its hash, atomically updates every local session reference and removes a legacy source only after no session references it. Active/protected audio is skipped. Interrupted reference writes retain original and verified target plus a private migration journal; both remain protected until retry completes. Playback continues to allow verified legacy paths during migration and subsequently permits managed media paths, with symlink/containment checks.

The migration journal retains at most 10,000 pending entries, rejects files larger than 64 MB and prunes completed history. Additional legacy sources remain untouched for a later bounded batch.

## Providers, transport and encryption

`LibraryProvider` exposes bounded paginated commits, bounded metadata reads, streaming requested media, immutable writes and explicit publication confirmation. Credentials remain the adapter's device-specific responsibility. `authenticated-network` adapters must use authenticated SMB encryption/signing or authenticated HTTPS; OS-managed folders rely on operating-system account/access controls. A successful local folder write returns `local-only` until a provider establishes remote publication. States distinguish pending, uploading, provider-confirmed, verified, conflict and unavailable. Read-back verification follows remote confirmation.

An optional `acknowledgeDiscovery` hook advances a staged provider checkpoint only after complete discovery has validated all committed metadata and durably saved the private catalog. Partial listing or catalog failure never acknowledges it. Checkpoint failure preserves observed records, reports incomplete synchronization and allows idempotent replay after restart.

SHA-256 provides integrity, not encryption or authentication against a malicious writer able to replace every artifact. Schema v1 has no client-side encryption and exports no keys. Optional client-side encryption requires a separately versioned envelope, authenticated encryption, explicit key creation/storage in macOS Keychain, recovery/export controlled by the user, rotation/revocation semantics and adapters rejecting unknown envelopes. Models, binaries, logs, OS credentials and provider caches remain outside managed meeting quota.

The production library API shares the recording quota service and initializes its catalog lazily. Full protected text can block new library writes without making existing sessions/settings unavailable. Read-only startup protection projects pending source/cache paths and incomplete migration journals before initialization; malformed protection state preserves media for recovery.

Audio is optional. Imports retain complete text without downloading it. An explicit playback request reserves media/staging/session replacement space, streams only the selected object, rejects overrun/truncation/hash mismatch, fsyncs then exposes the verified local cache. Quota-blocked and unavailable sources are distinct API outcomes. Local recordings retain archival availability after publication and cache removal. A successful requested download clears stale expiration flags. Local cache removal changes device availability only; it is never a remote deletion. Remote deletion requires a future distinct confirmed versioned tombstone action; ordinary discovery and cache cleanup have no delete contract.

## Validation limits

Synthetic tests cover strict format, privacy, path/hash corruption, stable aliases, concurrent revisions and clock skew, restart/commit acknowledgment failure, partial listing, quota pressure, streaming audio and interrupted migration. No real destination/accounts/shares or private meeting data are used. Equivalent M1/M4 Pro, English/Portuguese meeting and actual provider transport/confirmation/permission scenarios remain manual acceptance gates. macOS 14+ is the declared platform target; automated native builds are separate evidence from physical-device acceptance.
