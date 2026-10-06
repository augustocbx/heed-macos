#!/bin/bash
# End-to-end simulation of the release installer and uninstaller.
#
#   bash scripts/release/simulate.sh [--artifacts DIR] [--keep]
#
# Builds release archives from this working tree (or uses --artifacts), then installs, upgrades,
# breaks and removes Heed inside a sandboxed HOME. The packaged services really run, on alternate
# ports, so a Heed installation already running on this Mac is never touched. System-wide effects
# (launchd, Keychain, privacy database, preferences, Homebrew installs and GitHub downloads) go
# through recording shims. Granting real macOS permissions needs a person at the Mac; the
# simulation feeds the permission test with menu-app reports instead.
set -euo pipefail
HEED_REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SIM_ARTIFACTS=""
SIM_KEEP=0
while [ "$#" -gt 0 ]; do
    case "$1" in
        --artifacts) SIM_ARTIFACTS="$(cd "$2" && pwd)"; shift 2 ;;
        --keep) SIM_KEEP=1; shift ;;
        *) printf 'Unknown option: %s\n' "$1" >&2; exit 64 ;;
    esac
done
REAL_HOME="$HOME"
REAL_BUN="$(command -v bun)"
SIM="$(mktemp -d -t heed-sim)"
SIM="$(cd "$SIM" && pwd -P)"
SIM_HOME="$SIM/home"
SIM_SHIMS="$SIM/shims"
SIM_RELEASES="$SIM/releases"
SIM_REPOSITORY="example/heed-macos"
mkdir -p "$SIM_HOME" "$SIM_SHIMS" "$SIM_RELEASES"
PASS=0
step() { printf '\n\033[1m### %s\033[0m\n' "$*"; }
ok() { PASS=$((PASS + 1)); printf '  PASS %s\n' "$*"; }
die() { printf '  FAIL %s\n' "$*" >&2; printf 'Simulation folder kept: %s\n' "$SIM" >&2; SIM_KEEP=1; exit 1; }
check() { local message="$1"; shift; if "$@"; then ok "$message"; else die "$message"; fi; }

free_port() { ! /usr/sbin/lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }
for SIM_BASE in 48900 48910 48920 48930; do
    if free_port "$SIM_BASE" && free_port $((SIM_BASE + 1)) && free_port $((SIM_BASE + 2)); then break; fi
done
export HEED_API_PORT="$SIM_BASE" PORT="$SIM_BASE" HEED_UI_PORT=$((SIM_BASE + 1)) HEED_TRANSCRIPTION_PORT=$((SIM_BASE + 2))
# A caller's private paths/client overrides must never escape this disposable HOME.
export HEED_APP_DIR="$SIM_HOME/.heed-app" HEED_HOME="$SIM_HOME/.heed"
unset HEED_SERVICE_CONFIG_ROOT HEED_TRANSCRIPTION_URL HEED_RECORDINGS_DIR VITE_API_BASE HEED_LIFECYCLE_GUARD_HELD HEED_LIFECYCLE_GUARD_TOKEN

cleanup() {
    "$SIM_SHIMS/launchctl" bootout "gui/$(id -u)/local.heed.menubar" >/dev/null 2>&1 || true
    if [ -f "$SIM/services.pid" ]; then while read -r SIM_PID; do kill -TERM -- "-$SIM_PID" 2>/dev/null || true; done < "$SIM/services.pid"; fi
    pkill -f "$SIM_HOME/" 2>/dev/null || true
    [ -f "$SIM/foreign.pid" ] && kill "$(cat "$SIM/foreign.pid")" 2>/dev/null || true
    if [ "$SIM_KEEP" = 1 ]; then printf 'Simulation folder: %s\n' "$SIM"; else rm -rf "$SIM"; fi
}
trap cleanup EXIT

