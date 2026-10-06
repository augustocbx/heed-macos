#!/bin/bash
set -euo pipefail
HEED_DESKTOP="$(cd "$(dirname "$0")" && pwd)"
HEED_PROJECT_ROOT="$(cd "$HEED_DESKTOP/../.." && pwd)"
HEED_VALIDATED_PORTS="$(/usr/bin/python3 - "$HEED_PROJECT_ROOT" <<'PYPORTS'
import sys
sys.path.insert(0, sys.argv[1] + '/scripts')
from service_config import service_config
ports = service_config()
print(ports['api'], ports['ui'], ports['transcription'])
PYPORTS
)"
read -r HEED_API_PORT HEED_UI_PORT HEED_TRANSCRIPTION_PORT <<< "$HEED_VALIDATED_PORTS"
export HEED_API_PORT HEED_UI_PORT HEED_TRANSCRIPTION_PORT
HEED_BUILD="${TMPDIR:-/tmp}/heed-menubar-build"
# Release payloads ship these binaries prebuilt from the tagged commit; checkouts compile them.
HEED_PREBUILT="$HEED_DESKTOP/macos/.build/Heed"
# The menu app starts services from this path; release installs pass their stable "current" link.
HEED_MENU_ROOT="${HEED_MENU_ROOT:-$HEED_PROJECT_ROOT}"
HEED_VERSION="$(/usr/bin/python3 -c 'import json,sys
try: print(json.load(open(sys.argv[1]))["version"])
except Exception: print(open(sys.argv[2]).read().strip())' "$HEED_PROJECT_ROOT/release.json" "$HEED_PROJECT_ROOT/VERSION")"
if ! [[ "$HEED_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
    printf 'Invalid Heed version: %s\n' "$HEED_VERSION" >&2; exit 1
fi
mkdir -p "$HEED_BUILD"
if [ "${1:-}" = "--build-only" ]; then
    HEED_KEYCHAIN_BUILD_DIR="$HEED_BUILD/keychain" bash "$HEED_DESKTOP/native-keychain/build.sh" --build-only
    HEED_ICLOUD_OUTPUT="$HEED_BUILD/heed-icloud" bash "$HEED_DESKTOP/icloud-folder/build.sh"
elif [ "${1:-}" = "--prebuilt" ]; then
    for HEED_BINARY in "$HEED_PREBUILT" "$HEED_DESKTOP/native-keychain/.build/heed-keychain" "$HEED_DESKTOP/icloud-folder/.build/heed-icloud"; do
        if [ ! -x "$HEED_BINARY" ]; then printf 'Prebuilt binary missing: %s\n' "$HEED_BINARY" >&2; exit 1; fi
    done
    "$HEED_DESKTOP/native-keychain/.build/heed-keychain" --self-test >/dev/null
    "$HEED_DESKTOP/icloud-folder/.build/heed-icloud" --self-test >/dev/null
else
    bash "$HEED_DESKTOP/native-keychain/build.sh"
    bash "$HEED_DESKTOP/icloud-folder/build.sh"
fi
if [ "${1:-}" = "--prebuilt" ]; then
    cp "$HEED_PREBUILT" "$HEED_BUILD/Heed"
else
    swiftc -O -target arm64-apple-macosx14.0 "$HEED_DESKTOP"/macos/*.swift -o "$HEED_BUILD/Heed" -framework AppKit
fi
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
cp "$HEED_DESKTOP/native-keychain/.build/heed-keychain" "$HEED_APP/Contents/Resources/heed-keychain"
cp "$HEED_DESKTOP/icloud-folder/.build/heed-icloud" "$HEED_APP/Contents/Resources/heed-icloud"
cp "$HEED_DESKTOP/macos/start-services.sh" "$HEED_APP/Contents/Resources/start-services.sh"
# Keep trusted update code with the app; running transactions copy it before app replacement.
HEED_UPDATE_RESOURCES="$HEED_APP/Contents/Resources/update-helper"
rm -rf "$HEED_UPDATE_RESOURCES"
mkdir -p "$HEED_UPDATE_RESOURCES/scripts/release" "$HEED_UPDATE_RESOURCES/config"
for HEED_HELPER_NAME in heed_release.py installation_lock.py release_updates.py update_state.py update_transaction.py; do
    cp "$HEED_PROJECT_ROOT/scripts/release/$HEED_HELPER_NAME" "$HEED_UPDATE_RESOURCES/scripts/release/$HEED_HELPER_NAME"
done
cp "$HEED_PROJECT_ROOT/scripts/service_config.py" "$HEED_PROJECT_ROOT/scripts/service_runtime.py" "$HEED_UPDATE_RESOURCES/scripts/"
cp "$HEED_PROJECT_ROOT/config/service-ports.json" "$HEED_UPDATE_RESOURCES/config/"
printf '%s\n' "${HEED_HOME:-$HOME/.heed}" > "$HEED_APP/Contents/Resources/heed-home.txt"
printf '%s\n' "${HEED_APP_DIR:-$HOME/.heed-app}" > "$HEED_APP/Contents/Resources/heed-app-dir.txt"

printf '%s\n' "$HEED_MENU_ROOT" > "$HEED_APP/Contents/Resources/heed-root.txt"
if [ -n "${HEED_RECORDINGS_DIR:-}" ]; then
    printf '%s\n' "$HEED_RECORDINGS_DIR" > "$HEED_APP/Contents/Resources/heed-recordings-dir.txt"
else
    rm -f "$HEED_APP/Contents/Resources/heed-recordings-dir.txt"
fi
if [ -f "$HEED_PROJECT_ROOT/release.json" ]; then
    cp "$HEED_PROJECT_ROOT/release.json" "$HEED_APP/Contents/Resources/release.json"
else
    rm -f "$HEED_APP/Contents/Resources/release.json"
fi
/usr/bin/python3 - "$HEED_PROJECT_ROOT/config/service-ports.json" "$HEED_APP/Contents/Resources/service-ports.json" <<'PYRESOURCE'
import json, os, sys
with open(sys.argv[1]) as source:
    ports = json.load(source)
ports.update(api=int(os.environ['HEED_API_PORT']), ui=int(os.environ['HEED_UI_PORT']), transcription=int(os.environ['HEED_TRANSCRIPTION_PORT']))
with open(sys.argv[2], 'w') as destination:
    json.dump(ports, destination)
    destination.write('\n')
PYRESOURCE
cat > "$HEED_APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>local.heed.menubar</string>
<key>CFBundleName</key><string>Heed</string>
<key>CFBundleExecutable</key><string>Heed</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>$HEED_VERSION</string>
<key>CFBundleVersion</key><string>$HEED_VERSION</string>
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
    environment = {key: os.environ[key] for key in ['HEED_API_PORT', 'HEED_UI_PORT', 'HEED_TRANSCRIPTION_PORT']}
    for key in ['HEED_HOME', 'HEED_APP_DIR', 'HEED_RECORDINGS_DIR', 'HEED_TRANSCRIPTION_URL']:
        if key in os.environ:
            environment[key] = os.environ[key]
    plistlib.dump({'Label': 'local.heed.menubar', 'ProgramArguments': [os.environ['HEED_APP_EXEC']], 'RunAtLoad': True, 'EnvironmentVariables': environment}, file)
PY
/usr/bin/python3 "$HEED_PROJECT_ROOT/scripts/service_config.py" api --save > /dev/null
launchctl bootstrap "gui/$(id -u)" "$HEED_AGENT"
printf 'Installed and launched: %s\n' "$HEED_APP"
