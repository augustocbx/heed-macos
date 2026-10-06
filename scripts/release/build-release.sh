#!/bin/bash
# Build the versioned macOS release assets from one commit of this repository.
#
#   bash scripts/release/build-release.sh [--output DIR] [--from-worktree] [--allow-untagged]
#
# By default the payload comes from the committed files of HEAD, which must be tagged
# v<VERSION>. --from-worktree packages tracked and untracked (not ignored) working files
# instead; it is meant for local simulation and is labelled as such in release.json.
set -euo pipefail
HEED_REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HEED_REPOSITORY="${HEED_REPOSITORY:-augustocbx/heed-macos}"
HEED_OUTPUT="$HEED_REPO_ROOT/dist/release"
HEED_FROM_WORKTREE=0
HEED_ALLOW_UNTAGGED=0
while [ "$#" -gt 0 ]; do
    case "$1" in
        --output) HEED_OUTPUT="$2"; shift 2 ;;
        --from-worktree) HEED_FROM_WORKTREE=1; HEED_ALLOW_UNTAGGED=1; shift ;;
        --allow-untagged) HEED_ALLOW_UNTAGGED=1; shift ;;
        *) printf 'Unknown option: %s\n' "$1" >&2; exit 64 ;;
    esac
done
if [ "$(uname -s)" != Darwin ] || [ "$(uname -m)" != arm64 ]; then
    printf 'Release builds require macOS on Apple Silicon.\n' >&2; exit 1