# --- Shims ------------------------------------------------------------------------------------
cat > "$SIM_SHIMS/launchctl" <<'SHIM'
#!/bin/bash
# Records launchd calls; "bootstrap" starts the installed services the way the menu app would.
printf 'launchctl %s\n' "$*" >> "$SIM/calls.log"
case "$1" in
    bootstrap)
        "$SIM_SHIMS/launchctl" bootout x >/dev/null 2>&1 || true
        RES="$HOME/Applications/Heed.app/Contents/Resources"
        IFS= read -r ROOT < "$RES/heed-root.txt"
        RECORDINGS=""; [ -f "$RES/heed-recordings-dir.txt" ] && IFS= read -r RECORDINGS < "$RES/heed-recordings-dir.txt"
        mkdir -p "$HOME/Library/Logs/Heed"
        # exec keeps one PID from this subshell to bun, which leads its own process group after setsid.
        (cd "$ROOT" && exec env PORT="$HEED_API_PORT" HEED_TRANSCRIPTION_URL="http://127.0.0.1:$HEED_TRANSCRIPTION_PORT" \
            VITE_API_BASE="http://localhost:$HEED_API_PORT" HEED_RECORDINGS_DIR="$RECORDINGS" \
            /usr/bin/python3 -c 'import os,sys; os.setsid(); os.execvp(sys.argv[1], sys.argv[1:])' bun run dev \
            >> "$HOME/Library/Logs/Heed/services.log" 2>&1 < /dev/null) &
        echo $! >> "$SIM/services.pid"; touch "$SIM/loaded"
        # Stand-in for the menu app's periodic permission report.
        (while true; do
            /usr/bin/curl -s -m 2 -X POST -H 'Content-Type: application/json' --data @"$SIM/permissions.json" \
                "http://127.0.0.1:$HEED_API_PORT/api/desktop/permissions/report" >/dev/null 2>&1 || true
            sleep 2
        done) >/dev/null 2>&1 < /dev/null & echo $! > "$SIM/reporter.pid"
        ;;
    bootout)
        # Like unloading the menu app: the services it started are left for the installer to stop.
        [ -f "$SIM/reporter.pid" ] && kill "$(cat "$SIM/reporter.pid")" 2>/dev/null; rm -f "$SIM/reporter.pid"
        [ -f "$SIM/loaded" ] || exit 3
        rm -f "$SIM/loaded" ;;
    print) [ -f "$SIM/loaded" ] ;;
esac
SHIM
cat > "$SIM_SHIMS/brew" <<'SHIM'
#!/bin/bash
printf 'brew %s\n' "$*" >> "$SIM/calls.log"
if [ "${1:-}" = install ]; then printf 'simulation: refusing to install %s\n' "$*" >&2; exit 1; fi
exec /opt/homebrew/bin/brew "$@"
SHIM
cat > "$SIM_SHIMS/curl" <<'SHIM'
#!/bin/bash
# Serves GitHub release downloads from the simulation's local release folders.
URL=""; OUT=""; ARGS=("$@")
while [ "$#" -gt 0 ]; do case "$1" in -o) OUT="$2"; shift 2 ;; http*) URL="$1"; shift ;; *) shift ;; esac; done
PREFIX="https://github.com/$SIM_REPOSITORY/releases/download/"
case "$URL" in
    "$PREFIX"*)
        printf 'curl %s\n' "$URL" >> "$SIM/calls.log"
        FILE="$SIM_RELEASES/${URL#$PREFIX}"
        [ -f "$FILE" ] || { printf 'curl: (22) 404 %s\n' "$URL" >&2; exit 22; }
        if [ -n "$OUT" ]; then cp "$FILE" "$OUT"; else cat "$FILE"; fi ;;
    https://*) printf 'simulation: no network access to %s\n' "$URL" >&2; exit 7 ;;
    *) exec /usr/bin/curl "${ARGS[@]}" ;;
esac
SHIM
for SIM_TOOL in security tccutil defaults; do
    cat > "$SIM_SHIMS/$SIM_TOOL" <<SHIM
