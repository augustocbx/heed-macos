#!/bin/bash
# Remove Heed from this Mac: menu app, login item, services, runtime, settings, logs and data.
#
#   bash ~/.heed/bin/uninstall.sh [--keep-data] [--yes]
#   curl -fsSL https://github.com/augustocbx/heed-macos/releases/latest/download/uninstall.sh | bash -s -- --yes
#
# Options:
#   --keep-data   Keep recordings, transcripts, speaker names and settings (~/.heed-app and the recordings folder).
#   --yes         Do not ask for confirmation.
#   --help        Show this help.
#
# Shared tools that other apps may use are not removed: Homebrew packages, Bun, Ollama models and
# downloaded speech model caches. The uninstaller lists them with the commands to remove them.
set -euo pipefail
HEED_RELEASE_VERSION="development"
HEED_HOME="${HEED_HOME:-$HOME/.heed}"
# Canonical HEED_HOME; never /, the home folder, one of its ancestors, or a system folder.
HEED_HOME="$(/usr/bin/python3 - "$HEED_HOME" "$HOME" <<'PYHOME'
import os, sys
path, home = sys.argv[1], os.path.realpath(sys.argv[2])
if not os.path.isabs(path):
    sys.exit("HEED_HOME must be an absolute path.")
real = os.path.realpath(path)
protected = {"/", "/Users", "/System", "/Library", "/Applications", "/private", "/tmp", "/private/tmp", "/var", "/usr", "/opt"}
if real in protected or real == home or home.startswith(real.rstrip("/") + "/"):
    sys.exit("HEED_HOME must be a dedicated folder, not %s." % real)
print(real)
PYHOME
)" || exit 64
HEED_KEEP_DATA=0
HEED_ASSUME_YES=0
while [ "$#" -gt 0 ]; do
    case "$1" in
        --keep-data) HEED_KEEP_DATA=1; shift ;;
        --yes|-y) HEED_ASSUME_YES=1; shift ;;
        --help|-h) sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) printf 'Unknown option: %s. Run with --help for usage.\n' "$1" >&2; exit 64 ;;
    esac
done
if [ "$(id -u)" = 0 ]; then printf 'Run the uninstaller as the user who installed Heed, without sudo.\n' >&2; exit 1; fi

HEED_TEMP="$(mktemp -d -t heed-uninstall)"
trap 'rm -rf "$HEED_TEMP"' EXIT
# The helper is copied out first because the uninstaller removes the folder it lives in.
HEED_HELPER="$HEED_TEMP/heed_release.py"
HEED_SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
for HEED_CANDIDATE in "$HEED_HOME/runtime/current/scripts/release/heed_release.py" \
    "$HEED_SELF_DIR/heed_release.py" "$HEED_SELF_DIR/scripts/release/heed_release.py" "$HEED_HOME/bin/heed_release.py"; do
    if [ -f "$HEED_CANDIDATE" ]; then
        cp "$HEED_CANDIDATE" "$HEED_HELPER"
        for HEED_MODULE in "$(dirname "$HEED_CANDIDATE")/lifecycle_metadata.py" "$(dirname "$HEED_CANDIDATE")/../lifecycle_metadata.py"; do
            if [ -f "$HEED_MODULE" ]; then cp "$HEED_MODULE" "$HEED_TEMP/lifecycle_metadata.py"; break; fi
        done
        break
    fi
done
if [ ! -f "$HEED_HELPER" ]; then
    curl --fail --location --silent --show-error \
        "https://raw.githubusercontent.com/augustocbx/heed-macos/v$HEED_RELEASE_VERSION/scripts/release/heed_release.py" -o "$HEED_HELPER" 2>/dev/null \
        || { printf 'The Heed uninstall helper was not found. Download uninstall.sh from a Heed release.\n' >&2; exit 1; }
fi
helper() { /usr/bin/python3 "$HEED_HELPER" "$@"; }
HEED_STATE="$HEED_HOME/install.json"
HEED_APP="$HOME/Applications/Heed.app"
HEED_AGENT="$HOME/Library/LaunchAgents/local.heed.menubar.plist"

