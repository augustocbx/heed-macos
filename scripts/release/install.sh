#!/bin/bash
# Install or upgrade Heed from a published GitHub release, without a Git checkout.
#
#   curl -fsSL https://github.com/augustocbx/heed-macos/releases/latest/download/install.sh | bash
#   bash install.sh [--version 1.2.3 | --payload heed-macos-1.2.3-arm64.tar.gz] [options]
#
# Options:
#   --version VERSION       Install that published release instead of this script's version.
#   --payload PATH          Install a downloaded release archive (verified against SHA256SUMS beside it).
#   --skip-model-warmup     Do not pre-download transcription models; they download on first use.
#   --require-permissions   Fail when microphone or screen & system audio recording is not allowed.
#   --no-permission-prompt  Report permissions without asking macOS to show its prompts.
#   --help                  Show this help.
#
# Recordings, transcripts, speaker names, settings, models and private connection state are kept.
# The previous version stays installed until the new one is verified, and is restored on failure.
set -euo pipefail
HEED_RELEASE_VERSION="development"
HEED_REPOSITORY="${HEED_REPOSITORY:-augustocbx/heed-macos}"
HEED_HOME="${HEED_HOME:-$HOME/.heed}"
HEED_READY_TIMEOUT="${HEED_READY_TIMEOUT:-900}"
export PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

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
HEED_REQUESTED_VERSION=""
HEED_PAYLOAD_ARG=""
HEED_SKIP_WARMUP=0
HEED_REQUIRE_PERMISSIONS=0
HEED_PERMISSION_PROMPT=1
while [ "$#" -gt 0 ]; do
    case "$1" in
        --version) HEED_REQUESTED_VERSION="${2#v}"; shift 2 ;;
        --payload) HEED_PAYLOAD_ARG="$2"; shift 2 ;;
        --skip-model-warmup) HEED_SKIP_WARMUP=1; shift ;;
        --require-permissions) HEED_REQUIRE_PERMISSIONS=1; shift ;;
        --no-permission-prompt) HEED_PERMISSION_PROMPT=0; shift ;;
        --help|-h) sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) printf 'Unknown option: %s. Run with --help for usage.\n' "$1" >&2; exit 64 ;;
    esac
done

step() { printf '\n==> %s\n' "$*"; }
fail() { printf '\nInstallation failed: %s\n' "$1" >&2; [ -n "${HEED_LOG:-}" ] && printf 'Full log: %s\n' "$HEED_LOG" >&2; exit 1; }

# --- Requirements -----------------------------------------------------------------------------
if [ "$(uname -s)" != Darwin ] || [ "$(uname -m)" != arm64 ]; then fail 'Heed requires macOS on an Apple Silicon Mac (arm64).'; fi
HEED_OS_MAJOR="$(sw_vers -productVersion | cut -d. -f1)"
if [ "$HEED_OS_MAJOR" -lt 14 ]; then fail "Heed requires macOS 14 or later; this Mac runs $(sw_vers -productVersion)."; fi
if [ "$(id -u)" = 0 ]; then fail 'Do not run the installer with sudo. Run it as the user who will record meetings.'; fi
if ! xcode-select -p >/dev/null 2>&1; then fail 'Install Apple Command Line Tools with "xcode-select --install", then run the installer again.'; fi
if ! command -v brew >/dev/null 2>&1; then fail 'Install Homebrew from https://brew.sh, then run the installer again.'; fi

mkdir -p "$HOME/Library/Logs/Heed" "$HEED_HOME"
chmod 700 "$HEED_HOME"
HEED_HOME="$(cd "$HEED_HOME" && pwd -P)"
HEED_LOG="$HOME/Library/Logs/Heed/install-$(date +%Y%m%d-%H%M%S).log"
exec > >(tee -a "$HEED_LOG") 2>&1
HEED_TEMP="$(mktemp -d -t heed-install)"
HEED_STAGE=""
HEED_GUARD_HELD=0
HEED_COMMITTED=0
HEED_SWITCHED=0
HEED_KEEP_STAGE=0

