# Local transcription vocabulary

Reuse existing live Whisper and explicit full-audio Whisper paths. Native Parakeet in Heed has no configured vocabulary interface; do not add a CTC model or replace recognized text. A local named glossary contains unchanged Unicode terms, optional textual alias/pronunciation hints, and optional English/Portuguese scope. Users manage/import/export glossaries, choose a default, and explicitly select a glossary with additional meeting terms before recording or retranscription.

Persist a bounded versioned JSON library atomically with optimistic concurrency. Freeze a validated snapshot at admission and retain it in recording recovery state. Record effective language-filtered prompting configuration with each run and recognition generation. Keep snapshots out of portable provider payloads and notes/chat inputs. Existing meetings change only through existing explicit candidate acceptance or editing.

Whisper initial_prompt assists the first model window; live chunks receive independent prompts. Hints are textual context, not phonetic guarantees. Bound prompt text and record omitted entries. Describe native Parakeet as unsupported by the current Heed path, independently of FluidAudio's separate CTC feature.

Validation includes persistence/validation/concurrency/privacy, real path option forwarding, candidate/recovery provenance, management/selection UI, and all interface locales. Controlled paired benchmark must measure term recall, unrelated speech error, false insertions, latency and memory. Natural speech, both Macs and older supported macOS acceptance remain explicit until measured.