#!/bin/bash
printf '$SIM_TOOL %s\n' "\$*" >> "\$SIM/calls.log"
# Keychain lookups find nothing; deletions report "not found" once the items are gone.
[ "$SIM_TOOL" = security ] && exit 44
exit 0
SHIM
done
chmod 755 "$SIM_SHIMS"/*
export SIM SIM_SHIMS SIM_RELEASES SIM_REPOSITORY
export HOME="$SIM_HOME" HEED_REPOSITORY="$SIM_REPOSITORY" HEED_READY_TIMEOUT=420
export PATH="$SIM_SHIMS:$(dirname "$REAL_BUN"):/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
# Reuse download caches so the simulation does not fetch packages and models again.
export PIP_CACHE_DIR="$REAL_HOME/Library/Caches/pip" BUN_INSTALL_CACHE_DIR="$REAL_HOME/.bun/install/cache" HF_HOME="$REAL_HOME/.cache/huggingface"
permissions() { printf '{"permissions":{"microphone":"%s","screenCapture":%s,"slackLogs":null,"slackAutoRecord":false}}\n' "$1" "$2" > "$SIM/permissions.json"; }
permissions authorized true

# --- Release archives -------------------------------------------------------------------------
step "Release archives"
if [ -z "$SIM_ARTIFACTS" ]; then
    (export HOME="$REAL_HOME"; bash "$HEED_REPO_ROOT/scripts/release/build-release.sh" --from-worktree --output "$SIM/build") > "$SIM/build.log" 2>&1 \
        || { tail -40 "$SIM/build.log"; die "build the release archive"; }
    SIM_ARTIFACTS="$SIM/build"
fi
V1="$(/usr/bin/python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$SIM_ARTIFACTS/release-manifest.json")"
mkdir -p "$SIM_RELEASES/v$V1"
cp "$SIM_ARTIFACTS"/* "$SIM_RELEASES/v$V1/"
derive() { # new version, optional breakage
    local version="$1" work="$SIM/derive-$1"
    mkdir -p "$work" "$SIM_RELEASES/v$version"
    tar -xzf "$SIM_RELEASES/v$V1/heed-macos-$V1-arm64.tar.gz" -C "$work"
    mv "$work/heed-macos-$V1-arm64" "$work/heed-macos-$version-arm64"
    local payload="$work/heed-macos-$version-arm64"
    /usr/bin/python3 - "$payload/release.json" "$version" <<'PY'
import json, sys
data = json.load(open(sys.argv[1])); data["version"] = sys.argv[2]; data["tag"] = "v" + sys.argv[2]
json.dump(data, open(sys.argv[1], "w"), indent=2)
PY
    printf '%s\n' "$version" > "$payload/VERSION"
    for script in install uninstall; do
        sed -i '' "s/^HEED_RELEASE_VERSION=.*/HEED_RELEASE_VERSION=\"$version\"/" "$payload/$script.sh"
        cp "$payload/$script.sh" "$SIM_RELEASES/v$version/$script.sh"
    done
    if [ "${2:-}" = broken-dependencies ]; then printf 'heed-package-that-does-not-exist==0.0.0\n' >> "$payload/packages/transcription/requirements-core.txt"; fi
    if [ "${2:-}" = broken-smb-wheel ]; then printf 'tampered' >> "$payload/packages/server/native/smb-direct/wheels/smbprotocol-1.17.0-py3-none-any.whl"; fi
    (cd "$work" && COPYFILE_DISABLE=1 tar --no-xattrs -czf "$SIM_RELEASES/v$version/heed-macos-$version-arm64.tar.gz" "heed-macos-$version-arm64")
    (cd "$SIM_RELEASES/v$version" && shasum -a 256 "heed-macos-$version-arm64.tar.gz" install.sh uninstall.sh > SHA256SUMS)
}
V1_CORE="${V1%%-*}"
V2="${V1_CORE%.*}.$(( ${V1_CORE##*.} + 1 ))"
V3="${V1_CORE%.*}.$(( ${V1_CORE##*.} + 2 ))"
derive "$V2"
derive "$V3" broken-dependencies
V4="${V1_CORE%.*}.$(( ${V1_CORE##*.} + 3 ))"
derive "$V4" broken-smb-wheel
check "release $V1 archive matches SHA256SUMS" bash -c "cd '$SIM_RELEASES/v$V1' && shasum -a 256 -c SHA256SUMS >/dev/null"
check "release payload excludes personal and development files" bash -c \
    "! tar -tzf '$SIM_RELEASES/v$V1/heed-macos-$V1-arm64.tar.gz' | grep -E '(^|/)(recordings/|\\.git/|\\.venv/|node_modules/|eval_diar/|\\.env)'"