cleanup() {
    local status=$?
    if [ "$HEED_GUARD_HELD" = 1 ] && [ "$HEED_COMMITTED" = 1 ]; then
        /usr/bin/python3 "$HEED_CURRENT/packages/desktop/guard-lifecycle.py" release >/dev/null 2>&1 || true
    fi
    if [ "$status" != 0 ] && [ "$HEED_COMMITTED" = 0 ]; then
        # The running version was never stopped: give it back its recording ability first.
        if [ "$HEED_GUARD_HELD" = 1 ] && [ "$HEED_SWITCHED" = 0 ] && [ -f "$HEED_GUARD_SCRIPT" ]; then
            /usr/bin/python3 "$HEED_GUARD_SCRIPT" release >/dev/null 2>&1 || true
        fi
        if [ "$HEED_SWITCHED" = 1 ]; then rollback; fi
        if [ "$HEED_KEEP_STAGE" = 1 ]; then rm -rf "$HEED_TEMP"; return; fi
        if [ -n "$HEED_STAGE" ] && [ -d "$HEED_STAGE" ]; then rm -rf "$HEED_STAGE"; fi
        printf 'The existing Heed installation and its data were left in place.\n' >&2
    fi
    rm -rf "$HEED_TEMP"
}
trap cleanup EXIT

# --- Locate and verify the release payload ----------------------------------------------------
HEED_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
verify_checksum() { # archive, SHA256SUMS
    local name expected actual
    name="$(basename "$1")"
    expected="$(awk -v name="$name" '$2 == name || $2 == "*" name {print $1}' "$2")"
    [ -n "$expected" ] || fail "SHA256SUMS does not list $name."
    actual="$(shasum -a 256 "$1" | awk '{print $1}')"
    [ "$expected" = "$actual" ] || fail "Checksum mismatch for $name. Download it again from https://github.com/$HEED_REPOSITORY/releases."
    printf 'Checksum verified: %s\n' "$name"
}
extract_payload() { # archive
    tar -xzf "$1" -C "$HEED_TEMP" || fail "Could not extract $1."
    HEED_PAYLOAD="$(find "$HEED_TEMP" -mindepth 1 -maxdepth 1 -type d -name 'heed-macos-*' | head -1)"
    [ -n "$HEED_PAYLOAD" ] || fail "The archive does not contain a Heed release."
}
if [ -n "$HEED_PAYLOAD_ARG" ]; then
    if [ -d "$HEED_PAYLOAD_ARG" ]; then
        HEED_PAYLOAD="$(cd "$HEED_PAYLOAD_ARG" && pwd)"
    else
        [ -f "$HEED_PAYLOAD_ARG" ] || fail "Release archive not found: $HEED_PAYLOAD_ARG"
        HEED_SUMS="$(dirname "$HEED_PAYLOAD_ARG")/SHA256SUMS"
        [ -f "$HEED_SUMS" ] || fail "Download SHA256SUMS from the same release next to $(basename "$HEED_PAYLOAD_ARG")."
        verify_checksum "$HEED_PAYLOAD_ARG" "$HEED_SUMS"
        extract_payload "$HEED_PAYLOAD_ARG"
    fi
elif [ -z "$HEED_REQUESTED_VERSION" ] && [ -n "$HEED_SCRIPT_DIR" ] && [ -f "$HEED_SCRIPT_DIR/release.json" ] && [ -d "$HEED_SCRIPT_DIR/packages" ]; then
    # Running install.sh from an extracted release archive.
    HEED_PAYLOAD="$HEED_SCRIPT_DIR"
