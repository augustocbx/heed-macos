# Heed menu bar controls

Run `bash packages/desktop/install-menubar.sh` to install the app at `~/Applications/Heed.app`. The `local.heed.menubar` LaunchAgent starts the icon at login without starting a recording. Use `--build-only` to compile and run self-tests without installing or launching it.

The menu lets you start or stop recording and open `http://localhost:48101`. Live preview starts in English; final transcription detects English or Portuguese. Recording and saving continue with every interface tab closed. The icon turns red when the server reports active capture.

**Automatically record Slack meetings** watches newly joined meetings in the installed Slack app. It only starts recording; stop through the Heed menu. Slack log access is granted through a read-only folder picker, separately from microphone and system audio permissions. **Settings and permissions…** opens their status and authorization controls.

Installation stores the checkout path in `Contents/Resources/heed-root.txt`, supporting different users and project directories. Optional AI notes models are selected in the interface.

See [the installation documentation](../../../README-macos.md).
