# create-heed

The checked-out fork CLI installs [**heed**](https://github.com/augustocbx/heed-macos) — local-first meeting transcription with real speaker diarization. Built for Apple Silicon, running on Linux too.

```bash
node packages/cli/bin/cli.mjs
```

The published upstream `npx create-heed` package is a separate installer and does not establish this fork's service-port contract. Run the CLI from this repository. From another directory, use its absolute file path. Fresh installs clone `augustocbx/heed-macos`; updates refuse another origin before fetching or changing code. Existing upstream checkouts must be preserved and installed separately.

Transcription and AI notes run locally. Optional configured SMB/iCloud storage may copy meeting data to the selected destination; Google Drive and OneDrive remain disabled pending #56.

---

## Why heed

Every other meeting tool ships your conversations to someone else's servers. heed doesn't. It transcribes, separates every voice, and writes AI notes **entirely on your computer** — so your work calls (NDAs, client data, strategy) and your private ones stay yours.

- **Local processing** — transcription, diarization, and AI notes run on-device; optional storage is explicitly configured.
- **Real-time _and_ post-stop** — live captions as people talk, plus a precise re-pass with real timestamps when you stop.
- **Real speaker diarization** — tells people apart by how they *sound*, not by login name — even on a single mic.
- **Voice memory** — name a speaker once; heed recognizes their voice in every future meeting.
- **Overlap detection** — catches two people talking at once instead of blending them into one line.
- **Floating panel** — an always-on-top window over Zoom, Meet, Teams, or Discord.
- **AI notes** — summaries and action items via a local LLM (Ollama), sized to your hardware.

## The engine

- **macOS (Apple Silicon)** — **Parakeet** ASR + **FluidAudio** diarization run on the **Apple Neural Engine** via CoreML. No CUDA, no gated tokens, ~50× real-time. This is heed's fastest, most accurate path.
- **Linux** — faster-whisper + pyannote on CUDA (or CPU). Supported and actively evolving.
- **Windows** — coming.

## Install

```bash
node packages/cli/bin/cli.mjs
```

The installer detects your machine and sets everything up: Bun, a supported Python, ffmpeg, the on-device AI engine, and (optionally) Ollama for AI notes. One command, no config. Then heed opens on `http://localhost:48101`.

## Update

```bash
node packages/cli/bin/cli.mjs update
```

Pulls the latest, syncs dependencies, and rebuilds the engine only if it changed.

## Troubleshooting

```bash
node packages/cli/bin/cli.mjs doctor     # check your install end-to-end
node packages/cli/bin/cli.mjs fallback   # install the fallback engine if the fast one isn't available
```

---

Local. Open. Yours. · MIT · Inspired by [trx](https://github.com/crafter-station/trx) from [CrafterStation](https://www.crafterstation.com/)

[GitHub](https://github.com/augustocbx/heed-macos) · [Report an issue](https://github.com/augustocbx/heed-macos/issues)