check "release payload carries the prebuilt binaries" bash -c \
    "tar -tzf '$SIM_RELEASES/v$V1/heed-macos-$V1-arm64.tar.gz' | grep -q 'heed-parakeet/.build/release/heed-syscap\$'"

# Check missing-field initialization separately from the existing custom-quota installation.
step "Default quota initialization in an isolated configuration"
SIM_DEFAULT_APP="$SIM/default-quota"
mkdir -p "$SIM_DEFAULT_APP"
printf '{"ui_locale":"pt-BR"}\n' > "$SIM_DEFAULT_APP/config.json"
check "missing quota field initializes to decimal 2 GB" env HEED_APP_DIR="$SIM_DEFAULT_APP" \
    "$REAL_BUN" "$HEED_REPO_ROOT/scripts/init-managed-quota.ts"
check "initialized default is persisted" /usr/bin/python3 "$HEED_REPO_ROOT/scripts/release/verify_quota.py" \
    --config "$SIM_DEFAULT_APP/config.json" --expected-bytes 2000000000

# --- Existing checkout installation with user data ------------------------------------------
step "Existing checkout installation with recordings, transcripts, speaker names and settings"
LEGACY="$SIM_HOME/heed-checkout"
mkdir -p "$LEGACY/recordings" "$SIM_HOME/.heed-app/sessions" "$SIM_HOME/Applications/Heed.app/Contents/Resources"
printf '{"name":"heed","private":true}\n' > "$LEGACY/package.json"
head -c 48000 /dev/urandom > "$LEGACY/recordings/dual-capture-1.wav"
printf '{"id":"session-1","title":"Planning","transcript":"Hello","speakers":["Ana"],"files":{"wav":"%s"}}\n' "$LEGACY/recordings/dual-capture-1.wav" \
    > "$SIM_HOME/.heed-app/sessions/session-1.json"