fi
mkdir -p "$HEED_OUTPUT"
HEED_OUTPUT="$(cd "$HEED_OUTPUT" && pwd)"
cd "$HEED_REPO_ROOT"
HEED_VERSION="$(tr -d '[:space:]' < VERSION)"
if ! [[ "$HEED_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
    printf 'VERSION must contain a semantic version such as 1.2.3, found: %s\n' "$HEED_VERSION" >&2; exit 1
fi
HEED_TAG="v$HEED_VERSION"
HEED_COMMIT="$(git rev-parse HEAD)"
if [ "$HEED_ALLOW_UNTAGGED" != 1 ]; then
    if [ "$(git rev-parse -q --verify "refs/tags/$HEED_TAG^{commit}" || true)" != "$HEED_COMMIT" ]; then
        printf 'HEAD is not tagged %s. Tag the release commit or pass --allow-untagged for a test build.\n' "$HEED_TAG" >&2; exit 1
    fi
fi
HEED_NAME="heed-macos-$HEED_VERSION-arm64"
HEED_WORK="$(mktemp -d -t heed-release)"
trap 'rm -rf "$HEED_WORK"' EXIT
HEED_PAYLOAD="$HEED_WORK/$HEED_NAME"
mkdir -p "$HEED_PAYLOAD"

# Only repository files are packaged; recordings, settings, credentials and build caches are never tracked.
if [ "$HEED_FROM_WORKTREE" = 1 ]; then
    git ls-files -z --cached --others --exclude-standard | while IFS= read -r -d '' HEED_FILE; do
        if [ -f "$HEED_FILE" ]; then mkdir -p "$HEED_PAYLOAD/$(dirname "$HEED_FILE")"; cp -p "$HEED_FILE" "$HEED_PAYLOAD/$HEED_FILE"; fi
    done
else
    git archive --format=tar HEAD | tar -x -C "$HEED_PAYLOAD"
fi
cd "$HEED_PAYLOAD"
# Development material that the installed app never reads.
rm -rf .github docs eval_diar eval_echo KILLER_IDEAS.md REFACTOR.md REFACTOR_REPORT.md README-upstream.md \
    AGENTS.md CONTRIBUTING.md .dependency-cruiser.cjs recordings dist
# Generated transcript of the bundled public-domain benchmark clip; never read at runtime.
rm -f packages/transcription/assets/bench_sample.wav.srt
find scripts -mindepth 1 -maxdepth 1 ! -name init-managed-quota.ts ! -name release \
    ! -name service_config.py ! -name service_runtime.py ! -name service_diagnostics.py -exec rm -rf {} +
find scripts/release -name '*_test.py' -delete

printf '> Installing build dependencies\n'
bun install --frozen-lockfile
printf '> Building the interface\n'
bun run build
printf '> Building native executables\n'
swift build --package-path packages/transcription/native/heed-parakeet -c release --product heed-parakeet
swift build --package-path packages/transcription/native/heed-parakeet -c release --product heed-syscap
HEED_NATIVE_BUILD="packages/transcription/native/heed-parakeet/.build"
HEED_NATIVE_RELEASE="$(cd "$HEED_NATIVE_BUILD/release" && pwd -P)"
"$HEED_NATIVE_RELEASE/heed-syscap" --self-test
bash packages/desktop/native-keychain/build.sh
bash packages/desktop/icloud-folder/build.sh
"packages/desktop/icloud-folder/.build/heed-icloud" --self-test
mkdir -p packages/desktop/macos/.build
swiftc -O -target arm64-apple-macosx14.0 packages/desktop/macos/*.swift -o packages/desktop/macos/.build/Heed -framework AppKit
packages/desktop/macos/.build/Heed --self-test

# Keep only the executables at the paths the services already use.
mkdir -p "$HEED_WORK/native"
cp "$HEED_NATIVE_RELEASE/heed-parakeet" "$HEED_NATIVE_RELEASE/heed-syscap" "$HEED_WORK/native/"
rm -rf "$HEED_NATIVE_BUILD" packages/transcription/native/heed-parakeet/.swiftpm
mkdir -p "$HEED_NATIVE_BUILD/release"
mv "$HEED_WORK/native/heed-parakeet" "$HEED_WORK/native/heed-syscap" "$HEED_NATIVE_BUILD/release/"
rm -rf node_modules packages/*/node_modules packages/client/tsconfig.tsbuildinfo
find . -name __pycache__ -type d -prune -exec rm -rf {} +
find . \( -name '.DS_Store' -o -name '*.tsbuildinfo' \) -delete
for HEED_BINARY in packages/transcription/native/heed-parakeet/.build/release/heed-parakeet \
    packages/transcription/native/heed-parakeet/.build/release/heed-syscap \
    packages/desktop/native-keychain/.build/heed-keychain packages/desktop/icloud-folder/.build/heed-icloud \
    packages/desktop/macos/.build/Heed; do
    codesign --force --sign - "$HEED_BINARY"
done

HEED_BUILT_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
HEED_CHANNEL=release
if [ "$HEED_FROM_WORKTREE" = 1 ]; then HEED_CHANNEL=local-test; fi
/usr/bin/python3 - "$HEED_VERSION" "$HEED_TAG" "$HEED_COMMIT" "$HEED_BUILT_AT" "$HEED_CHANNEL" "$HEED_REPOSITORY" <<'PY'
import json, sys
version, tag, commit, built, channel, repository = sys.argv[1:]
with open("release.json", "w") as f:
    json.dump({"app": "heed", "version": version, "tag": tag, "commit": commit, "builtAt": built, "channel": channel,
               "repository": repository, "architectures": ["arm64"], "minimumMacOS": "14.0"}, f, indent=2)
    f.write("\n")
PY
for HEED_SCRIPT in install uninstall; do
    sed "s/^HEED_RELEASE_VERSION=.*/HEED_RELEASE_VERSION=\"$HEED_VERSION\"/" "scripts/release/$HEED_SCRIPT.sh" > "$HEED_SCRIPT.sh"
    chmod 755 "$HEED_SCRIPT.sh"
done

# Fail closed if anything personal or generated slipped into the payload.
HEED_UNEXPECTED="$(find . \( -name '*.wav' ! -path ./packages/transcription/_warmup_voice.wav ! -path ./packages/transcription/assets/bench_sample.wav \) \
    -o -name '*.wav.json' -o -name '*.srt' -o -name '.env*' -o -name '*.pem' -o -name '*.p12' -o -name '.git' -o -name '.venv' \
    -o -name node_modules -o -path './recordings' -o -name 'session-*.json' -o -size +60M | head -20)"
if [ -n "$HEED_UNEXPECTED" ]; then
    printf 'Refusing to package unexpected files:\n%s\n' "$HEED_UNEXPECTED" >&2; exit 1
fi

HEED_TARBALL="$HEED_NAME.tar.gz"
cd "$HEED_WORK"
COPYFILE_DISABLE=1 tar --no-xattrs --uid 0 --gid 0 --uname root --gname wheel -czf "$HEED_OUTPUT/$HEED_TARBALL" "$HEED_NAME"
cp "$HEED_PAYLOAD/install.sh" "$HEED_OUTPUT/install.sh"
cp "$HEED_PAYLOAD/uninstall.sh" "$HEED_OUTPUT/uninstall.sh"
cd "$HEED_OUTPUT"
/usr/bin/python3 - "$HEED_VERSION" "$HEED_TAG" "$HEED_COMMIT" "$HEED_BUILT_AT" "$HEED_REPOSITORY" "$HEED_TARBALL" <<'PY'
import hashlib, json, os, sys
version, tag, commit, built, repository, tarball = sys.argv[1:]
def asset(name):
    digest = hashlib.sha256(open(name, "rb").read()).hexdigest()
    return {"name": name, "size": os.path.getsize(name), "sha256": digest,
            "url": "https://github.com/%s/releases/download/%s/%s" % (repository, tag, name)}
# Consumed by update detection: one stable document per release, also reachable via /releases/latest/download/.
manifest = {"schema": 1, "app": "heed", "version": version, "tag": tag, "commit": commit, "builtAt": built,
            "repository": repository, "minimumMacOS": "14.0", "architectures": ["arm64"],
            "assets": {"payload": asset(tarball), "installer": asset("install.sh"), "uninstaller": asset("uninstall.sh")}}
with open("release-manifest.json", "w") as f:
    json.dump(manifest, f, indent=2)
    f.write("\n")
PY
shasum -a 256 "$HEED_TARBALL" install.sh uninstall.sh release-manifest.json > SHA256SUMS
printf 'Built Heed %s release assets in %s:\n' "$HEED_VERSION" "$HEED_OUTPUT"
cat SHA256SUMS
