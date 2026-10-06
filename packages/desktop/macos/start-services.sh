#!/bin/bash
set -eu
export PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
HEED_RESOURCE_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$HEED_RESOURCE_DIR/heed-root.txt" ]; then
    IFS= read -r HEED_ROOT < "$HEED_RESOURCE_DIR/heed-root.txt"
else
    HEED_ROOT="$(cd "$HEED_RESOURCE_DIR/../../.." && pwd)"
fi
# Release installs keep recordings outside the versioned runtime so upgrades never move them.
if [ -f "$HEED_RESOURCE_DIR/heed-recordings-dir.txt" ]; then
    IFS= read -r HEED_RECORDINGS_DIR < "$HEED_RESOURCE_DIR/heed-recordings-dir.txt"
    export HEED_RECORDINGS_DIR
fi
if [ ! -f "$HEED_ROOT/package.json" ]; then
    printf 'Heed checkout not found: %s\n' "$HEED_ROOT" >&2
    exit 1
fi
HEED_LOG="$HOME/Library/Logs/Heed"
mkdir -p "$HEED_LOG"
# Kernel advisory guard is released on crash/reboot and serializes stale mkdir
# reclamation. The PID directory remains useful when upgrading from older apps.
HEED_LOCK="$HEED_LOG/service-bootstrap.lock"
if [ "${1:-}" != "--locked" ]; then
    exec /usr/bin/python3 - "$HEED_LOCK.guard" "$0" <<'PYLOCK'
import fcntl, subprocess, sys
with open(sys.argv[1], "a") as guard:
    try:
        fcntl.flock(guard, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        sys.exit(0)
    sys.exit(subprocess.call(["/bin/bash", sys.argv[2], "--locked"]))
PYLOCK
fi
if ! mkdir "$HEED_LOCK" 2>/dev/null; then
    HEED_OWNER="$(cat "$HEED_LOCK/pid" 2>/dev/null || true)"
    if [[ "$HEED_OWNER" =~ ^[0-9]+$ ]] && kill -0 "$HEED_OWNER" 2>/dev/null; then exit 0; fi
    rm -f "$HEED_LOCK/pid"
    rmdir "$HEED_LOCK" 2>/dev/null || exit 0
    mkdir "$HEED_LOCK" 2>/dev/null || exit 0
fi
printf '%s\n' "$$" > "$HEED_LOCK/pid"
cleanup() {
    if [ "$(cat "$HEED_LOCK/pid" 2>/dev/null || true)" = "$$" ]; then
        rm -f "$HEED_LOCK/pid"
        rmdir "$HEED_LOCK" 2>/dev/null || true
    fi
}
trap cleanup EXIT
cd "$HEED_ROOT"
# Ollama remains on its established port; never terminate another listener.
if ! /usr/sbin/lsof -nP -iTCP:11434 -sTCP:LISTEN >/dev/null 2>&1 && ! /usr/bin/pgrep -f 'ollama serve' >/dev/null; then
    nohup ollama serve >>"$HEED_LOG/ollama.log" 2>&1 </dev/null &
fi
# Identity and ownership checks live in the tested Python helper. A listening
# port alone never establishes that API, interface or transcription is Heed.
/usr/bin/python3 "$HEED_ROOT/scripts/service_runtime.py" start --root "$HEED_ROOT" --log-dir "$HEED_LOG"
