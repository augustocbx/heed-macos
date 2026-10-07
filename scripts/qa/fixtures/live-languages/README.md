# Public authored speech fixtures

These small WAVs contain authored synthetic text only. Audio is generated with eSpeak NG 1.51 formant voices (`en-us`, `pt-br`, 145 words/minute), converted by FFmpeg to PCM16 16kHz, and released under GPL-3.0-or-later with the included [license](LICENSE). Source/voice data is the GPL eSpeak NG project: https://github.com/espeak-ng/espeak-ng/tree/1.51. No macOS system voice, voice clone, personal recording or private transcript is included.

The manifest records synthesizer/archive provenance, exact WAV SHA-256, duration/channels, authored language/text/time/channel spans, names/terms/lexical anchors and known translation alternatives. Formant TTS does not represent human regional accents or natural bilingual speech. Within-turn switching concatenates EN/PT utterances; overlap is on separate channels. Absent cohorts remain explicitly unavailable.

Regenerate with an existing isolated eSpeak NG 1.51 binary/data tree and FFmpeg:

```sh
python3 scripts/qa/generate-live-language-fixtures.py --espeak /existing/espeak-ng --espeak-data /existing/espeak-data-parent
```

Generation was performed in `/private/tmp`, using the pinned release archive supplemented with missing files from its matching 1.51 source tag, configured without pcaudiolib, sonic, MBROLA or Klatt, and built locally without installation. Exact archive hashes are in the manifest. Preserve provenance and review regenerated hashes/timing before accepting any change.
