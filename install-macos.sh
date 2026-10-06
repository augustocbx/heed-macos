#!/bin/bash
# Install this checkout without replacing recordings or configuration.
set -euo pipefail
HEED_INSTALL_ROOT="$(cd "$(dirname "$0")" && pwd)"
export PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
if [ "$(uname -s)" != Darwin ] || [ "$(uname -m)" != arm64 ]; then
    printf 'This installer requires macOS on Apple Silicon.\n' >&2; exit 1
fi
HEED_OS_MAJOR="$(sw_vers -productVersion | cut -d. -f1)"
if [ "$HEED_OS_MAJOR" -lt 14 ]; then
    printf 'This installer requires macOS 14 or later.\n' >&2; exit 1
fi
if ! xcode-select -p >/dev/null 2>&1; then
    printf 'Install Command Line Tools with xcode-select --install and run this installer again.\n' >&2; exit 1
fi
if ! command -v brew >/dev/null 2>&1; then
    printf 'Install Homebrew from https://brew.sh and run this installer again. This installer does not use sudo.\n' >&2; exit 1
fi
HEED_BREW_PACKAGES=()
for HEED_PACKAGE in ffmpeg python@3.14 ollama node; do
    if ! brew list --versions "$HEED_PACKAGE" >/dev/null 2>&1; then HEED_BREW_PACKAGES+=("$HEED_PACKAGE"); fi
done
if [ "${#HEED_BREW_PACKAGES[@]}" -gt 0 ]; then
    HOMEBREW_NO_AUTO_UPDATE=1 brew install "${HEED_BREW_PACKAGES[@]}"
fi
if ! command -v bun >/dev/null 2>&1; then
    HEED_BUN_INSTALLER="$(mktemp -t heed-bun-install)"
    trap 'rm -f "$HEED_BUN_INSTALLER"' EXIT
    curl --fail --location --silent --show-error https://bun.sh/install -o "$HEED_BUN_INSTALLER"
    bash "$HEED_BUN_INSTALLER"
    rm -f "$HEED_BUN_INSTALLER"
    trap - EXIT
fi
# Reserve the lifecycle before updating services; capture cannot start between checks.
if [ "${HEED_LIFECYCLE_GUARD_HELD:-}" != 1 ]; then
    export HEED_LIFECYCLE_GUARD_TOKEN="$(/usr/bin/uuidgen)"
    /usr/bin/python3 "$HEED_INSTALL_ROOT/packages/desktop/guard-lifecycle.py" acquire
    export HEED_LIFECYCLE_GUARD_HELD=1
    trap '/usr/bin/python3 "$HEED_INSTALL_ROOT/packages/desktop/guard-lifecycle.py" release || true' EXIT
fi
cd "$HEED_INSTALL_ROOT"
HEED_PYTHON="$(brew --prefix python@3.14)/bin/python3.14"
if [ ! -x .venv/bin/python3 ]; then "$HEED_PYTHON" -m venv .venv; fi
.venv/bin/python3 -m pip install -r packages/transcription/requirements-core.txt
# Cache the small live model and language detector before the first meeting.
.venv/bin/python3 packages/transcription/meeting_language.py warmup
bun install --frozen-lockfile
swift build --package-path packages/transcription/native/heed-parakeet -c release --product heed-parakeet
swift build --package-path packages/transcription/native/heed-parakeet -c release --product heed-syscap
packages/transcription/native/heed-parakeet/.build/release/heed-syscap --self-test
bun run build
bun run doctor
# Restart only services from this checkout after confirming that they are still idle.
HEED_INSTALL_ROOT="$HEED_INSTALL_ROOT" /usr/bin/python3 - <<'PYRESTART'
import json, os, signal, subprocess, urllib.request, urllib.error, sys, time
try:
    with urllib.request.urlopen('http://localhost:5001/api/desktop/control/status', timeout=5) as response: state=json.load(response)
except urllib.error.URLError as error:
    if isinstance(error.reason, ConnectionRefusedError): state={}
    else: sys.exit('Could not check the Heed status before restarting.')
if any(state.get(key) for key in ['recording','processing','pending','starting']): sys.exit('An active meeting prevents restarting Heed services.')
root=os.path.realpath(os.environ['HEED_INSTALL_ROOT'])
for port in [5001,5170,5002]:
    output=subprocess.run(['/usr/sbin/lsof','-t','-nP',f'-iTCP:{port}','-sTCP:LISTEN'],capture_output=True,text=True).stdout
    for pid in set(output.split()):
        cwd=subprocess.run(['/usr/sbin/lsof','-a','-p',pid,'-d','cwd','-Fn'],capture_output=True,text=True).stdout
        paths=[line[1:] for line in cwd.splitlines() if line.startswith('n')]
        if not paths or os.path.commonpath([root,os.path.realpath(paths[0])])!=root:
            sys.exit(f'Port {port} belongs to another project. Its process was not stopped.')
        os.kill(int(pid),signal.SIGTERM)
time.sleep(2)
PYRESTART
bash packages/desktop/install-menubar.sh
printf '\nHeed is installed. Open http://localhost:5170 to view meetings; menu recordings also work with every tab closed.\n'
printf 'Allow system audio capture and microphone access in System Settings.\n'
