#!/bin/bash
set -eu
export PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
HEED_RESOURCE_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$HEED_RESOURCE_DIR/heed-root.txt" ]; then
    IFS= read -r HEED_ROOT < "$HEED_RESOURCE_DIR/heed-root.txt"
else
    HEED_ROOT="$(cd "$HEED_RESOURCE_DIR/../../.." && pwd)"
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
listening() { /usr/sbin/lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }
if ! listening 11434 && ! /usr/bin/pgrep -f 'ollama serve' >/dev/null; then
    nohup ollama serve >>"$HEED_LOG/ollama.log" 2>&1 </dev/null &
fi
if ! listening 5001 && ! listening 5170 && ! listening 5002 && ! /usr/bin/pgrep -f '[/]doctor.py' >/dev/null && ! /usr/bin/pgrep -f 'bun run dev$' >/dev/null; then
    nohup bun run dev >>"$HEED_LOG/services.log" 2>&1 </dev/null &
else
    if ! listening 5001 && ! /usr/bin/pgrep -f '^bun run dev:server$' >/dev/null; then
        nohup bun run dev:server >>"$HEED_LOG/server.log" 2>&1 </dev/null &
    fi
    if ! listening 5170 && ! /usr/bin/pgrep -f '^bun run dev:client$' >/dev/null; then
        nohup bun run dev:client >>"$HEED_LOG/client.log" 2>&1 </dev/null &
    fi
    # Installer doctor warms/downloads models; never race its model work.
    while /usr/bin/pgrep -f '[/]doctor.py' >/dev/null; do sleep 5; done
    if ! listening 5002 && ! /usr/bin/pgrep -f '[/]transcription_server.py' >/dev/null; then
        nohup bun run dev:python >>"$HEED_LOG/python.log" 2>&1 </dev/null &
    fi
fi
