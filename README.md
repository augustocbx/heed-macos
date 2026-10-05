# Heed macOS

A macOS adaptation of [Heed](https://github.com/isjunrod/heed), by Junior Rodriguez, for recording and transcribing meetings locally in **Brazilian Portuguese (`pt`) and English (`en`)**. It includes menu bar controls, a 2 GB audio retention limit, and audio playback synchronized with the transcript. The interface and menu support English, Brazilian Portuguese, French, and German, with an English fallback. Documentation and installation messages remain in English; the final meeting language is detected automatically.

Each Mac keeps its own audio, models, and meetings. Installing this project on two machines provides the same features, but **does not synchronize files between them or upload meetings to the cloud**.

## Credits and upstream

This project is based on **[Heed](https://github.com/isjunrod/heed)**, created by **[Junior Rodriguez (@isjunrod)](https://github.com/isjunrod)**. Heed provides the original local transcription, speaker diarization, saved meetings, and AI notes foundation.

This repository maintains additional macOS controls, Slack automation, audio retention, permission guidance, transcript playback, and interface localization. The original MIT license and copyright notice are preserved in [LICENSE](LICENSE). See [CREDITS.md](CREDITS.md) for attribution and project links.

## Screenshots

The screenshots below use demonstration meeting data.

### Recording

![Recording interface](docs/screenshots/recording.jpg)

### Meetings

![Saved meetings](docs/screenshots/sessions.jpg)

### Settings

![Settings and macOS permissions](docs/screenshots/settings.jpg)

## Contributing

Contributions through forks and pull requests are welcome. Only @augustocbx can merge into the default branch. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Installation

Requirements: **Apple Silicon**, **macOS 14 or later**, [Homebrew](https://brew.sh), and Apple's Command Line Tools. The installer also installs Node.js for the Vite interface. A minimum RAM requirement has not been validated across all Macs.

Install Command Line Tools if needed, then clone and install:

```sh
xcode-select --install
git clone https://github.com/augustocbx/heed-macos.git
cd heed-macos
bash install-macos.sh
```

The installer prepares Bun, Node.js, FFmpeg, Python and its `.venv`, dependencies, Swift executables, the interface, and the menu app. **Bun 1.4.2** is the version used for validation; the installer downloads Bun if it is missing. Initial preparation downloads the local FluidAudio/Parakeet models. The measured model set takes approximately **1.7 GB of additional disk space**, outside the audio quota. Installation and the initial download require an internet connection.

Ollama is also installed for AI notes. Its models are optional and are not downloaded automatically; transcription does not require a notes model. Do not run this installer with `sudo`.

## Permissions and use

The app is installed at `~/Applications/Heed.app`. The LaunchAgent at `~/Library/LaunchAgents/local.heed.menubar.plist` starts the menu icon when you log in. Use the menu to start or stop recording and open [http://localhost:5170](http://localhost:5170).

### Automatic start for Slack meetings

**Automatically record Slack meetings** is enabled by default in the menu. With Heed already running, joining a meeting/huddle in the **installed Slack app** starts recording after a few seconds of confirmation. Opening Slack, preparing a meeting, or testing the microphone does not start capture. Every recording starts with an English live preview; audio permissions and models must be ready.

If macOS blocks access to Slack logs, Heed opens a folder picker. Select the exact **logs** folder and click **Allow log access**. To request access again, choose **Allow Slack log access…** from the menu. The App Store version uses `~/Library/Containers/com.tinyspeck.slackmacgap/Data/Library/Application Support/Slack/logs`; the directly downloaded version uses `~/Library/Application Support/Slack/logs`. The picker opens at the expected location; use **⌘⇧G** to enter the path if needed. Access is limited to that folder and stored as a read-only security-scoped bookmark for future launches. Full Disk Access is not required. Authorize the folder separately on each Mac. The menu should show **Slack: waiting for the next meeting** before testing.

If the interface is closed, Heed opens `localhost:5170` and waits for it to connect before sending the start command. Keep that tab open for transcription and saving. A confirmed Slack meeting end stops recording automatically. An unavailable detector does not stop capture. You can also stop recording through Heed's menu. A manual stop does not restart recording for the same meeting.

The detector follows only new meeting states in local Slack logs, without storing messages or channel names. A meeting already active when Heed starts therefore does not trigger recording retroactively. The menu shows the detector state; diagnostics are written to `~/Library/Logs/Heed/slack-auto.log`. Slack's internal log format may change in future releases. Slack in a browser is not monitored.

**Keep the interface tab open during capture and saving.** It can be minimized. The browser controls recording, receives the live transcript, and saves the meeting when capture ends.

Open **Settings** in the interface or **Settings and permissions…** from the menu. The page queries the native app and shows microphone, system audio, and Slack log access status. Its buttons request access or open the corresponding System Settings section. Status refreshes when you return to the page and every three seconds; without a connection to the menu app, permission status is unknown. System Settings buttons remain available for permissions that appear enabled, so an authorization invalidated by macOS can be renewed.

In **System Settings → Privacy & Security**, allow:

- **Screen & System Audio Recording**, to capture other participants.
- **Microphone**, to capture your voice.

macOS may display Heed, Bun, or the capture component as the requesting app. If no prompt appears, check these settings manually. The capture executable is `<project-folder>/packages/transcription/native/heed-parakeet/.build/release/heed-syscap`. Each Mac needs its own permissions.

Updating the locally signed app may invalidate its previous authorization. If capture is denied even though Heed appears enabled, turn its **Screen & System Audio Recording** permission off and on again, then accept the restart requested by macOS. Slack log access remains a separate folder-picker authorization.

System audio capture uses ScreenCaptureKit and works with headphones. Microphone capture uses the default macOS input: check **System Settings → Sound → Input** before a meeting.

### macOS Voice Isolation and Heed capture

During a test call in a compatible app such as FaceTime, open the macOS **Video** or **Audio** menu and choose **Mic Mode → Voice Isolation**. [Apple documents these controls](https://support.apple.com/en-us/105117) for macOS 14 or later. In audio-only [FaceTime calls](https://support.apple.com/guide/facetime/change-audio-options-fctme7c07113/mac), **Voice Isolation** may appear directly in the **Audio** menu. Check which app the menu identifies before changing its mode. **Voice Isolation** prioritizes your speech and reduces nearby noise; **Standard** restores default processing, rather than guaranteeing unprocessed audio. Available options [vary by app](https://support.apple.com/en-gb/guide/mac-help/mchle82b42f0/mac).

Availability also depends on the input device and audio route: Apple distinguishes the requested mode from the mode [actually used by the current route](https://developer.apple.com/videos/play/wwdc2021/10047/). If the control is missing or unavailable, note the app, microphone and macOS version. This does not establish a Heed failure or require permission changes.

The audio paths serve different purposes:

- **Your voice sent to the call:** microphone mode applies to the compatible calling app's audio path. Selecting Voice Isolation in Slack does not prove that Heed's separate microphone capture receives the same processing.
- **Other participants' voices:** arrive through the calling app's audio output. Heed records them with ScreenCaptureKit, including when you wear headphones. Your microphone mode does not remove noise received from other participants.
- **Recording and transcription:** Heed captures your microphone with AVAudioEngine and preserves the sources in separate channels. Preparing audio for speech recognition (ASR), such as format and sample-rate conversion, does not change audio sent to callers. Heed does not offer selectable virtual microphone or speaker devices. Voice Isolation does not provide the complete feature set or [audio routing offered by Krisp](https://help.krisp.ai/hc/en-us/articles/30533083171868-Noise-Cancellation-with-Krisp-AI-Meeting-Assistant).

For comparison, use a short test call without private content, outside important meetings. Note the initial mode, say the same phrase with mild background noise in **Standard** and **Voice Isolation**, ask the other person to compare, and restore the initial mode. Evaluate the Heed recording separately. See [permissions](#permissions-and-use), [playback](#playback-with-the-transcript) and [diagnostics](#diagnostics-and-tests).

**Physical validation pending:** MacBook Air M1 and MacBook Pro M4 Pro, both reported as running macOS 27.0.1. These instructions do not report tests on those Macs or validate every supported macOS 14+ release.

## Playback with the transcript

Open **Meetings**, select a meeting, and press Play in the player above the transcript. The matching segment is highlighted and kept visible. Click a segment, or use Enter/Space, to play from that point. Overlapping speech can highlight multiple segments. Synchronization follows segment timestamps, not individual words.

The original WAV preserves two separate channels at 16 kHz: **left = microphone; right = system audio**. This lets transcription process the sources separately. Heed's player mixes the channels to mono so you hear both sources in both ears; another player may retain the original left/right separation.

Names entered manually during recording survive live transcript updates and are saved with the meeting. Renaming after recording or in **Meetings** also updates the segments and participant list in the local file. When final diarization reorganizes speakers, names are transferred using source channels and overlapping segments; ambiguous matches are not forced by a “Speaker” number.

If microphone quality drops with Bluetooth headphones, select the **Mac's built-in microphone as input** while keeping the headphones as output. Apple explains the Bluetooth mode change in [If sound quality is reduced when using Bluetooth headphones with your Mac](https://support.apple.com/en-ie/102217).

## Storage and retention

Audio files are stored in this checkout's `recordings/` folder. Meetings and transcripts are stored in `~/.heed-app/sessions/`; configuration is stored in `~/.heed-app/`. Models are stored in `~/Library/Application Support/FluidAudio/Models/`.

The quota on each machine is **2,000,000,000 bytes**, counting eligible audio files in `recordings/`, including archived files in that folder. When needed, the oldest audio is deleted first. Transcript text is preserved, and the interface indicates when a meeting's audio is no longer available.

Capture and processing need temporary disk space. A continuous recording therefore has an output limit of approximately **990 MB**, reserving space to split and process its channels. Reaching this limit stops and saves the recording. Models, the Python environment, and dependencies are outside the audio quota.

Do not copy `recordings/`, `.venv`, or `~/.heed-app/` to install on another Mac. Run the installer on that machine instead.

## Architecture

```mermaid
flowchart TD
    S[Slack: newly connected meeting in local logs] --> A[macOS menu app / LaunchAgent]
    A --> B[Bun API localhost:5001]
    B <--> C[Open browser localhost:5170]
    B --> D[ScreenCaptureKit: system audio]
    B --> E[AVAudioEngine: default microphone]
    D --> K[Native capture: timestamp-aligned channels]
    E --> K
    K --> F[FFmpeg: one PCM input, local stereo WAV]
    F --> G[Python localhost:5002 / MLX previews and native finalization]
    G --> C
    C --> H[Local session JSON and timestamps]
    H --> B
    F --> I[Audio GET/HEAD with HTTP Range]
    B --> I
    I --> J[Player: mono mix, seeking and segment highlights]
    H --> J
```

The menu sends commands to the local API. The open interface receives them and coordinates capture, transcription, and meeting saving. On macOS, one native executable combines ScreenCaptureKit and AVAudioEngine, preserves each channel's timestamps, and supplies one PCM stream to FFmpeg. Recording starts only after the microphone supplies stable audio. The Python service uses MLX Whisper base for bounded live previews. At stop, a short-lived tiny Whisper worker detects English or Portuguese, and a temporary native Parakeet sidecar retranscribes the full audio with timestamps. FluidAudio handles diarization. Manual retranscription can instead use a selected Whisper model in an isolated worker. The installer caches the base and tiny models; additional models download on first use. MLX Whisper declares a Torch package dependency, which is installed even though live inference uses MLX. Pyannote and faster-whisper are optional fallback dependencies. Live voice names are reconciled without assuming speaker numbers stay unchanged. The `/api/sessions/:id/audio` endpoint serves only authorized local files, using GET/HEAD and HTTP Range for seeking without loading the entire file. Highlighting follows the player's actual time and the saved segment timestamps.

## Updates

Stop recording and wait for the meeting to finish saving before updating **each Mac**:

```sh
git pull --ff-only
bash install-macos.sh
```

The installer checks for active capture, commands, or processing and refuses to restart in that state. It preserves local files and reinstalls the app. If you move the checkout, run it again to update the project path used by the menu app.

## Diagnostics and tests

Services are local: interface **5170**, Bun API **5001**, Python transcription **5002**, and Ollama **11434**. Logs are stored in `~/Library/Logs/Heed/`.

```sh
curl -fsS http://localhost:5001/api/desktop/control/status
curl -fsS http://localhost:5001/api/sessions
curl -fsS http://localhost:11434/api/tags
bun run doctor
bun test packages/server/lib
python3 -m unittest discover -s packages/transcription -p voice_identity_test.py
NODE_OPTIONS=--no-experimental-webstorage bun run --cwd packages/client test --run
bun run build
bash packages/desktop/install-menubar.sh --build-only
```

The control status reports `recording`, `processing`, `pending`, `starting`, `ready`, and the interface connection. If the interface is disconnected, reopen `http://localhost:5170`. For an existing meeting, `curl -I http://localhost:5001/api/sessions/ID/audio` checks availability and metadata without downloading the audio.

## Known limitations

Automatic start on macOS supports new meetings in the installed Slack app. Automatic start and stop for Google Meet, Microsoft Teams, and Zoom are not implemented. The original PipeWire-based detector remains Linux-specific.

The previous capture path could discard microphone buffers while combining two FFmpeg inputs, shortening the file and cutting speech. Unified native capture replaces that path. Older recordings may still contain missing audio; this correction applies to new recordings. Playback uses the file's actual duration. Audio that was never captured or was deleted cannot be reconstructed from the transcript.

## Credits and license

Based on [isjunrod/heed](https://github.com/isjunrod/heed), by Junior Rodriguez. The original MIT license is preserved in [LICENSE](LICENSE), and upstream documentation is preserved in [README-upstream.md](README-upstream.md). This fork contains the macOS adaptations maintained at [augustocbx/heed-macos](https://github.com/augustocbx/heed-macos). See also [README-macos.md](README-macos.md).

### Live preview and final transcript

Every recording starts with an English live preview using a smaller, bounded-window model to reduce processing and memory use. The preview is provisional. When recording stops, Heed detects English or Portuguese from sampled speech in the saved audio and always retranscribes the entire recording with the accurate final model. The saved meeting uses the detected language and full-audio timestamps, and preserves manually assigned speaker names where matching is unambiguous. If the final pass fails, the audio stays available for recovery; recovery uses the same language detection and full-audio pass instead of saving the live preview.

## Interface localization

Use **Settings → Interface language** or the menu bar language submenu. English, Portuguese (Brazil), French, and German are available. Unsupported locales and missing translations fall back to English. The per-Mac preference is shared by the menu and interface tabs and remains independent of the English/Portuguese transcription language.
