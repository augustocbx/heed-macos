# Issue #9: local recording imports

The meeting library now offers Import recording. Local file selection and keyboard-operable drop controls preview the filename, final transcription model, automatic/English/Portuguese language and storage choice. Audio is extracted from supported video; Heed does not retain video. URL import is not exposed. The pre-existing URL endpoint is unchanged.

## Reused implementation

- `media.ts`: bounded FFmpeg/FFprobe processes and normalization. Import normalization preserves silence and validates the normalized timeline before ASR. Input content determines support; extensions are hints only. Playlist/network demuxers are refused.
- `finalize_recording`: the existing authoritative whole-file ASR/diarization pipeline. `media_import.py` only adapts real phase callbacks and manages bounded import receipts; it introduces no engine.
- `ManagedQuota`/`reserveMediaWork`: upload admission and quota allocation happen before multipart parsing. Uploads declare an identity and size; the HTTP body length and parsed file must fit that declaration. Files are capped at 256 MB and available quota may impose a smaller limit. Decoded media and every processing copy also fit the reserved budget.
- `AutomaticNotesService.create`/`SessionTags`: durable canonical meeting creation with a stable import meeting ID, preserving existing notes and transcript behavior.
- `cleanupMeetingAudio`/`discardOwnedMeetingAudio`: the common transcript-only cleanup verifies exact managed paths and durable meeting persistence before deletion. Originals selected by the user are never deletion targets.

## Resource and recovery behavior

One import is admitted at a time. Active mandatory recording/transcription blocks new uploads; an admitted import blocks new capture. Existing capture therefore never receives an import competing for its mandatory audio resources. Imports preempt optional local AI before recognition.

Progress reports upload/copy, normalization, actual diarization/transcription phases and saving. A canceled import does not save a meeting. Cancellation during native processing waits for actual completion, with a marker checked before the next expensive phase. Confirmed completion is required before deleting working media. A disconnected or timed-out worker retains a protected recovery job and continues blocking new mandatory audio work, including after restart; only its own Retry may reattach, and discard is disabled until completion is confirmed. Closing the import window after submission leaves backend-owned work running.

Jobs, fingerprints and completed recognition checkpoints are durable. Refresh restores status. Interrupted jobs offer Retry/Discard; save retries reuse their recognition checkpoint and stable meeting ID. A retry after API restart reattaches to the sidecar's existing job receipt and does not overwrite a WAV still in use. Verified normalization is checkpointed only after the timeline probe; an interrupted partial WAV is rebuilt from the protected source after worker ownership is confirmed. Canonical saved meetings recover independently of the copied source when terminal receipt persistence fails after cleanup, without creating another meeting or rerunning recognition. The sidecar retains at most 128 completed receipts and never evicts active operations. The durable import history is bounded to 128 jobs; every retained job remains visible so older failures remain actionable. It refuses further submissions rather than silently dropping deduplication receipts.

Failed jobs keep quota-protected copies until retry or explicit discard. A corrupt import journal fails closed and protects the managed media/staging roots for recovery. Transcript-only jobs keep pending cleanup protected until the common helper confirms deletion and saves its receipt. Audio + transcript retains only the normalized playable audio after saving.

## Acceptance evidence

| Criterion | Implementation and executable evidence | Status |
|---|---|---|
| Supported import saves normal meeting with real duration/model/language | `media-import-workflow.http.test.ts`: real FFmpeg upload, canonical meeting, duration/model/language, both storage choices | Synthetic pipeline satisfied; real content on both Macs pending |
| Corrupt/unsupported/dependencies/size actionable errors | `media.test.ts`: content probe, corrupt data, video without audio, misleading extension; HTTP size and quota checks before parsing/ASR | Automated checks satisfied; missing-dependency child-process check satisfied |
| Distinct stages and cancellation cleanup | Typed phases, Python callback tests; lifecycle tests prove no cancellation save and no premature deletion after uncertain disconnect | Automated checks satisfied |
| Recording responsiveness/resource policy | Controller and HTTP pre-parser admission; server capture adapter blocks active import; focused admission tests | Automated checks satisfied; concurrent physical capture QA pending |
| Configurable quota protects active/pending work | Existing quota claims; pressure/cleanup/restart tests | Automated checks satisfied |
| Duplicate/retry identity | Fingerprint receipts, stable meeting ID, completed checkpoint retry tests | Automated checks satisfied |
| Text-only temporary audio and playback loss explained | Four-locale dialog and common cleanup integration | Automated checks satisfied |
| User original untouched | Real upload test verifies original bytes/digest and managed-only cleanup | Automated checks satisfied |
| URL safeguards if URL support added | No URL interface or new download capability; local endpoint rejects URL/path input | Not applicable to this milestone |

Automated media fixtures cover mono/stereo WAV, MP3, M4A, FLAC, real MP4 video with audio, video without audio, misleading extensions, corrupt input, timeline preservation, cancellation and quota pressure. The HTTP workflow confirms timestamp seeking via byte-range audio delivery and verifies successful imports remove staging.

Local checks: production client build; full client suite 526 passing tests/89 files; full server suite 888 passing tests/5,313 assertions/125 files after the recovery review fixes. Final focused import/media checks: 25 passing tests/169 assertions across four server files and six Python adapter tests. Generated logs and media fixtures remain outside the repository. The coordinator must run the integrated final suites after combining concurrent feature changes.

Physical English/Portuguese recognition, browser refresh during actual native processing, permission/capture concurrency and failure recovery on the MacBook Air M1 and MacBook Pro M4 Pro remain separate acceptance gates. macOS 14+ compatibility is an installer contract, not established by tests on macOS 27.0.1. No installation, deployment or issue closure is implied by these local results.

## Vocabulary integration handshake

The import controller accepts `vocabularySnapshot` and `validateVocabularySnapshot` callbacks. The integrated server supplies the canonical `vocabularyStore.snapshot()` and `validateVocabularySnapshot`; a missing validator fails closed when a persisted snapshot exists. The private job freezes the validated effective snapshot at submission and includes it in the fingerprint. Every retry/reattachment receives exactly that snapshot, and the saved meeting accepts the common result vocabulary provenance. Raw snapshots never appear in public import status. A focused test changes the default between recognition attempts and verifies both attempts use the original snapshot.
