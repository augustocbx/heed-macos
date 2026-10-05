#!/bin/bash
set -euo pipefail
HEED_DESKTOP="$(cd "$(dirname "$0")" && pwd)"
HEED_PROJECT_ROOT="$(cd "$HEED_DESKTOP/../.." && pwd)"
HEED_BUILD="${TMPDIR:-/tmp}/heed-menubar-build"
mkdir -p "$HEED_BUILD"
swiftc -O "$HEED_DESKTOP"/macos/*.swift -o "$HEED_BUILD/Heed" -framework AppKit
"$HEED_BUILD/Heed" --self-test
if [ "${1:-}" = "--build-only" ]; then
    printf 'Build verified: %s\n' "$HEED_BUILD/Heed"
    exit 0
fi
HEED_APP="$HOME/Applications/Heed.app"
mkdir -p "$HEED_APP/Contents/MacOS" "$HEED_APP/Contents/Resources"
cp "$HEED_BUILD/Heed" "$HEED_APP/Contents/MacOS/Heed"
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
<key>NSMicrophoneUsageDescription</key><string>O Heed usa o microfone para gravar sua voz durante reuniões.</string>
<key>LSMinimumSystemVersion</key><string>12.0</string>
</dict></plist>
PLIST
codesign --force --sign - "$HEED_APP"
mkdir -p "$HOME/Library/LaunchAgents"
HEED_AGENT="$HOME/Library/LaunchAgents/local.heed.menubar.plist"
HEED_APP_EXEC="$HEED_APP/Contents/MacOS/Heed" /usr/bin/python3 - "$HEED_AGENT" <<'PY'
import os, plistlib, sys
with open(sys.argv[1], 'wb') as file:
    plistlib.dump({'Label': 'local.heed.menubar', 'ProgramArguments': [os.environ['HEED_APP_EXEC']], 'RunAtLoad': True}, file)
PY
launchctl bootout "gui/$(id -u)/local.heed.menubar" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$HEED_AGENT"
printf 'Installed and launched: %s\n' "$HEED_APP"
