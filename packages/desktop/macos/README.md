# Heed menu bar controls

Run `bash packages/desktop/install-menubar.sh` to install the app at `~/Applications/Heed.app`. The `local.heed.menubar` LaunchAgent starts the icon at login without starting a recording. Use `--build-only` to compile and run self-tests without installing or launching it.

The menu lets you start or stop recording and open `http://localhost:48101`. Live preview starts in English; final transcription detects English or Portuguese. Recording and saving continue with every interface tab closed. The icon turns red when the server reports active capture.

**Automatically record Slack meetings** watches newly joined meetings in the installed Slack app. It only starts recording; stop through the Heed menu. Slack log access is granted through a read-only folder picker, separately from microphone and system audio permissions. **Settings and permissions…** opens their status and authorization controls.

Installation stores the checkout path in `Contents/Resources/heed-root.txt`, supporting different users and project directories. Optional AI notes models are selected in the interface.

See [the installation documentation](../../../README-macos.md).

**Updates** displays the installed app version, checks stable releases, opens release notes and
starts a confirmed update. Checks are automatic when the daily interval is due; installation and
busy/recovery retries require an explicit action. Download and installation work run outside the
main thread, and the coordinator survives replacing the menu app. All four interface languages
include update and permission guidance.

After an upgrade, the new menu reports its version, commit and instance identity with permissions.
**Permissions need attention** opens the required System Settings destination; **Check permissions
again** reads a fresh report. A granted report keeps conditional signature-renewal help available.
No update permission check starts recording or resets privacy permissions.

Run `bash scripts/release/menu-update-qa.sh` from the repository root for a separate, explicit local
QA menu. Its isolated bundle and data replace only themselves, use fixture downloads, and simulate
the installer, maintenance and service readiness. This harness does not prove real capture or the
production installer; the release simulation covers that separate integration.