printf '{"Ana":[0.1,0.2]}\n' > "$SIM_HOME/.heed-app/voices.json"
printf '{"ui_locale":"pt-BR","storage_limit_bytes":3000000000}\n' > "$SIM_HOME/.heed-app/config.json"
printf '%s\n' "$LEGACY" > "$SIM_HOME/Applications/Heed.app/Contents/Resources/heed-root.txt"
SIM_HOST="$SIM_HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/local.heed.meet.json"
mkdir -p "$(dirname "$SIM_HOST")"
printf '{"name":"local.heed.meet","path":"%s/packages/desktop/browser-meet/native-host.py"}\n' "$LEGACY" > "$SIM_HOST"
data_digest() { (cd "$SIM_HOME" && find .heed-app/sessions .heed-app/voices.json "${LEGACY#$SIM_HOME/}/recordings" -type f -exec shasum {} + | sort); }
DATA_BEFORE="$(data_digest)"
running_version() { /usr/bin/curl -s -m 3 "http://127.0.0.1:$HEED_API_PORT/api/version" | /usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin)["version"])' 2>/dev/null || true; }
current_version() { /usr/bin/python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$SIM_HOME/.heed/runtime/current/release.json" 2>/dev/null || true; }
verify_custom_quota() {
    /usr/bin/python3 "$HEED_REPO_ROOT/scripts/release/verify_quota.py" \
        --config "$SIM_HOME/.heed-app/config.json" --expected-bytes 3000000000 \
        --api-base "http://127.0.0.1:$HEED_API_PORT"
}

step "Refusal: checkout predates safe service configuration"
legacy_digest() {
    (cd "$SIM_HOME" && find .heed-app Applications/Heed.app "${LEGACY#$SIM_HOME/}" \
        "${SIM_HOST#$SIM_HOME/}" -type f -exec shasum {} + | sort)
}
LEGACY_BEFORE="$(legacy_digest)"
touch "$SIM/calls.log"
cp "$SIM/calls.log" "$SIM/calls-before-legacy-refusal.log"
if (cd "$SIM_RELEASES/v$V1" && bash install.sh --payload "heed-macos-$V1-arm64.tar.gz" \
    --skip-model-warmup --no-permission-prompt) > "$SIM/install-legacy-refusal.log" 2>&1; then
    die "unsupported legacy checkout was replaced"
fi
check "unsupported checkout has an actionable migration error" grep -q \
    'The previous checkout predates safe service-port configuration' "$SIM/install-legacy-refusal.log"
check "refusal preserves checkout, app, browser bridge, settings and meeting data" test "$(legacy_digest)" = "$LEGACY_BEFORE"
check "refusal creates no installed release or installation receipt" bash -c \
    "test ! -e '$SIM_HOME/.heed/runtime/current' && test ! -e '$SIM_HOME/.heed/install.json'"
check "refusal performs no launchd, credential or permission operations" cmp -s \
    "$SIM/calls-before-legacy-refusal.log" "$SIM/calls.log"

# The supported migration fixture has the real configuration and lifecycle helpers.
# Keep the incompatible checkout control above rather than bypassing the installer gate.
mkdir -p "$LEGACY/scripts" "$LEGACY/config" "$LEGACY/packages/desktop"
cp "$HEED_REPO_ROOT/scripts/service_config.py" "$HEED_REPO_ROOT/scripts/service_runtime.py" "$HEED_REPO_ROOT/scripts/lifecycle_metadata.py" "$LEGACY/scripts/"
cp "$HEED_REPO_ROOT/config/service-ports.json" "$LEGACY/config/"
cp "$HEED_REPO_ROOT/packages/desktop/guard-lifecycle.py" "$LEGACY/packages/desktop/"
# This disposable device already uses the simulator's ports. Persist them so
# migration never inspects another installation's production-default listeners.
/usr/bin/python3 "$LEGACY/scripts/service_config.py" api --save >/dev/null

step "Fresh release installation $V1 from a downloaded archive (replacing the checkout installation)"
permissions authorized false
SIM_STATUS=0
(cd "$SIM_RELEASES/v$V1" && bash install.sh --payload "heed-macos-$V1-arm64.tar.gz" --skip-model-warmup --no-permission-prompt --require-permissions) \
    > "$SIM/install-1.log" 2>&1 || SIM_STATUS=$?
[ "$SIM_STATUS" = 3 ] || { tail -60 "$SIM/install-1.log"; die "install $V1 (exit $SIM_STATUS)"; }
ok "install reports missing Screen & System Audio Recording and exits 3 with --require-permissions"
check "permission test lists microphone as allowed" grep -q '\[OK\] Microphone: allowed' "$SIM/install-1.log"
check "permission test flags screen recording" grep -q '\[!!\] Screen & System Audio Recording' "$SIM/install-1.log"
check "real services answer as Heed $V1" test "$(running_version)" = "$V1"
check "interface port proxies the Heed API" bash -c "/usr/bin/curl -s 'http://localhost:$HEED_UI_PORT/api/version' | grep -q '\"app\":\"heed\"'"
check "transcription port is the Heed transcription service" bash -c "/usr/bin/curl -s 'http://127.0.0.1:$HEED_TRANSCRIPTION_PORT/health' | grep -q '\"service\": \"heed-transcription\"'"
check "menu app embeds version $V1" test "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$SIM_HOME/Applications/Heed.app/Contents/Info.plist")" = "$V1"
check "menu app starts services from the stable current link" grep -qx "$SIM_HOME/.heed/runtime/current" "$SIM_HOME/Applications/Heed.app/Contents/Resources/heed-root.txt"
check "existing recordings folder stays in place" grep -qx "$LEGACY/recordings" "$SIM_HOME/Applications/Heed.app/Contents/Resources/heed-recordings-dir.txt"
check "Meet browser bridge now points to the release" grep -q "$SIM_HOME/.heed/runtime/current/packages/desktop/browser-meet/native-host.py" "$SIM_HOST"
check "recordings, transcripts and speaker names are unchanged" test "$(data_digest)" = "$DATA_BEFORE"
check "the checkout itself was not modified" test -f "$LEGACY/package.json"
check "API lists the existing meeting" bash -c "/usr/bin/curl -s 'http://127.0.0.1:$HEED_API_PORT/api/sessions' | grep -q session-1"
check "installation preserves custom quota in config, Storage API and desktop status" verify_custom_quota

