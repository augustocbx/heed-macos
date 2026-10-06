# Releases, installation and removal

Each Heed version is published as a [GitHub Release](https://github.com/augustocbx/heed-macos/releases). Users install a release without cloning the repository; the Git checkout installer (`install-macos.sh`) remains for development.

## Install the latest version

Requirements: an **Apple Silicon** Mac (arm64), **macOS 14 or later**, [Homebrew](https://brew.sh), Apple's Command Line Tools (`xcode-select --install`), an internet connection, and about 5 GB of free disk space for dependencies and speech models. Run everything as your normal user, never with `sudo`.

Open Terminal and run:

```sh
curl -fsSL https://github.com/augustocbx/heed-macos/releases/latest/download/install.sh | bash
```

`releases/latest/download/install.sh` always points to the newest release.

## Install a specific version

Every release page lists its assets. Pick the version on the [Releases page](https://github.com/augustocbx/heed-macos/releases) and use either method:

- **One command:** `curl -fsSL https://github.com/augustocbx/heed-macos/releases/download/v1.2.3/install.sh | bash` (each release's `install.sh` installs its own version). `bash install.sh --version 1.2.3` also works with any release's script.
- **Manual download:** download `heed-macos-1.2.3-arm64.tar.gz` and `SHA256SUMS` into the same folder, then run `bash install.sh --payload heed-macos-1.2.3-arm64.tar.gz` with that release's `install.sh`. Alternatively, double-click the archive to extract it and run `bash install.sh` inside the extracted folder. Check the archive first with `shasum -a 256 -c SHA256SUMS --ignore-missing`.

Installing an older version than the one installed is allowed, but meetings saved by a newer version may use data that the older version does not understand.

## What the installer does

1. Checks the Mac (Apple Silicon, macOS 14+, not `sudo`, Command Line Tools and Homebrew) and verifies the archive's SHA-256 checksum.
2. Installs missing Homebrew packages (`ffmpeg`, `python@3.14`, `ollama`, `node`) and Bun.
3. Prepares the new version in its own folder under `~/.heed/runtime/versions/` while the current version keeps running: Python environment, JavaScript dependencies, self-tests of the bundled executables, and the speech model check (`--skip-model-warmup` defers model downloads to the first meeting).
4. Refuses to continue while Heed is recording, saving, transcribing, or processing; nothing is replaced in that case.
5. Stops only Heed's own services (it never stops an application it does not recognise on Heed's ports), switches `~/.heed/runtime/current` to the new version, installs `~/Applications/Heed.app` and its login item, and waits until the API, interface and transcription services answer **as this exact Heed version and build**.
6. Tests macOS permissions through the menu app and asks macOS to show the Microphone and Screen & System Audio Recording prompts. `--no-permission-prompt` only reports them; `--require-permissions` makes missing permissions an error (exit code 3).

If any step fails, the installer prints an actionable message, keeps the log in `~/Library/Logs/Heed/install-*.log`, removes the partly prepared version, and restores the previous menu app, login item, browser bridge and service version. The previous version folder is kept after an upgrade for recovery.

## Update from the menu

Open **Heed → Updates** to see the installed bundle version, check for a newer stable release,
read its release notes, and choose **Update…**. Checks run at startup when due and at most once
per day automatically; they never install a release. Offline, rate-limited or incomplete checks
remain failures, rather than reporting that Heed is up to date.

The confirmation explains that Heed restarts and macOS permissions may need renewal. The updater
validates the selected release's compatibility, byte sizes, SHA-256 digests and archive entries
before running its pinned installer. Processing includes recording, saving, transcription, notes,
tasks, chat, imports, migrations and synchronization. Finish active work, then select **Retry update**;
Heed does not install later just because processing becomes idle. Downloads themselves do not stop
an active meeting. Preparation can require network access and model downloads.

Menu updates require an API that supports durable update maintenance. If an older installation
does not support it, use the release installer once to migrate; the menu explains this requirement.
Manual installation, menu updates and removal share an advisory lock, stored as a private sibling
of `HEED_HOME` (normally `~/.heed-installation.lock`). An empty lock file may remain after removal.

The detached coordinator keeps state and private technical logs under `~/.heed/updates/`, with
the current result in `~/.heed/update.json`. A replacement menu reads the same result. **View update
log…** opens the transaction log. **Retry recovery** first verifies the retained or restored build
and releases only its matching maintenance lease. It never starts another installation automatically.
If recovery still fails, preserve the runtime, `update.json`, `~/.heed-app/update-maintenance.json`
and any `~/.heed/recovery/` backups, then inspect the log and service status. Do not delete a lease
or overwrite `runtime/current` to bypass recovery. A surviving installer retains the lock even if
its coordinator exits.

### Permissions after updating

Installation success and permission status are separate. Heed checks a fresh report from the new
menu build. Missing permission shows **Permissions need attention**; a restricted microphone
requires the device administrator, and an absent or stale report shows **Could not verify permissions**.
Use **Settings and permissions…** or the specific Microphone / Screen & System Audio Recording
action, then **Check permissions again**. Authorization remains user initiated.

An ad-hoc signature change can invalidate macOS authorization even if preflight still reports it
as allowed. If capture fails after updating, turn the affected Heed permission off and on in
**System Settings → Privacy & Security**, then quit and reopen Heed. Renew Slack log or shared-folder
access only if it stops working. **Permission help after updating…** keeps this guidance available
even after a granted report. Upgrades never reset TCC or request optional access automatically.

See [menu update validation](menu-update-validation.md) for automated coverage and remaining
physical-Mac acceptance.

## Preserved data

Upgrades never move or rewrite user data:

| Data | Location |
| --- | --- |
| Recordings (audio) | `~/.heed/recordings`, or the `recordings` folder of the checkout that was installed before (meetings refer to audio by absolute path, so it stays where it is) |
| Meetings, transcripts, speaker names, settings, tags, tasks | `~/.heed-app` |
| Cloud connection secrets | macOS Keychain (`local.heed.connectors.v1`) |
| Speech models | Shared model caches (Hugging Face, FluidAudio) |
| Logs | `~/Library/Logs/Heed` |
| Application | `~/Applications/Heed.app`, `~/.heed/runtime` |

When Heed was previously installed from a checkout with `install-macos.sh`, the release installer takes over the menu app and services and keeps using that checkout's `recordings` folder. Do not delete that folder; the checkout is otherwise no longer used.

## Uninstall

```sh
bash ~/.heed/bin/uninstall.sh
```

or, without an installed copy, `curl -fsSL https://github.com/augustocbx/heed-macos/releases/latest/download/uninstall.sh | bash -s -- --yes`.

The uninstaller lists everything it will delete and asks you to type `remove` (`--yes` skips the question). It refuses while a meeting is being recorded or processed. It removes the menu app and login item, Heed's services, `~/.heed` (runtime and recordings), `~/.heed-app`, logs, `~/Library/Application Support/Heed`, the menu app's preferences and caches, the Meet browser bridge registration, Keychain items for cloud connections, and resets privacy permissions for the menu app. A previous checkout's `recordings` folder is deleted only when it is recognised as a Heed checkout; the checkout itself is never deleted. The uninstaller then verifies that nothing is left and reports anything it could not remove.

`--keep-data` removes the application but keeps recordings, `~/.heed-app` and Keychain items so a later installation finds them again.

Shared tools are not removed because other software may use them: Homebrew packages, Bun, Ollama and its models, and the speech model caches in `~/.cache/huggingface` and `~/Library/Application Support/FluidAudio`. The uninstaller prints the commands to remove them. If **System Settings → Privacy & Security** still lists `heed-syscap`, remove it there.

## Versions and tags

- `VERSION` holds the semantic version (`MAJOR.MINOR.PATCH`, optionally `-prerelease`).
- A release is published by pushing the tag `v<VERSION>` for the commit that contains that `VERSION`. The release workflow rejects tags that do not match. Tags with a pre-release suffix are published as GitHub pre-releases.
- The version is embedded in the payload's `release.json` (with the tag and commit), in `Heed.app` (`CFBundleShortVersionString`), in `GET /api/version` (`{"app":"heed","component":"api","version",...}`), and in the transcription service's `/health`.
- Each release attaches `release-manifest.json` with the version, commit and the URL, size and SHA-256 of every asset. `https://github.com/augustocbx/heed-macos/releases/latest/download/release-manifest.json` always describes the newest release, for update detection.

To publish: update `VERSION`, merge, then `git tag v1.2.3 && git push origin v1.2.3`. The **Release** workflow builds the assets on an Apple Silicon runner from the tagged commit, runs the installation simulation against them, and publishes the release.

## Release assets

| Asset | Purpose |
| --- | --- |
| `heed-macos-<version>-arm64.tar.gz` | Application payload: tracked source of the tagged commit without development material, the built interface, and the prebuilt arm64 executables (capture, transcription sidecar, menu app, Keychain and iCloud helpers) |
| `install.sh` | Installer pinned to this version |
| `uninstall.sh` | Uninstaller |
| `release-manifest.json` | Version metadata for update checks |
| `SHA256SUMS` | Checksums of all of the above |

The build refuses to package audio files (except the two bundled synthetic test clips), transcripts, session files, environment files, keys, `.git`, `.venv`, `node_modules`, or files over 60 MB. Python and JavaScript dependencies are installed on the Mac during installation from `requirements-core.txt` and `bun.lock`.

## Signing and macOS limitations

- Heed does not have an Apple Developer ID yet. Executables are **ad-hoc signed** and the archive is **not notarized**. The installer verifies the SHA-256 checksum published with the release and then removes the download quarantine from the installed copy only. The checksum proves the download matches the release; it does not prove the publisher the way a Developer ID signature would.
- Because ad-hoc signatures change with every build, macOS may ask for Microphone and Screen & System Audio Recording again after an upgrade, or show Heed as allowed while blocking it. Turn the permission off and on again in System Settings, then reopen Heed.
- A signed and notarized `.pkg` can replace the archive once a Developer ID is available. Until then, installation runs from Terminal.
- Permission prompts need a person at the Mac. Real audio capture is not exercised by the installer; record a short test meeting after installing.
- Loopback ports 48100 (API), 48101 (interface) and 48102 (transcription), or the validated device-local overrides, must be free or used by the matching Heed services. Readiness and shutdown verify service identity and checkout ownership; an unrelated listener is preserved. See [service ports](service-ports.md).
- A checkout predating safe port configuration, or reporting an incomplete recording-work state, must first be migrated with the latest checkout `install-macos.sh`. The release installer refuses replacement rather than guessing ownership or starting services on the old prohibited ports.
- The packaged installer verifies its own versioned transcription service. A separately managed `HEED_TRANSCRIPTION_URL` is supported by checkout runtimes; use a checkout for that configuration, or remove the override before installing the complete packaged stack. An HTTP localhost/127.0.0.1 override on the configured transcription port remains compatible.

## Simulation

`bash scripts/release/simulate.sh` builds release archives from the working tree and runs, in a temporary `HOME` on alternate ports: a fresh installation over a checkout installation with existing recordings, transcripts, speaker names and settings; an upgrade through the download path; a corrupted download; a release whose dependencies cannot be installed; a busy Heed; another application on a Heed port; `uninstall --keep-data`; reinstallation; and complete removal. The packaged services really start and are checked by identity. launchd, Keychain, the privacy database, preferences, Homebrew installs and GitHub downloads are replaced by recording shims, so a Heed installation running on the same Mac is not affected. `--artifacts DIR` tests already built assets; `--keep` keeps the sandbox for inspection.