# --- What belongs to Heed ---------------------------------------------------------------------
HEED_ROOTS=("$HEED_HOME/runtime/current")
HEED_APP_ROOT=""
if [ -f "$HEED_APP/Contents/Resources/heed-root.txt" ]; then IFS= read -r HEED_APP_ROOT < "$HEED_APP/Contents/Resources/heed-root.txt" || true; fi
HEED_LEGACY_ROOT="$( [ -f "$HEED_STATE" ] && helper state "$HEED_STATE" --get legacyRoot || true)"
[ -n "$HEED_APP_ROOT" ] && HEED_ROOTS+=("$HEED_APP_ROOT")
[ -n "$HEED_LEGACY_ROOT" ] && HEED_ROOTS+=("$HEED_LEGACY_ROOT")
# Resolve the same bounded private settings as the services, before any stopping or removal.
HEED_CONFIG_CANDIDATES=(--candidate "$HEED_HOME/runtime/current" --candidate "$HEED_APP_ROOT" --candidate "$HEED_SELF_DIR")
if [ "$(basename "$HEED_SELF_DIR")" = release ] && [ "$(basename "$(dirname "$HEED_SELF_DIR")")" = scripts ]; then
    HEED_CONFIG_CANDIDATES+=(--candidate "$HEED_SELF_DIR/../..")
fi
HEED_SERVICE_CONFIG_ROOT="$(helper config-root "${HEED_CONFIG_CANDIDATES[@]}")" || {
    printf 'Preserve the installation and migrate its checkout with the latest install-macos.sh before uninstalling. Nothing was removed.\n' >&2
    exit 1
}
export HEED_SERVICE_CONFIG_ROOT
HEED_LOCK_HELPER="$HEED_SERVICE_CONFIG_ROOT/scripts/release/installation_lock.py"
[ -f "$HEED_LOCK_HELPER" ] || { printf 'The installed runtime does not support safe installation locking. Nothing was removed.\n' >&2; exit 1; }
export HEED_HOME
if [ -z "${HEED_INSTALL_LOCK_FD:-}" ]; then
    HEED_UNINSTALL_SOURCE="${BASH_SOURCE[0]:-}"
    [ -f "$HEED_UNINSTALL_SOURCE" ] || HEED_UNINSTALL_SOURCE="$HEED_HOME/bin/uninstall.sh"
    [ -f "$HEED_UNINSTALL_SOURCE" ] || HEED_UNINSTALL_SOURCE="$HEED_SERVICE_CONFIG_ROOT/uninstall.sh"
    cp "$HEED_UNINSTALL_SOURCE" "$HEED_TEMP/uninstall.sh"
    HEED_LOCK_ARGS=()
    [ "$HEED_KEEP_DATA" != 1 ] || HEED_LOCK_ARGS+=(--keep-data)
    [ "$HEED_ASSUME_YES" != 1 ] || HEED_LOCK_ARGS+=(--yes)
    HEED_LOCK_STATUS=0
    /usr/bin/python3 "$HEED_LOCK_HELPER" run --home "$HEED_HOME" -- /bin/bash "$HEED_TEMP/uninstall.sh" ${HEED_LOCK_ARGS[@]+"${HEED_LOCK_ARGS[@]}"} || HEED_LOCK_STATUS=$?
    exit "$HEED_LOCK_STATUS"
fi
/usr/bin/python3 "$HEED_LOCK_HELPER" verify --home "$HEED_HOME" --fd "$HEED_INSTALL_LOCK_FD" || exit 1

HEED_VALIDATED_PORTS="$(helper ports)" || { printf 'Invalid Heed service ports. Nothing was removed.\n' >&2; exit 1; }
HEED_PREVIOUS_PORTS="$(helper ports --saved)" || { printf 'Invalid saved Heed service ports. Nothing was removed.\n' >&2; exit 1; }
HEED_PREVIOUS_PORT_ARGS=()
if [ -n "$HEED_PREVIOUS_PORTS" ]; then read -r -a HEED_PREVIOUS_PORT_ARGS <<< "$HEED_PREVIOUS_PORTS"; fi
read -r HEED_API_PORT HEED_UI_PORT HEED_TRANSCRIPTION_PORT <<< "$HEED_VALIDATED_PORTS"
export HEED_API_PORT HEED_UI_PORT HEED_TRANSCRIPTION_PORT
HEED_RECORDINGS="$( [ -f "$HEED_STATE" ] && helper state "$HEED_STATE" --get recordingsDir || true)"
if [ -z "$HEED_RECORDINGS" ] && [ -n "$HEED_APP_ROOT" ] && [ -d "$HEED_APP_ROOT/recordings" ]; then HEED_RECORDINGS="$HEED_APP_ROOT/recordings"; fi
if [ -f "$HEED_APP/Contents/Resources/heed-recordings-dir.txt" ] && [ -z "$HEED_RECORDINGS" ]; then
    IFS= read -r HEED_RECORDINGS < "$HEED_APP/Contents/Resources/heed-recordings-dir.txt" || true