step "Upgrade $V1 -> $V2 with the standalone install.sh (download + checksum)"
permissions authorized true
bash "$SIM_RELEASES/v$V2/install.sh" --skip-model-warmup --no-permission-prompt --require-permissions > "$SIM/install-2.log" 2>&1 \
    || { tail -60 "$SIM/install-2.log"; die "upgrade to $V2"; }
check "downloaded archive checksum verified" grep -q "Checksum verified: heed-macos-$V2-arm64.tar.gz" "$SIM/install-2.log"
check "permission test passes when everything is allowed" grep -q '\[OK\] Screen & System Audio Recording: allowed' "$SIM/install-2.log"
check "Heed $V2 is running" test "$(running_version)" = "$V2"
check "current link points to $V2" test "$(current_version)" = "$V2"
check "previous version is kept for rollback" bash -c "ls '$SIM_HOME/.heed/runtime/versions' | grep -q '^$V1-'"
check "data preserved across the upgrade" test "$(data_digest)" = "$DATA_BEFORE"
check "settings preserved across the upgrade" grep -q '"ui_locale":"pt-BR"' "$SIM_HOME/.heed-app/config.json"
check "upgrade preserves custom quota in config, Storage API and desktop status" verify_custom_quota

step "Direct SMB offline runtime and upgrade preservation"
SIM_ACTIVE_ROOT="$(cd "$SIM_HOME/.heed/runtime/current" && pwd -P)"
check "installed direct SMB runtime passes detached pinned-SDK self-test" \
    "$SIM_ACTIVE_ROOT/runtime/smb/bin/python" -I -S -B "$SIM_ACTIVE_ROOT/packages/server/native/smb-direct/runtime.py" self-test "$SIM_ACTIVE_ROOT"
if HEED_SMB_PYTHON="$SIM/missing-python3.12" bash "$SIM_RELEASES/v$V2/install.sh" --skip-model-warmup --no-permission-prompt > "$SIM/missing-smb-python.log" 2>&1; then die "missing SMB prerequisite installed"; fi
check "missing Python 3.12 gives an explicit prerequisite refusal" grep -q "Direct SMB requires Python 3.12" "$SIM/missing-smb-python.log"
check "missing SMB prerequisite does not stop active services" test "$(running_version)" = "$V2"
check "missing SMB prerequisite preserves active release" test "$(cd "$SIM_HOME/.heed/runtime/current" && pwd -P)" = "$SIM_ACTIVE_ROOT"
check "missing SMB prerequisite preserves private data" test "$(data_digest)" = "$DATA_BEFORE"
if bash "$SIM_RELEASES/v$V4/install.sh" --skip-model-warmup --no-permission-prompt > "$SIM/corrupt-smb-wheel.log" 2>&1; then die "altered locked wheel installed"; fi
check "altered SMB wheel is rejected despite a matching archive checksum" grep -q "locked direct SMB dependency payload is incomplete or corrupt" "$SIM/corrupt-smb-wheel.log"
check "altered SMB wheel preserves active release" test "$(current_version)" = "$V2"
check "altered SMB wheel preserves running services and private data" test "$(running_version)" = "$V2"
check "altered SMB wheel preserves private data" test "$(data_digest)" = "$DATA_BEFORE"
check "altered SMB wheel leaves no partial version" bash -c "! ls '$SIM_HOME/.heed/runtime/versions' | grep -q '^$V4-'"

step "Failure: corrupted download"
cp -R "$SIM_RELEASES/v$V3" "$SIM/v$V3-good"
printf 'tampered' >> "$SIM_RELEASES/v$V3/heed-macos-$V3-arm64.tar.gz"
if bash "$SIM_RELEASES/v$V3/install.sh" --skip-model-warmup --no-permission-prompt > "$SIM/install-3.log" 2>&1; then die "corrupted archive was accepted"; fi
rm -rf "$SIM_RELEASES/v$V3"; mv "$SIM/v$V3-good" "$SIM_RELEASES/v$V3"
check "installer reports the checksum mismatch" grep -q "Checksum mismatch" "$SIM/install-3.log"
check "Heed $V2 keeps running" test "$(running_version)" = "$V2"