else
    HEED_VERSION_TO_GET="${HEED_REQUESTED_VERSION:-$HEED_RELEASE_VERSION}"
    if [ "$HEED_VERSION_TO_GET" = development ] || [ "$HEED_VERSION_TO_GET" = latest ]; then
        HEED_VERSION_TO_GET="$(curl --fail --location --silent --show-error "https://api.github.com/repos/$HEED_REPOSITORY/releases/latest" \
            | /usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin)["tag_name"].lstrip("v"))')" \
            || fail "Could not find the latest release. Check the network connection or pass --version."
    fi
    [[ "$HEED_VERSION_TO_GET" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || fail "Invalid version: $HEED_VERSION_TO_GET"
    HEED_BASE_URL="https://github.com/$HEED_REPOSITORY/releases/download/v$HEED_VERSION_TO_GET"
    HEED_ARCHIVE="$HEED_TEMP/heed-macos-$HEED_VERSION_TO_GET-arm64.tar.gz"
    step "Downloading Heed $HEED_VERSION_TO_GET"
    curl --fail --location --show-error --progress-bar "$HEED_BASE_URL/$(basename "$HEED_ARCHIVE")" -o "$HEED_ARCHIVE" \
        || fail "Could not download Heed $HEED_VERSION_TO_GET. Check that the release exists at https://github.com/$HEED_REPOSITORY/releases."
    curl --fail --location --silent --show-error "$HEED_BASE_URL/SHA256SUMS" -o "$HEED_TEMP/SHA256SUMS" || fail "Could not download SHA256SUMS."
    verify_checksum "$HEED_ARCHIVE" "$HEED_TEMP/SHA256SUMS"
    extract_payload "$HEED_ARCHIVE"
fi
HEED_HELPER="$HEED_PAYLOAD/scripts/release/heed_release.py"
[ -f "$HEED_PAYLOAD/release.json" ] && [ -f "$HEED_HELPER" ] || fail "$HEED_PAYLOAD is not a Heed release payload."
export HEED_SERVICE_CONFIG_ROOT="$HEED_PAYLOAD"
HEED_VALIDATED_PORTS="$(/usr/bin/python3 "$HEED_HELPER" ports --owned-release)" || fail 'Invalid Heed service configuration. Follow the diagnostic above; preserve service-ports.json and existing services.'
HEED_PREVIOUS_PORTS="$(/usr/bin/python3 "$HEED_HELPER" ports --saved)" || fail 'Invalid saved Heed service ports. Nothing was replaced.'
HEED_PRIOR_PORTS_EXISTED=0
[ -z "$HEED_PREVIOUS_PORTS" ] || HEED_PRIOR_PORTS_EXISTED=1
HEED_PREVIOUS_PORT_ARGS=()
if [ -n "$HEED_PREVIOUS_PORTS" ]; then read -r -a HEED_PREVIOUS_PORT_ARGS <<< "$HEED_PREVIOUS_PORTS"; fi
read -r HEED_API_PORT HEED_UI_PORT HEED_TRANSCRIPTION_PORT <<< "$HEED_VALIDATED_PORTS"
export HEED_API_PORT HEED_UI_PORT HEED_TRANSCRIPTION_PORT
HEED_VERSION="$(/usr/bin/python3 "$HEED_HELPER" release-field "$HEED_PAYLOAD/release.json" version)"
if [ -n "$HEED_REQUESTED_VERSION" ] && [ "$HEED_REQUESTED_VERSION" != "$HEED_VERSION" ]; then
    fail "The payload contains Heed $HEED_VERSION, not the requested $HEED_REQUESTED_VERSION."
fi
for HEED_BINARY in packages/transcription/native/heed-parakeet/.build/release/heed-parakeet \
    packages/transcription/native/heed-parakeet/.build/release/heed-syscap packages/desktop/macos/.build/Heed \
    packages/desktop/native-keychain/.build/heed-keychain packages/desktop/icloud-folder/.build/heed-icloud; do
    [ -f "$HEED_PAYLOAD/$HEED_BINARY" ] || fail "The payload is missing $HEED_BINARY."
done
HEED_COMMIT="$(/usr/bin/python3 "$HEED_HELPER" release-field "$HEED_PAYLOAD/release.json" commit)"
printf 'Installing Heed %s (commit %s) into %s\n' "$HEED_VERSION" "$HEED_COMMIT" "$HEED_HOME"

HEED_RUNTIME="$HEED_HOME/runtime"
HEED_VERSIONS="$HEED_RUNTIME/versions"
HEED_CURRENT="$HEED_RUNTIME/current"
HEED_STATE="$HEED_HOME/install.json"
HEED_APP="$HOME/Applications/Heed.app"
HEED_AGENT="$HOME/Library/LaunchAgents/local.heed.menubar.plist"
state() { /usr/bin/python3 "$HEED_HELPER" state "$HEED_STATE" "$@"; }
mkdir -p "$HEED_VERSIONS"

# --- Existing installation -------------------------------------------------------------------
HEED_PREVIOUS_DIR=""
if [ -L "$HEED_CURRENT" ]; then HEED_PREVIOUS_DIR="$(cd "$HEED_CURRENT" 2>/dev/null && pwd -P || true)"; fi
HEED_LEGACY_ROOT=""
if [ -f "$HEED_APP/Contents/Resources/heed-root.txt" ]; then
    IFS= read -r HEED_APP_ROOT < "$HEED_APP/Contents/Resources/heed-root.txt" || true
    case "$HEED_APP_ROOT" in
        "$HEED_CURRENT"|"$HEED_RUNTIME"/*) ;;
        *) [ -f "$HEED_APP_ROOT/package.json" ] && HEED_LEGACY_ROOT="$(cd "$HEED_APP_ROOT" && pwd -P)" ;;
    esac
fi
[ -n "$HEED_LEGACY_ROOT" ] || HEED_LEGACY_ROOT="$(state --get legacyRoot)"
HEED_PREVIOUS_ROOT="${HEED_PREVIOUS_DIR:-$HEED_LEGACY_ROOT}"
if [ -n "$HEED_PREVIOUS_ROOT" ] && [ ! -f "$HEED_PREVIOUS_ROOT/scripts/service_config.py" ]; then
    fail 'The previous checkout predates safe service-port configuration. Migrate that checkout with the latest install-macos.sh first, then retry the release installer. Its services and data were not replaced.'
fi
if [ -n "$HEED_PREVIOUS_ROOT" ] && [ "$HEED_PRIOR_PORTS_EXISTED" = 0 ]; then
    HEED_PREVIOUS_PORTS="$(HEED_SERVICE_CONFIG_ROOT="$HEED_PREVIOUS_ROOT" /usr/bin/python3 "$HEED_HELPER" ports --defaults)" \
        || fail 'Could not validate the previous checkout defaults. Nothing was replaced.'
    read -r -a HEED_PREVIOUS_PORT_ARGS <<< "$HEED_PREVIOUS_PORTS"
fi
if [ -n "$HEED_PREVIOUS_DIR" ]; then
    printf 'Upgrading from Heed %s.\n' "$(state --get version)"
elif [ -n "$HEED_LEGACY_ROOT" ]; then
    printf 'Replacing the checkout installation at %s (the checkout itself is not modified).\n' "$HEED_LEGACY_ROOT"
fi
# Sessions store absolute audio paths, so recordings stay where they already are.
HEED_RECORDINGS="$(state --get recordingsDir)"
if [ -z "$HEED_RECORDINGS" ]; then
    if [ -n "$HEED_LEGACY_ROOT" ] && [ -d "$HEED_LEGACY_ROOT/recordings" ]; then
        HEED_RECORDINGS="$HEED_LEGACY_ROOT/recordings"
    else
        HEED_RECORDINGS="$HEED_HOME/recordings"
    fi
fi
mkdir -p "$HEED_RECORDINGS"
printf 'Recordings folder: %s\n' "$HEED_RECORDINGS"

# --- Runtime dependencies --------------------------------------------------------------------
# The direct SMB environment is separate from transcription Python 3.14.
# Refuse a missing/incompatible prerequisite before dependency downloads or activation.
HEED_SMB_PYTHON="${HEED_SMB_PYTHON:-/opt/homebrew/opt/python@3.12/bin/python3.12}"
[ -x "$HEED_SMB_PYTHON" ] || fail 'Direct SMB requires Python 3.12. Run "brew install python@3.12", then retry; the running installation is preserved.'
/usr/bin/python3 "$HEED_PAYLOAD/packages/server/native/smb-direct/runtime.py" verify-payload "$HEED_PAYLOAD" \
    || fail 'The locked direct SMB dependency payload is incomplete or corrupt. Download the release again.'
/usr/bin/python3 "$HEED_PAYLOAD/packages/server/native/smb-direct/runtime.py" verify-python "$HEED_PAYLOAD" --python "$HEED_SMB_PYTHON" \
    || fail 'The direct SMB prerequisite must be Python 3.12 on macOS 14 or newer, arm64; the running installation is preserved.'
step 'Checking runtime dependencies (Homebrew: ffmpeg, python@3.14, ollama, node; Bun)'
HEED_BREW_PACKAGES=()
for HEED_PACKAGE in ffmpeg python@3.14 ollama node; do
    if ! brew list --versions "$HEED_PACKAGE" >/dev/null 2>&1; then HEED_BREW_PACKAGES+=("$HEED_PACKAGE"); fi
done
if [ "${#HEED_BREW_PACKAGES[@]}" -gt 0 ]; then
    HOMEBREW_NO_AUTO_UPDATE=1 brew install "${HEED_BREW_PACKAGES[@]}" || fail "Homebrew could not install ${HEED_BREW_PACKAGES[*]}. Run \"brew doctor\" and try again."
    for HEED_PACKAGE in "${HEED_BREW_PACKAGES[@]}"; do state --add "homebrewInstalled=$HEED_PACKAGE"; done
fi
if ! command -v bun >/dev/null 2>&1; then
    curl --fail --location --silent --show-error https://bun.sh/install -o "$HEED_TEMP/bun-install.sh" || fail 'Could not download the Bun installer.'
    bash "$HEED_TEMP/bun-install.sh" || fail 'Bun installation failed.'
    state --set bunInstalledByHeed=true
fi
HEED_PYTHON="$(brew --prefix python@3.14)/bin/python3.14"
[ -x "$HEED_PYTHON" ] || fail "Python 3.14 from Homebrew was not found at $HEED_PYTHON."

# --- Prepare the new version beside the current one ------------------------------------------
step "Preparing Heed $HEED_VERSION (the running version is not touched yet)"
HEED_STAGE="$HEED_VERSIONS/$HEED_VERSION-$(date +%Y%m%d%H%M%S)"
ditto "$HEED_PAYLOAD" "$HEED_STAGE"
# The archive's checksum was verified; remove the download quarantine from this copy only.
xattr -dr com.apple.quarantine "$HEED_STAGE" 2>/dev/null || true
cd "$HEED_STAGE"
"$HEED_STAGE/packages/transcription/native/heed-parakeet/.build/release/heed-syscap" --self-test >/dev/null \
    || fail 'The bundled capture executable failed its self-test.'
"$HEED_STAGE/packages/desktop/macos/.build/Heed" --self-test >/dev/null || fail 'The bundled menu app failed its self-test.'
/usr/bin/python3 "$HEED_STAGE/packages/server/native/smb-direct/runtime.py" install "$HEED_STAGE" --python "$HEED_SMB_PYTHON" \
    || fail 'The offline direct SMB environment could not be prepared; the running installation is preserved.'
"$HEED_STAGE/runtime/smb/bin/python" -I -B "$HEED_STAGE/packages/server/native/smb-direct/runtime.py" self-test "$HEED_STAGE" \
    || fail 'The direct SMB runtime failed its detached self-test; the running installation is preserved.'
"$HEED_PYTHON" -m venv .venv || fail 'Could not create the Python environment.'
.venv/bin/python3 -m pip install --disable-pip-version-check -r packages/transcription/requirements-core.txt \
    || fail 'Python dependencies could not be installed. Check the network connection and run the installer again.'
bun install --frozen-lockfile || fail 'JavaScript dependencies could not be installed. Check the network connection and run the installer again.'
if [ "$HEED_SKIP_WARMUP" = 1 ]; then
    printf 'Skipping model warmup; transcription models download on the first meeting.\n'
else
    printf 'Downloading and checking transcription models. The first installation can take several minutes.\n'
    .venv/bin/python3 packages/transcription/meeting_language.py warmup || fail 'The language detection model could not be prepared.'
    bun run doctor || fail 'The transcription self-test failed. See the output above.'
fi
cd "$HEED_HOME"

# --- Switch versions -------------------------------------------------------------------------
step 'Checking that no meeting is being recorded or processed'
HEED_BUSY_STATUS=0
/usr/bin/python3 "$HEED_HELPER" busy --root "${HEED_PREVIOUS_DIR:-${HEED_LEGACY_ROOT:-$HEED_STAGE}}" || HEED_BUSY_STATUS=$?
case "$HEED_BUSY_STATUS" in
    0) ;;
    2) fail 'Could not verify complete recording status from the expected Heed build. Check the service diagnostic above; migrate an unsupported checkout with the latest install-macos.sh first. Nothing was replaced.' ;;
    *) fail 'Heed is recording, saving or transcribing. Wait until it finishes, then run the installer again.' ;;
esac
# The guard imports runtime helpers and verifies its own checkout root. Keep its tree intact.
HEED_GUARD_SCRIPT="$HEED_STAGE/packages/desktop/guard-lifecycle.py"
if [ -n "$HEED_PREVIOUS_DIR" ]; then HEED_GUARD_SCRIPT="$HEED_PREVIOUS_DIR/packages/desktop/guard-lifecycle.py"
elif [ -n "$HEED_LEGACY_ROOT" ]; then HEED_GUARD_SCRIPT="$HEED_LEGACY_ROOT/packages/desktop/guard-lifecycle.py"; fi
export HEED_LIFECYCLE_GUARD_TOKEN="$(/usr/bin/uuidgen)"
/usr/bin/python3 "$HEED_GUARD_SCRIPT" acquire \
    || fail 'Heed is recording, saving or transcribing. Wait until it finishes, then run the installer again.'
HEED_GUARD_HELD=1
export HEED_LIFECYCLE_GUARD_HELD=1
/usr/bin/python3 "$HEED_HELPER" busy --root "${HEED_PREVIOUS_DIR:-${HEED_LEGACY_ROOT:-$HEED_STAGE}}" \
    || fail 'Heed is recording, saving or transcribing. Wait until it finishes, then run the installer again.'

HEED_BACKUP="$HEED_TEMP/backup"
mkdir -p "$HEED_BACKUP"
[ -d "$HEED_APP" ] && ditto "$HEED_APP" "$HEED_BACKUP/Heed.app"
[ -f "$HEED_AGENT" ] && cp -p "$HEED_AGENT" "$HEED_BACKUP/agent.plist"
mkdir -p "$HEED_BACKUP/native-hosts"
while IFS= read -r HEED_HOST; do
    [ -n "$HEED_HOST" ] && printf '%s\n' "$HEED_HOST" >> "$HEED_BACKUP/native-hosts.list" && cp -p "$HEED_HOST" "$HEED_BACKUP/native-hosts/$(printf '%s' "$HEED_HOST" | shasum | cut -c1-12).json"
done < <(/usr/bin/python3 "$HEED_HELPER" native-hosts)

stop_heed() {
    launchctl bootout "gui/$(id -u)/local.heed.menubar" 2>/dev/null || true
    /usr/bin/python3 "$HEED_HELPER" stop-services --root "$HEED_RUNTIME" ${HEED_LEGACY_ROOT:+--root "$HEED_LEGACY_ROOT"} \
        --ports "$HEED_API_PORT" "$HEED_UI_PORT" "$HEED_TRANSCRIPTION_PORT" ${HEED_PREVIOUS_PORT_ARGS[@]+"${HEED_PREVIOUS_PORT_ARGS[@]}"}
}
switch_current() { # target directory or empty
    if [ -n "$1" ]; then
        ln -sfn "$1" "$HEED_RUNTIME/current.new" && mv -fh "$HEED_RUNTIME/current.new" "$HEED_CURRENT"
    else
        rm -f "$HEED_CURRENT"
    fi
}
rollback() {
    # A meeting or transcription may have started on the new version while it was being verified.
    # Taking the maintenance guard is atomic: it fails while any audio work runs, and blocks new work.
    if ! /usr/bin/python3 "$HEED_HELPER" busy --root "$HEED_STAGE" >/dev/null 2>&1 \
        || ! /usr/bin/python3 "$HEED_STAGE/packages/desktop/guard-lifecycle.py" acquire >/dev/null 2>&1; then
        printf '\nHeed %s is running and busy, so it was not rolled back. Run the installer again after the meeting.\n' "$HEED_VERSION" >&2
        HEED_KEEP_STAGE=1
        return 0
    fi
    printf '\nRestoring the previous installation...\n' >&2
    if ! stop_heed >/dev/null 2>&1; then
        printf 'Heed %s could not be stopped, so it was left installed. Check ~/Library/Logs/Heed.\n' "$HEED_VERSION" >&2
        HEED_KEEP_STAGE=1
        return 0
    fi
    local restore_failed=0
    if [ -f "$HEED_BACKUP/native-hosts.list" ]; then
        while IFS= read -r HEED_HOST; do
            cp -p "$HEED_BACKUP/native-hosts/$(printf '%s' "$HEED_HOST" | shasum | cut -c1-12).json" "$HEED_HOST" || true
        done < "$HEED_BACKUP/native-hosts.list"
    fi
    switch_current "$HEED_PREVIOUS_DIR" || restore_failed=1
    # The menu installer saves device ports before launching. Restore the old bridge/bootstrap
    # configuration before restarting its app, including envless browser-native hosts.
    local old_api old_ui old_transcription
    if [ -n "$HEED_PREVIOUS_PORTS" ]; then
        read -r old_api old_ui old_transcription <<< "$HEED_PREVIOUS_PORTS"
        if [ "${HEED_PRIOR_PORTS_EXISTED:-1}" = 1 ]; then
            HEED_API_PORT="$old_api" PORT="$old_api" HEED_UI_PORT="$old_ui" HEED_TRANSCRIPTION_PORT="$old_transcription" \
                /usr/bin/python3 "$HEED_STAGE/scripts/service_config.py" api --save > /dev/null || restore_failed=1
        else
            /usr/bin/python3 "$HEED_HELPER" restore-port-absence > /dev/null || restore_failed=1
        fi
    fi
    rm -rf "$HEED_APP" || restore_failed=1
    if [ -d "$HEED_BACKUP/Heed.app" ]; then ditto "$HEED_BACKUP/Heed.app" "$HEED_APP" || restore_failed=1; fi
    if [ -f "$HEED_BACKUP/agent.plist" ]; then
        cp -p "$HEED_BACKUP/agent.plist" "$HEED_AGENT" || restore_failed=1
        launchctl bootstrap "gui/$(id -u)" "$HEED_AGENT" 2>/dev/null || restore_failed=1
    else
        rm -f "$HEED_AGENT"
    fi
    if [ "$HEED_GUARD_HELD" = 1 ]; then
        local restored_root="${HEED_PREVIOUS_DIR:-$HEED_LEGACY_ROOT}"
        if [ -n "$restored_root" ] && [ "$restore_failed" = 0 ]; then
            HEED_API_PORT="${old_api:-$HEED_API_PORT}" PORT="${old_api:-$HEED_API_PORT}" \
                HEED_UI_PORT="${old_ui:-$HEED_UI_PORT}" HEED_TRANSCRIPTION_PORT="${old_transcription:-$HEED_TRANSCRIPTION_PORT}" \
                /usr/bin/python3 "$HEED_HELPER" wait-api --root "$restored_root" --timeout 20 > /dev/null \
                && HEED_API_PORT="${old_api:-$HEED_API_PORT}" PORT="${old_api:-$HEED_API_PORT}" \
                   HEED_UI_PORT="${old_ui:-$HEED_UI_PORT}" HEED_TRANSCRIPTION_PORT="${old_transcription:-$HEED_TRANSCRIPTION_PORT}" \
                   /usr/bin/python3 "$HEED_GUARD_SCRIPT" release > /dev/null || restore_failed=1
        else
            restore_failed=1
        fi
    fi
    if [ "$restore_failed" = 1 ]; then
        # Keep everything that may still be referenced, including the backups, for manual recovery.
        HEED_KEEP_STAGE=1
        mkdir -p "$HEED_HOME/recovery" && ditto "$HEED_BACKUP" "$HEED_HOME/recovery/$(date +%Y%m%d-%H%M%S)" || true
        printf 'The previous installation could not be fully restored. Backups were saved in %s/recovery.\n' "$HEED_HOME" >&2
        return 0
    fi
    printf 'The previous installation was restored.\n' >&2
}

step 'Stopping the running Heed services'
stop_heed || fail 'Heed services could not be stopped safely. Nothing was replaced.'
HEED_SWITCHED=1
switch_current "$HEED_STAGE"
step 'Installing the menu app'
HEED_MENU_ROOT="$HEED_CURRENT" HEED_RECORDINGS_DIR="$HEED_RECORDINGS" bash "$HEED_CURRENT/packages/desktop/install-menubar.sh" --prebuilt \
    || fail 'The menu app could not be installed.'
/usr/bin/python3 "$HEED_HELPER" migrate-native-hosts --new-root "$HEED_CURRENT" --old-root "$HEED_RUNTIME" \
    ${HEED_LEGACY_ROOT:+--old-root "$HEED_LEGACY_ROOT"} || fail 'The Meet browser bridge could not be updated.'

step 'Waiting for Heed services (models can take a few minutes to load)'
/usr/bin/python3 "$HEED_HELPER" wait-ready --root "$HEED_STAGE" --version "$HEED_VERSION" --commit "$HEED_COMMIT" --timeout "$HEED_READY_TIMEOUT" \
    || fail "Heed $HEED_VERSION did not become ready. Service logs are in ~/Library/Logs/Heed."
HEED_COMMITTED=1

# --- Record the installation ------------------------------------------------------------------
HEED_PREVIOUS_VERSION="$(state --get version)"
state --set "version=$HEED_VERSION" --set "path=$HEED_STAGE" --set "recordingsDir=$HEED_RECORDINGS" \
    --set "legacyRoot=$HEED_LEGACY_ROOT" --set "previousVersion=$HEED_PREVIOUS_VERSION" --set "previousPath=$HEED_PREVIOUS_DIR" \
    --set "installedAt=$(date -u +%Y-%m-%dT%H:%M:%SZ)" --set "repository=$HEED_REPOSITORY"
mkdir -p "$HEED_HOME/bin"
cp "$HEED_CURRENT/uninstall.sh" "$HEED_HOME/bin/uninstall.sh"
cp "$HEED_HELPER" "$HEED_HOME/bin/heed_release.py"
chmod 755 "$HEED_HOME/bin/uninstall.sh"
# Keep the new and the previous version for manual rollback; remove older ones.
for HEED_OLD in "$HEED_VERSIONS"/*; do
    [ -d "$HEED_OLD" ] || continue
    HEED_OLD_REAL="$(cd "$HEED_OLD" && pwd -P)"
    if [ "$HEED_OLD_REAL" != "$HEED_STAGE" ] && [ "$HEED_OLD_REAL" != "$HEED_PREVIOUS_DIR" ]; then rm -rf "$HEED_OLD"; fi
done

# --- Permissions ------------------------------------------------------------------------------
step 'Testing macOS permissions'
HEED_PERMISSION_ARGS=()
if [ "$HEED_PERMISSION_PROMPT" = 1 ]; then HEED_PERMISSION_ARGS+=(--request); fi
HEED_PERMISSION_STATUS=0
/usr/bin/python3 "$HEED_HELPER" permissions --root "$HEED_STAGE" ${HEED_PERMISSION_ARGS[@]+"${HEED_PERMISSION_ARGS[@]}"} || HEED_PERMISSION_STATUS=$?
if [ "$HEED_PERMISSION_STATUS" != 0 ]; then
    printf '\nHeed records only after Microphone and Screen & System Audio Recording are allowed for Heed in\n'
    printf 'System Settings > Privacy & Security. After allowing them, quit and reopen Heed from the menu bar.\n'
    printf 'Check again at any time with: Heed menu > Settings and permissions...\n'
    if [ "$HEED_REQUIRE_PERMISSIONS" = 1 ]; then
        printf 'Heed %s is installed, but required permissions are missing (--require-permissions).\n' "$HEED_VERSION" >&2
        exit 3
    fi
fi

printf '\nHeed %s is installed and running.\n' "$HEED_VERSION"
printf '  Interface:  http://localhost:%s\n' "$HEED_UI_PORT"
printf '  Menu app:   %s\n' "$HEED_APP"
printf '  Recordings: %s\n' "$HEED_RECORDINGS"
printf '  Uninstall:  bash "%s"\n' "$HEED_HOME/bin/uninstall.sh"
printf '  Log:        %s\n' "$HEED_LOG"
