# Troubleshooting

This guide collects known problems in the macOS installation. Interface labels below use English; their translations appear when another interface language is selected. For setup, see [installation](README.md#installation) and [permissions and use](README.md#permissions-and-use).

| Symptom | Start here |
| --- | --- |
| The wrong microphone is recorded | [Default microphone](#default-microphone) |
| Recording fails after three startup attempts | [Bluetooth startup failure](#bluetooth-startup-failure) |
| Bluetooth audio sounds muffled or noisy | [Bluetooth microphone quality](#bluetooth-microphone-quality) |
| Microphone or system audio is denied or unknown | [Permissions](#permissions) |
| The menu, interface, or transcription is unavailable | [Connections and models](#connections-and-models) |
| Automatic notes are missing, waiting, or show zero characters | [Automatic notes](#automatic-notes) |
| An older meeting has missing or shortened audio | [Historical audio and retention](#historical-audio-and-retention) |
| An idle recording screen opens at `00:04` | [Idle recording timer](#idle-recording-timer) |

## Update the installed checkout

Stop recording and wait for transcription and meeting saving to finish. From the installed checkout on `main`, follow the [update procedure](README.md#updates):

```sh
git pull --ff-only
bash install-macos.sh
```

Do this on each Mac. The installer rebuilds the native helpers and interface, reinstalls the menu app, and preserves local recordings and configuration. It checks for active capture or processing before restarting services. Do not run it with `sudo`. If Git reports local changes or a divergent branch, resolve them without discarding local work before continuing.

Updating source alone does not rebuild the installed capture executable:

```text
packages/transcription/native/heed-parakeet/.build/release/heed-syscap
```

Reopen the interface after installation and check permissions again if macOS requests authorization.

## Default microphone

**Symptom:** Heed records a different input from the one you intended, or your voice is absent.

**Checks:** Open **System Settings → Sound → Input** and check the selected device and input level while speaking. Heed uses the default input selected there; selecting a headset only for sound output does not establish which input is active.

**Recovery:** Select your intended input in macOS before starting a new recording. If that input is the QCY headset, keep it selected; Heed does not require the built-in microphone or automatically substitute it. Stop an existing recording before changing the input, then make a short test recording without private content and listen to playback.

**Limitations:** An input-level meter or service health check does not prove that Heed saved intelligible speech. Device configuration changes during recording can still fail with `microphone device configuration changed during recording; start a new recording`; seamless switching is not supported.

## Bluetooth startup failure

**Symptom:** Start recording fails with `microphone did not deliver stable audio after three startup attempts`, sometimes while the headset changes sample rate or Bluetooth profile.

**Checks:** Confirm the default input and [permissions](#permissions). Check that the installed checkout includes [PR #37](https://github.com/augustocbx/heed-macos/pull/37), and that its native helper was rebuilt. Startup diagnostics can show a transition from 44.1 kHz to 16 kHz even though the audio engine reports that it is running.

**Recovery:** [Update the installed checkout](#update-the-installed-checkout), which rebuilds the helper. PR #37 fixes discarded startup buffers and stale graph formats during Bluetooth negotiation. Wait for the selected device to connect, then retry a short recording. If the error persists, retain the error text, device name, macOS version, and installed commit for a report; check [connections and models](#connections-and-models) for logs.

**Limitations:** Candidate validation passed six microphone captures and three full capture/finalization cycles with QCY H3 Pro on the MacBook Pro. This is evidence for startup and stream continuity on that setup, not universal Bluetooth or macOS compatibility. Spoken-meeting quality still needs playback acceptance. Changing devices is an optional comparison, not a required fallback.

## Bluetooth microphone quality

**Symptom:** Headset audio becomes muffled, quieter, or noisy when its microphone is used.

**Checks:** Compare the selected macOS input and output before and during microphone use. [Apple explains](https://support.apple.com/en-ie/102217) that Bluetooth headphones use different modes for listening alone and for simultaneous microphone use and playback; the latter reduces audio quality.

**Optional comparison:** While idle, choose the built-in microphone in **System Settings → Sound → Input** and retain the headset under **Output**. Record the same short phrase in each configuration and compare saved playback. Restore your preferred input afterwards. This is your macOS choice; Heed does not switch inputs automatically.

**Limitations:** A startup fix cannot remove the headset profile's quality limit. Evaluate your voice and the other participants separately in saved playback. See [playback with the transcript](README.md#playback-with-the-transcript) and [Voice Isolation guidance](README.md#macos-voice-isolation-and-heed-capture) for channel layout and a separate comparison of microphone processing.

## Permissions

**Symptom:** Capture is denied, one source is unavailable, or Settings shows an unknown permission status.

**Checks:** Open **Settings** in the interface or **Settings and permissions…** from the menu. Confirm that the native menu app is running: without its connection, the page cannot report permission status. Each Mac needs its own authorization under **System Settings → Privacy & Security**:

- **Microphone** for your voice.
- **Screen & System Audio Recording** for other participants.

**Recovery:** Use the Settings permission controls, accept the macOS prompts, and restart the requesting app when asked. macOS may identify Heed, Bun, or the capture component. If an app update invalidated authorization even though the switch appears enabled, turn its **Screen & System Audio Recording** permission off and on, then accept the requested restart. Retry a short recording after both sources are authorized. See [permissions and use](README.md#permissions-and-use).

**Limitations:** Unknown means the native status connection is unavailable, not necessarily that permission was denied. Authorization does not prove usable audio. Slack log-folder access is separate and does not authorize microphone or system capture.

## Connections and models

**Symptom:** The menu cannot start recording, the interface is disconnected, or transcription is unavailable.

**Checks:** Reopen [the local interface](http://localhost:5170) to inspect the backend recording state or recovery actions. Recording, live transcription and durable final saving continue when all tabs are closed. The default local ports are interface **5170**, Bun API **5001**, Python transcription **5002**, and Ollama **11434**. Check them individually:

```sh
curl -fsS http://localhost:5001/api/desktop/control/status
curl -fsS http://localhost:5001/api/desktop/permissions
curl -fsS http://localhost:5001/api/health
curl -fsS http://localhost:5002/health
curl -fsS http://localhost:11434/api/tags
```

The permissions response's `controllerConnected` describes the native menu app. Recording status contains the authoritative lifecycle `state`, meeting ID and revision, with separate `recording`, `processing`, `starting`, and `ready` indicators. The legacy control `clientConnected` field no longer requires a browser owner. Python health includes model readiness details such as `warm` and `load_error`; the API health summary does not include those fields.

**Recovery:** Reopen the tab to attach to the current meeting. If retained audio needs finalization, retry from the recovery panel. To leave an unrecoverable capture, choose **Keep audio and leave recovery**; Heed retains its audio and speaker checkpoint for manual recovery. Reopen `~/Applications/Heed.app` if the native menu app is not running. If required services or transcription models remain unavailable, wait until capture and saving are idle and run the installer from the intended checkout. While idle, use the installed Python environment's diagnostic:

```sh
bun run doctor
```

Doctor probes models and performs sample inference; it can warm or download models. It is not a passive health check and should not compete with a recording or notes generation. A missing optional Ollama notes model does not prevent transcription, even if the setup summary is not fully ready.

Inspect installed logs in `~/Library/Logs/Heed/`. Depending on how services started, there is a combined `services.log` or individual `server.log`, `client.log`, and `python.log`. `ollama.log` exists when the launcher starts Ollama; `slack-auto.log` contains meeting-detector diagnostics. Not every file is present in every installation. Before sharing diagnostics, remove private meeting text, paths, and credentials; `/api/sessions` includes meeting content and is not a safe public diagnostic dump.

**Limitations:** A responsive endpoint or ready model does not prove microphone/system permissions, successful meeting saving, or intelligible audio. After recovery, make a short test recording and check the saved transcript and playback.

## Automatic notes

**Symptom:** A saved meeting has no automatic notes, the job is waiting or failed, or it shows `0 characters generated`.

**Checks:** In **Settings → Automatic meeting notes**, select an installed **Local notes model**, a valid **Notes template**, and **Notes language**. Enable **Generate notes automatically**, then choose **Save automatic notes settings**. The feature is disabled by default and configured separately on each Mac. Enabling it does not download a model or backfill older meetings. Check the meeting's job status and failure explanation, and use the Ollama model-list check above to confirm the selected model is installed.

**Recovery:** Waiting is expected while recording, capture startup/shutdown, transcription, or manual notes generation uses resources. Allow final transcript and speaker saving to finish. Interrupted jobs restart generation from the beginning when resources are available. For a failed job, restore Ollama/model availability or select an installed model and valid template, save settings, then use the meeting's retry control. If Ollama is stopped, start it before retrying; `ollama serve` starts a local server when none is running. A generation timeout means there was no response activity for five minutes or the total 30-minute limit was reached; check the selected model's performance before retrying. See [automatic notes behavior and validation](docs/automatic-notes.md) for scheduling, restart recovery, cancellation, and replacement rules.

**Zero-character progress:** Thinking-capable models such as `gemma4:31b` can stream reasoning before their final answer. Ollama exposes reasoning and answer fields separately; Heed currently counts only final-answer characters. A running job at zero is therefore not proof of an empty completed result. Inspect its status before cancelling or restarting it. In the observed case, the job completed and saved 360 characters; this verifies persistence, not the quality of those notes. See [Ollama thinking controls and streaming](https://docs.ollama.com/capabilities/thinking). Heed currently has no thinking toggle or reasoning-progress indicator.

**Limitations:** Notes failure does not undo a successfully saved recording or transcript. Character counts and completed status do not establish accuracy. Review generated decisions, actions, owners, deadlines, and source excerpts against the transcript before relying on them. Existing notes are protected; replacing them requires confirmation.

## Historical audio and retention

**Symptom:** An older meeting's audio is shorter than expected, has gaps, or is no longer available.

**Checks:** Compare the player's actual duration with the saved transcript and check whether the interface reports unavailable audio. For a known meeting ID, this checks audio availability and metadata without downloading the recording:

```sh
curl -I http://localhost:5001/api/sessions/ID/audio
```

Replace `ID` with that meeting's ID. Local audio lives in the installed checkout's `recordings/`; saved sessions live in `~/.heed-app/sessions`. The per-Mac quota is **2,000,000,000 bytes** of eligible audio, including archived audio in `recordings/`. Oldest audio is deleted first; meeting transcript text is retained. Continuous capture also has an output limit of approximately **990 MB** to reserve processing space, and reaching it stops and saves the recording. See [storage and retention](README.md#storage-and-retention).

**Recovery:** If an independent backup contains the original file, retain it before investigating. For future recordings, update the installed capture helper and validate a new short recording. Previous capture paths could discard buffers and shorten audio; those fixes apply to new recordings.

**Limitations:** Audio that was never captured or has already been deleted cannot be reconstructed from transcript text. Updating Heed does not repair historical gaps or reverse retention deletion. In another player, the original stereo file has microphone audio on the left and system audio on the right; a channel-specific playback difference alone does not prove missing capture.

## Idle recording timer

**Symptom:** Opening an empty, idle recording screen shows a previous duration such as `00:04`.

**Checks:** Confirm capture is inactive in the menu and control status. Processing or displayed recording results may legitimately retain their own duration; distinguish these from an empty idle screen.

**Recovery:** [PR #39](https://github.com/augustocbx/heed-macos/pull/39) fixes stale desktop polling restoring the previous elapsed time. [Update the installed checkout](#update-the-installed-checkout) to rebuild the interface, then reopen or reload the page while idle. An empty idle recording screen should show `00:00`.

**Limitations:** A stale timer alone is not evidence that recording is active. The correction preserves duration during processing and while results are displayed.
