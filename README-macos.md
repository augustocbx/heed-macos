# Heed on macOS

Local installation for Apple Silicon Macs running macOS 14 or later. Transcription supports Brazilian Portuguese (`pt`) and English (`en`), detected automatically after recording. The interface and menu support English, Brazilian Portuguese, French, and German, with English as the fallback. Installation instructions remain in English.

## Install or update

Install [Homebrew](https://brew.sh) and Apple's Command Line Tools first. If the tools are missing, run:

```sh
xcode-select --install
```

Install or update to the latest release:

```sh
curl -fsSL https://github.com/augustocbx/heed-macos/releases/latest/download/install.sh | bash
```

Pick another version on the [Releases page](https://github.com/augustocbx/heed-macos/releases); [docs/releases.md](docs/releases.md) explains specific versions, upgrades, permissions, uninstalling (`bash ~/.heed/bin/uninstall.sh`) and the signing limitations. Do not run the installer with `sudo`.

The installer installs FFmpeg, Python, Node.js, and Ollama through Homebrew, Bun when needed, Python dependencies, and the menu app with its prebuilt Swift transcription and capture executables. The first health check can download transcription models and take several minutes. Optional AI notes models are not downloaded automatically. At the end it tests the Microphone and Screen & System Audio Recording permissions and asks macOS to show their prompts.

Stop recording and wait for processing and saving to finish before updating. Recordings, meetings in `~/.heed-app/`, speaker names, settings and connections are preserved. Do not copy these folders between machines to install the app. The installer refuses to restart active recordings or processing, and restores the previous version if the new one does not start.

To develop from a checkout instead, clone the repository and run `bash install-macos.sh`; update it with `git pull --ff-only` and the same command. If you move the checkout, run the installer again to update the project path used by the menu app.

## Use

The app is installed at `~/Applications/Heed.app` and starts at login through the `local.heed.menubar` LaunchAgent. The menu lets you start, stop, and open [the interface](http://127.0.0.1:48101). Recording, transcription and saving continue with every interface tab closed; reopening attaches to the backend-owned meeting.

**Automatically record Slack meetings** is enabled by default. New meetings/huddles in the installed Slack app start recording after a few seconds, with an English live preview. The backend performs capture and saving without requiring an interface tab. A confirmed meeting end stops capture automatically; you can also stop through Heed's menu. A manual stop does not restart the same meeting. The monitor follows new local log states without storing messages, and does not start meetings that were already active when Heed opened. Slack in a browser is not monitored. Optional Zoom/Teams desktop and scoped Chrome/Edge Google Meet detection are disabled by default; see [automatic meeting detection](docs/meeting-detection.md) for authorization, setup and remaining physical application/version acceptance. The menu shows detector status, and diagnostics are written to `~/Library/Logs/Heed/slack-auto.log`. Slack log format changes may require detector updates.

If an authorization picker appears, select the exact Slack **logs** folder and click **Allow log access**. **Allow Slack log access…** in the menu lets you repeat this. Authorization is read-only and limited to that folder; Full Disk Access is not required. Check for **Slack: waiting for the next meeting**, then join a new meeting to test. Authorize each Mac separately.

In **System Settings → Privacy & Security**, allow **Screen & System Audio Recording** and **Microphone** for the component requested by macOS. If no prompt appears, check these settings manually. The capture executable is `packages/transcription/native/heed-parakeet/.build/release/heed-syscap` inside `~/.heed/runtime/current` (or inside the checkout for checkout installations). Permissions must be granted separately on each Mac. System audio capture works with headphones.

Use **Settings** in the interface or **Settings and permissions…** in the menu to check this Mac's permissions and open their System Settings sections. The page also reports when the native app is disconnected. After an update, you may need to turn Heed's recording permission off and on again even when it appears enabled, then accept the restart requested by macOS.

Audio is stored locally in `~/.heed/recordings` (or `recordings/` in a checkout installation). The managed meeting-data quota defaults to **2,000,000,000 bytes per machine** and can be changed in **Settings → Storage**. It includes retained audio, meeting text, indexes and temporary work; eligible private audio is reclaimed oldest first while transcripts and protected data remain. Capture reserves space for finalization copies, so its output allowance depends on the available quota; reaching the allowance stops and saves the recording. Models and dependencies are outside this quota. See [managed storage quota](docs/managed-storage-quota.md) for accounting and cleanup protections. Each installation keeps independent local files.

The interface defaults to loopback port **48101**, API **48100**, transcription **48102**, and Ollama **11434**. Validated device-local overrides are described in [service ports](docs/service-ports.md); Heed service ports reject the prohibited 3000–3999, 5000–5999, 7000–7999 and 8000–8999 ranges. Logs are stored in `~/Library/Logs/Heed/`. Check installation and models with:

```sh
bun run doctor
```

For a reversible comparison of Standard and Voice Isolation and an explanation of the audio paths, see [macOS Voice Isolation and Heed capture](README.md#macos-voice-isolation-and-heed-capture).

## Playback synchronized with the transcript

Open **Meetings**, choose a meeting, and use the audio player above its transcript. The segment matching the audio time is highlighted and kept visible. Click a segment, or use Enter/Space, to play from that point. Overlapping speech can highlight multiple segments. Synchronization uses segment timestamps, not individual words.

The player uses the audio file's actual duration, which may differ from the recording timer. It does not artificially rescale timestamps. If audio has expired under the 2 GB retention policy, the transcript remains available and the interface reports that the audio is unavailable.

See [README.md](README.md) for the native capture architecture, storage paths, troubleshooting, and limitations.

### Live preview and final transcript

Every recording starts with an English live preview using a smaller, bounded-window model to reduce processing and memory use. The preview is provisional. When recording stops, Heed detects English or Portuguese from sampled speech in the saved audio and always retranscribes the entire recording with the accurate final model. The saved meeting uses the detected language and full-audio timestamps, and preserves manually assigned speaker names where matching is unambiguous. If the final pass fails, the audio stays available for recovery; recovery uses the same language detection and full-audio pass instead of saving the live preview.

To retranscribe a saved meeting manually, open **Meetings**, select the meeting, and click **Transcribe**. Choose **Parakeet v3** (the default), **Whisper base**, **small**, **medium**, or **large-v3**, and select automatic English/Portuguese detection, English, or Portuguese (Brazil). A selected model downloads locally on first use when needed. Larger models require more memory and time. Heed shows progress and blocks new recordings while transcription runs; it replaces the meeting transcript only after the complete result is saved, preserving the original audio and unambiguously matched speaker names, and correcting duration from the complete audio when available. If transcription or saving fails, the existing meeting stays available.

Meeting cards and details show the meeting language and the live/final transcription models recorded for the meeting. Older meetings without model metadata do not display an assumed model. Manual transcription updates the final model while retaining the original live model.

## Interface language

Choose **Interface language** in Settings or in the menu bar to switch between English, Portuguese (Brazil), French, and German. The preference is stored on each Mac and shared between its menu and open interface tabs. Unsupported locales and untranslated strings fall back to English. This setting affects app labels, not recorded speech: live transcription still starts in English, and the final pass detects English or Portuguese. Installation documentation and technical logs remain in English.
