#!/bin/bash
set -euo pipefail
HEED_DESKTOP="$(cd "$(dirname "$0")" && pwd)"
HEED_PROJECT_ROOT="$(cd "$HEED_DESKTOP/../.." && pwd)"
HEED_BUILD="${TMPDIR:-/tmp}/heed-menubar-build"
mkdir -p "$HEED_BUILD"
swiftc -O -target arm64-apple-macosx14.0 "$HEED_DESKTOP"/macos/*.swift -o "$HEED_BUILD/Heed" -framework AppKit
"$HEED_BUILD/Heed" --self-test
if [ "${1:-}" = "--build-only" ]; then
    printf 'Build verified: %s\n' "$HEED_BUILD/Heed"
    exit 0
fi
if [ "${HEED_LIFECYCLE_GUARD_HELD:-}" != 1 ]; then
    export HEED_LIFECYCLE_GUARD_TOKEN="$(/usr/bin/uuidgen)"
    /usr/bin/python3 "$HEED_DESKTOP/guard-lifecycle.py" acquire
    export HEED_LIFECYCLE_GUARD_HELD=1
    trap '/usr/bin/python3 "$HEED_DESKTOP/guard-lifecycle.py" release || true' EXIT
fi
HEED_APP="$HOME/Applications/Heed.app"
HEED_AGENT="$HOME/Library/LaunchAgents/local.heed.menubar.plist"
# The app may also have been opened from Finder. Stopping only the
# LaunchAgent would leave an older instance running with its previous signature.
launchctl bootout "gui/$(id -u)/local.heed.menubar" 2>/dev/null || true
/usr/bin/python3 - "$HEED_APP/Contents/MacOS/Heed" <<'PYSTOP'
import os, signal, subprocess, sys, time
executable = sys.argv[1]
def belongs(pid):
    command = subprocess.run(['ps', '-p', str(pid), '-o', 'command='], capture_output=True, text=True).stdout.strip()
    return command == executable or command.startswith(executable + ' ')
result = subprocess.run(['pgrep', '-x', 'Heed'], capture_output=True, text=True)
for pid in map(int, result.stdout.split()):
    if not belongs(pid):
        continue
    try:
        os.kill(pid, signal.SIGTERM)
        for _ in range(30):
            if not belongs(pid):
                break
            time.sleep(0.1)
        else:
            if belongs(pid):
                os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
PYSTOP
mkdir -p "$HEED_APP/Contents/MacOS" "$HEED_APP/Contents/Resources"
cp "$HEED_BUILD/Heed" "$HEED_APP/Contents/MacOS/Heed.new"
mv -f "$HEED_APP/Contents/MacOS/Heed.new" "$HEED_APP/Contents/MacOS/Heed"
cp "$HEED_DESKTOP/macos/start-services.sh" "$HEED_APP/Contents/Resources/start-services.sh"
printf '%s\n' "$HEED_PROJECT_ROOT" > "$HEED_APP/Contents/Resources/heed-root.txt"
cat > "$HEED_APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>local.heed.menubar</string>
<key>CFBundleName</key><string>Heed</string>
<key>CFBundleExecutable</key><string>Heed</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSUIElement</key><true/>
<key>NSMicrophoneUsageDescription</key><string>Heed uses the microphone to record your voice during meetings.</string>
<key>NSAppDataUsageDescription</key><string>Heed reads only meeting states from local Slack logs to start recording automatically.</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
</dict></plist>
PLIST
codesign --force --sign - "$HEED_APP"
mkdir -p "$HOME/Library/LaunchAgents"
HEED_APP_EXEC="$HEED_APP/Contents/MacOS/Heed" /usr/bin/python3 - "$HEED_AGENT" <<'PY'
import os, plistlib, sys
with open(sys.argv[1], 'wb') as file:
    plistlib.dump({'Label': 'local.heed.menubar', 'ProgramArguments': [os.environ['HEED_APP_EXEC']], 'RunAtLoad': True}, file)
PY
launchctl bootstrap "gui/$(id -u)" "$HEED_AGENT"
printf 'Installed and launched: %s\n' "$HEED_APP"