fi

HEED_REMOVE=(
    "$HEED_APP"
    "$HEED_AGENT"
    "$HOME/Library/Logs/Heed"
    "$HOME/Library/Application Support/Heed"
    "$HOME/Library/Preferences/local.heed.menubar.plist"
    "$HOME/Library/Caches/local.heed.menubar"
    "$HOME/Library/HTTPStorages/local.heed.menubar"
    "$HOME/Library/HTTPStorages/local.heed.menubar.binarycookies"
    "$HOME/Library/Saved Application State/local.heed.menubar.savedState"
)
while IFS= read -r HEED_HOST; do [ -n "$HEED_HOST" ] && HEED_REMOVE+=("$HEED_HOST"); done < <(helper native-hosts)
HEED_KEPT=()
if [ "$HEED_KEEP_DATA" = 1 ]; then
    HEED_REMOVE+=("$HEED_HOME/runtime" "$HEED_HOME/bin")
    HEED_KEPT+=("$HOME/.heed-app")
    [ -n "$HEED_RECORDINGS" ] && HEED_KEPT+=("$HEED_RECORDINGS")
else
    HEED_REMOVE+=("$HOME/.heed-app")
    # Remove the whole folder only when it is recognisably a Heed installation.
    if [ -f "$HEED_HOME/install.json" ] || [ -d "$HEED_HOME/runtime" ]; then HEED_REMOVE+=("$HEED_HOME"); fi
    # A legacy checkout's recordings folder is Heed data, but the checkout itself is the user's.
    if [ -n "$HEED_RECORDINGS" ]; then
        case "$HEED_RECORDINGS" in
            "$HEED_HOME"/*) ;;
            *) if helper owned-recordings "$HEED_RECORDINGS"; then HEED_REMOVE+=("$HEED_RECORDINGS")
               else HEED_KEPT+=("$HEED_RECORDINGS (not a recognised Heed recordings folder; delete it yourself if it is no longer needed)"); fi ;;
        esac
    fi
fi

printf 'This removes Heed from this Mac:\n'
for HEED_PATH in "${HEED_REMOVE[@]}"; do [ -e "$HEED_PATH" ] || [ -L "$HEED_PATH" ] && printf '  - %s\n' "$HEED_PATH"; done
[ "$HEED_KEEP_DATA" = 1 ] || printf '  - Keychain items for cloud connections (service local.heed.connectors.v1)\n'
printf '  - macOS privacy permissions granted to the Heed menu app\n'
if [ "$HEED_KEEP_DATA" = 1 ]; then
    printf 'Kept (--keep-data), including Keychain items that the kept settings refer to:\n'
else
    printf 'All recordings, transcripts, speaker names, settings and connection credentials are deleted permanently.\n'
    [ "${#HEED_KEPT[@]}" -gt 0 ] && printf 'Not removed:\n'
fi
for HEED_PATH in ${HEED_KEPT[@]+"${HEED_KEPT[@]}"}; do printf '  - %s\n' "$HEED_PATH"; done
if [ "$HEED_ASSUME_YES" != 1 ]; then
    if [ ! -r /dev/tty ]; then printf 'Run again with --yes to confirm without a terminal.\n' >&2; exit 1; fi
    printf 'Type "remove" to continue: '
    IFS= read -r HEED_ANSWER < /dev/tty || HEED_ANSWER=""
    [ "$HEED_ANSWER" = remove ] || { printf 'Nothing was removed.\n'; exit 1; }
fi

# --- Stop Heed safely --------------------------------------------------------------------------
HEED_BUSY_STATUS=0
helper busy --root "${HEED_APP_ROOT:-$HEED_SERVICE_CONFIG_ROOT}" || HEED_BUSY_STATUS=$?
case "$HEED_BUSY_STATUS" in
    0) ;;
    2) printf 'Nothing was removed.\n' >&2; exit 1 ;;
    *) printf 'Heed is recording, saving or transcribing. Wait until it finishes, then run the uninstaller again. Nothing was removed.\n' >&2; exit 1 ;;
esac
HEED_GUARD="$(ls "$HEED_HOME/runtime/current/packages/desktop/guard-lifecycle.py" "$HEED_APP_ROOT/packages/desktop/guard-lifecycle.py" 2>/dev/null | head -1 || true)"
if [ -n "$HEED_GUARD" ]; then
    export HEED_LIFECYCLE_GUARD_TOKEN="$(/usr/bin/uuidgen)"
    /usr/bin/python3 "$HEED_GUARD" acquire \
        || { printf 'Heed is recording, saving or transcribing. Wait until it finishes, then run the uninstaller again. Nothing was removed.\n' >&2; exit 1; }
fi
launchctl bootout "gui/$(id -u)/local.heed.menubar" 2>/dev/null || true
/usr/bin/python3 - "$HEED_APP/Contents/MacOS/Heed" <<'PYSTOP'
import os, signal, subprocess, sys, time
executable = sys.argv[1]
for pid in map(int, subprocess.run(['pgrep', '-x', 'Heed'], capture_output=True, text=True).stdout.split()):
    command = subprocess.run(['ps', '-p', str(pid), '-o', 'command='], capture_output=True, text=True).stdout.strip()
    if command == executable or command.startswith(executable + ' '):
        try: os.kill(pid, signal.SIGTERM)
        except ProcessLookupError: pass
time.sleep(1)
PYSTOP
HEED_ROOT_ARGS=()
for HEED_ROOT in "${HEED_ROOTS[@]}"; do HEED_ROOT_ARGS+=(--root "$HEED_ROOT"); done
helper stop-services "${HEED_ROOT_ARGS[@]}" --ports "$HEED_API_PORT" "$HEED_UI_PORT" "$HEED_TRANSCRIPTION_PORT" ${HEED_PREVIOUS_PORT_ARGS[@]+"${HEED_PREVIOUS_PORT_ARGS[@]}"} \
    || { printf 'Heed services could not be stopped safely. Nothing was removed.\n' >&2; exit 1; }

# --- Remove -------------------------------------------------------------------------------------
for HEED_PATH in "${HEED_REMOVE[@]}"; do rm -rf "$HEED_PATH"; done
if [ "$HEED_KEEP_DATA" = 1 ]; then
    # Remember only where the kept data lives so a later installation reuses it.
    /usr/bin/python3 - "$HEED_STATE" "$HEED_RECORDINGS" "$HEED_LEGACY_ROOT" <<'PYSTATE'
import json, os, sys
path, recordings, legacy = sys.argv[1:]
os.makedirs(os.path.dirname(path), exist_ok=True)
with open(path + ".new", "w") as f:
    json.dump({key: value for key, value in {"recordingsDir": recordings, "legacyRoot": legacy}.items() if value}, f, indent=2)
os.replace(path + ".new", path)
PYSTATE
fi
defaults delete local.heed.menubar >/dev/null 2>&1 || true
if [ "$HEED_KEEP_DATA" != 1 ]; then
    HEED_KEYCHAIN_REMOVED=0
    while security delete-generic-password -s local.heed.connectors.v1 >/dev/null 2>&1; do
        HEED_KEYCHAIN_REMOVED=$((HEED_KEYCHAIN_REMOVED + 1))
        [ "$HEED_KEYCHAIN_REMOVED" -lt 1000 ] || break
    done
fi
tccutil reset All local.heed.menubar >/dev/null 2>&1 || true

# --- Verify -------------------------------------------------------------------------------------
HEED_REMAINING="$(helper remaining "${HEED_REMOVE[@]}" || true)"
HEED_PROBLEMS=0
if [ -n "$HEED_REMAINING" ]; then printf 'Could not remove:\n%s\n' "$HEED_REMAINING" >&2; HEED_PROBLEMS=1; fi
if launchctl print "gui/$(id -u)/local.heed.menubar" >/dev/null 2>&1; then printf 'The login item local.heed.menubar is still loaded.\n' >&2; HEED_PROBLEMS=1; fi
if [ "$HEED_KEEP_DATA" != 1 ] && security find-generic-password -s local.heed.connectors.v1 >/dev/null 2>&1; then
    printf 'Some Keychain items remain; remove "local.heed.connectors.v1" entries in Keychain Access.\n' >&2; HEED_PROBLEMS=1
fi
if [ "$HEED_PROBLEMS" != 0 ]; then printf '\nHeed was only partially removed.\n' >&2; exit 1; fi

printf '\nHeed was removed from this Mac.\n'
printf 'If System Settings > Privacy & Security still lists Heed or heed-syscap, remove them there with the minus button.\n'
printf 'Shared tools were left installed. Remove them only if nothing else uses them:\n'
printf '  brew uninstall ffmpeg python@3.14 ollama node    # Homebrew packages\n'
printf '  rm -rf ~/.bun                                     # Bun\n'
printf '  ollama list / ollama rm MODEL                     # AI notes models\n'
printf '  ~/.cache/huggingface, ~/Library/Application Support/FluidAudio   # speech model caches\n'
