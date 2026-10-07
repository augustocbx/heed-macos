# Local media import implementation plan

Implement issue #9 in its dedicated worktree. Reuse FFmpeg normalization, the authoritative final recording pipeline, the quota ledger, atomic meeting persistence and the shared transcript-only cleanup helper. The browser selects a file; it never sends an original filesystem path. Do not expose URL imports.

1. Add a durable local import controller and typed HTTP contract. Write failing tests for stable submission identity, resource admission, cancellation, quota protection, restart recovery and save retry. A single import owns bounded managed staging until its canonical meeting is saved or explicitly discarded.
2. Add content-based FFprobe validation and timestamp-preserving normalization. Test WAV mono/stereo, compressed audio, video with/without audio, corrupt files and misleading extensions. Keep existing capture/recovery normalization defaults compatible.
3. Reuse `finalize_recording` through a thin phased SSE adapter. Cancellation during native processing remains pending until the bounded operation actually ends; only then delete managed copies. Preserve real duration and model/language metadata.
4. Add an accessible meeting-library import dialog with file picker/drop, filename, supported-media explanation, model, auto/en/pt and storage choice. Poll durable jobs after refresh; provide cancel/retry/discard. Translate all new interface copy in English, Brazilian Portuguese, French and German.
5. Wire the server to resource admission and maintenance, shared transcript-only cleanup and the existing meeting store. Run focused red/green checks, client suite/build and server suite in the coordinator's serialized validation slot. Document physical M1/M4 and supported-OS acceptance separately.

Review focus: normalized timelines must preserve silence; no save on canceled jobs; interrupted claims survive startup; retries use the same meeting identity; quota ownership includes every working copy; original user files never enter deletion APIs; source content rather than filename decides supported media.