step "Failure: dependencies cannot be installed"
if bash "$SIM_RELEASES/v$V3/install.sh" --skip-model-warmup --no-permission-prompt > "$SIM/install-4.log" 2>&1; then die "broken release installed"; fi
check "installer gives an actionable error" grep -q "Python dependencies could not be installed" "$SIM/install-4.log"
check "installer states that the existing installation was kept" grep -q "existing Heed installation and its data were left in place" "$SIM/install-4.log"
check "Heed $V2 keeps running" test "$(running_version)" = "$V2"
check "current link still points to $V2" test "$(current_version)" = "$V2"
check "no partial version folder remains" bash -c "! ls '$SIM_HOME/.heed/runtime/versions' | grep -q '^$V3-'"

step "Refusal: Heed is busy"
/usr/bin/curl -s -X POST -H 'Content-Type: application/json' -d '{"acquire":true,"owner":"simulated-meeting"}' \
    "http://127.0.0.1:$HEED_API_PORT/api/recording/maintenance" >/dev/null
if bash "$SIM_RELEASES/v$V2/install.sh" --skip-model-warmup --no-permission-prompt > "$SIM/install-5.log" 2>&1; then die "installed while busy"; fi
check "installer refuses while Heed is busy" grep -q "Wait until it finishes" "$SIM/install-5.log"
check "Heed $V2 was not restarted" test "$(running_version)" = "$V2"
/usr/bin/curl -s -X POST -H 'Content-Type: application/json' -d '{"acquire":false,"owner":"simulated-meeting"}' \
    "http://127.0.0.1:$HEED_API_PORT/api/recording/maintenance" >/dev/null

step "Refusal: another application owns a Heed port"
SIM_STOP_ROOT="$(cd "$SIM_HOME/.heed/runtime/current" && pwd -P)" || die "resolve the current service root before the port conflict"
"$SIM_SHIMS/launchctl" bootout "gui/$(id -u)/local.heed.menubar"
/usr/bin/python3 "$HEED_REPO_ROOT/scripts/release/heed_release.py" stop-services --root "$SIM_STOP_ROOT" \
    --ports "$HEED_API_PORT" "$HEED_UI_PORT" "$HEED_TRANSCRIPTION_PORT" || die "stop services before the port conflict"
(cd "$SIM" && exec /usr/bin/python3 -m http.server "$HEED_API_PORT" --bind 127.0.0.1 >/dev/null 2>&1) & echo $! > "$SIM/foreign.pid"
sleep 1
if bash "$SIM_RELEASES/v$V2/install.sh" --skip-model-warmup --no-permission-prompt > "$SIM/install-6.log" 2>&1; then die "installed over another application"; fi
check "installer does not stop the other application" kill -0 "$(cat "$SIM/foreign.pid")"
check "installer explains the unverified listener identity" grep -Fq "Heed returned incomplete or unsupported recording status or listener identity" "$SIM/install-6.log"
check "installer does not claim a meeting is active" bash -c "! grep -q 'Heed is recording' '$SIM/install-6.log'"
kill "$(cat "$SIM/foreign.pid")"; rm -f "$SIM/foreign.pid"; sleep 1
"$SIM_SHIMS/launchctl" bootstrap "gui/$(id -u)" "$SIM_HOME/Library/LaunchAgents/local.heed.menubar.plist"
/usr/bin/python3 "$HEED_REPO_ROOT/scripts/release/heed_release.py" wait-ready --root "$(cd "$SIM_HOME/.heed/runtime/current" && pwd -P)" --version "$V2" --timeout 300 >/dev/null || die "restart $V2"
ok "Heed $V2 restarts after the conflict"

