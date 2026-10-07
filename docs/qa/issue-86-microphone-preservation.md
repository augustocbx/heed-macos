# Issue 86: preserve recognized microphone speech

Final dual-channel transcription no longer drops every microphone segment in a cluster containing system audio. Tiny clusters are not absorbed into unrelated voices solely because they are brief; channel-tagged short voices may remain distinct. AEC still runs before recognition. The final echo filter requires a whole normalized phrase and close temporal correspondence with system ASR. It supports adjacent split/merged ASR spans, preserves phrases containing unique local words, and keeps brief acknowledgments or uncertain ASR disagreements. This intentionally prefers residual echo to deleting uncertain local speech. Identical substantial phrases spoken simultaneously remain ambiguous with transcript evidence alone.

ASR text and speaker attribution are separate outcomes. Missing, failed, invalid or temporally absent diarization keeps recognized text with `attribution: fallback` and channel-specific unnamed speaker labels. Retained microphone speech in a mixed cluster also gets fallback attribution rather than inheriting a remote identity. Existing timestamps remain unchanged. Content-free diagnostics report sampled raw/AEC signal levels, ASR/diarization/usable-embedding counts, retained/discarded counts, echo reasons, fallback counts and diarization failures. A fixed-field sanitizer excludes private worker errors, text, audio, paths and embeddings. Diagnostics survive local recording, recovery and explicit retranscription persistence; warnings are localized in all four supported interface languages. Portable meeting exports retain text and labels but do not export device-local diagnostic counters.

## Runtime evidence

On the MacBook Pro, the affected approximately 215-second Portuguese recording was replayed using the corrected pipeline injected into an exclusively owned Python interpreter. The installed application was not changed. The previous final result had zero microphone and 45 system segments. The corrected pass recognized and retained 13 microphone and 45 system segments; it discarded none in this recording, with six system segments explicitly marked as uncertain attribution. AEC was applied; microphone RMS remained approximately 0.0301 raw / 0.0298 cleaned. SHA-256 checks confirmed the original WAV and saved session were unchanged. Temporary audio was removed and owned native workers were stopped; installed release workers were preserved.

This demonstrates recovery of previously discarded recognized text, not word-level accuracy or proof that every microphone segment belongs to the local user. Headphones/speaker-output acceptance in English and Portuguese on both Macs remains a physical validation gate. Genuine echo suppression is covered by synthetic fixtures. LiveKit emitted its existing deallocator assertion at interpreter exit after a successful result and owned-worker shutdown; this was also observed in the baseline diagnostic replay.

## Automated validation

- Regression tests first failed on mixed-cluster text loss, unrelated short-speaker absorption, missing/invalid diarization and distant attribution. Native failed-status propagation and concurrent manual-edit guards also failed before their corrections.
- Final pipeline and echo fixtures: 27 passing cases, including English/Portuguese, overlapping speech, no-system windows, short distinct voices, missing embeddings, native failures, echo and split/merged ASR phrases.
- Full Python transcription suite: 86 tests passed. Syntax checks passed.
- The legacy standalone `diarize_voice_test.py` fails its `update_voice bumps count` assertion on both the unchanged base and this branch; it is not part of CI and no unrelated voice-store change is included.
- Server suite: 623 tests passed, 3,499 assertions, zero failures. Interface suite: 320 tests passed across 60 files. Client typecheck and production build passed; the existing bundle-size warning remains.

## Explicit recovery

After installing a release containing this change, open the affected meeting with retained audio, choose **Transcribe**, select the final model and meeting language, and confirm **Start transcription**. Existing transcripts are never rewritten automatically. The full pass must succeed before the save; current tags, audio paths and manual speaker names are preserved, while transcript/source revisions invalidate stale derived answers and notes as before. The save includes the starting transcript revision so a concurrent transcript or speaker edit rejects the late result. Refresh the meeting before retrying a revision conflict. Recordings without retained audio require recapture; the pipeline cannot reconstruct missing source audio.

This PR references #86 without closing the outstanding physical acceptance gate.