step "Uninstall --keep-data"
bash "$SIM_HOME/.heed/bin/uninstall.sh" --keep-data --yes > "$SIM/uninstall-1.log" 2>&1 || { cat "$SIM/uninstall-1.log"; die "uninstall --keep-data"; }
check "menu app removed" test ! -e "$SIM_HOME/Applications/Heed.app"
check "runtime removed" test ! -e "$SIM_HOME/.heed/runtime"
check "services stopped" bash -c "! /usr/sbin/lsof -nP -iTCP:$HEED_API_PORT -sTCP:LISTEN >/dev/null 2>&1"
sleep 2
check "no process from the removed runtime remains" bash -c "! pgrep -f '$SIM_HOME/.heed/runtime' >/dev/null"
check "recordings, transcripts and speaker names kept" test "$(data_digest)" = "$DATA_BEFORE"
check "the kept data location is remembered" grep -q "$LEGACY/recordings" "$SIM_HOME/.heed/install.json"
check "Keychain items kept with --keep-data" bash -c "! grep -q 'security delete-generic-password' '$SIM/calls.log'"

step "Reinstall $V2 over the kept data, then uninstall completely"
bash "$SIM_RELEASES/v$V2/install.sh" --skip-model-warmup --no-permission-prompt > "$SIM/install-7.log" 2>&1 || { tail -40 "$SIM/install-7.log"; die "reinstall"; }
check "reinstalled Heed $V2 is running" test "$(running_version)" = "$V2"
check "reinstall keeps using the recordings folder" grep -qx "$LEGACY/recordings" "$SIM_HOME/Applications/Heed.app/Contents/Resources/heed-recordings-dir.txt"
check "data preserved across reinstall" test "$(data_digest)" = "$DATA_BEFORE"
check "reinstall preserves custom quota in config, Storage API and desktop status" verify_custom_quota
mkdir -p "$SIM_HOME/Library/Application Support/Heed/backups" "$SIM_HOME/Library/Caches/local.heed.menubar"
touch "$SIM_HOME/Library/Preferences/local.heed.menubar.plist" 2>/dev/null || { mkdir -p "$SIM_HOME/Library/Preferences"; touch "$SIM_HOME/Library/Preferences/local.heed.menubar.plist"; }
if bash "$SIM_HOME/.heed/bin/uninstall.sh" < /dev/null > "$SIM/uninstall-2.log" 2>&1; then die "uninstall ran without confirmation"; fi
check "uninstall asks for confirmation" test -d "$SIM_HOME/.heed/runtime"
bash "$SIM_HOME/.heed/bin/uninstall.sh" --yes > "$SIM/uninstall-3.log" 2>&1 || { cat "$SIM/uninstall-3.log"; die "uninstall"; }
for SIM_PATH in "$SIM_HOME/.heed" "$SIM_HOME/.heed-app" "$SIM_HOME/Applications/Heed.app" "$SIM_HOME/Library/LaunchAgents/local.heed.menubar.plist" \
    "$SIM_HOME/Library/Logs/Heed" "$SIM_HOME/Library/Application Support/Heed" "$SIM_HOME/Library/Preferences/local.heed.menubar.plist" \
    "$SIM_HOME/Library/Caches/local.heed.menubar" "$SIM_HOST" "$LEGACY/recordings"; do
    check "removed ${SIM_PATH#$SIM_HOME/}" test ! -e "$SIM_PATH"
done
check "the user's checkout is kept" test -f "$LEGACY/package.json"
sleep 2
check "no process from the installation remains" bash -c "! pgrep -f '$SIM_HOME/.heed' >/dev/null"
check "no Heed service is listening" bash -c "! /usr/sbin/lsof -nP -iTCP:$HEED_API_PORT -iTCP:$HEED_UI_PORT -iTCP:$HEED_TRANSCRIPTION_PORT -sTCP:LISTEN >/dev/null 2>&1"
check "Keychain items removed" grep -q 'security delete-generic-password -s local.heed.connectors.v1' "$SIM/calls.log"
check "privacy permissions reset" grep -q 'tccutil reset All local.heed.menubar' "$SIM/calls.log"
check "uninstall reports success" grep -q "Heed was removed from this Mac" "$SIM/uninstall-3.log"
check "no Homebrew package was installed by the simulation" bash -c "! grep -q '^brew install' '$SIM/calls.log'"

printf '\nSimulation passed: %d checks.\n' "$PASS"
