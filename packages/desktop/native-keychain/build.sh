#!/bin/bash
set -euo pipefail
HEED_KEYCHAIN_ROOT="$(cd "$(dirname "$0")" && pwd)"
HEED_KEYCHAIN_OUTPUT="${HEED_KEYCHAIN_BUILD_DIR:-$HEED_KEYCHAIN_ROOT/.build}"
mkdir -p "$HEED_KEYCHAIN_OUTPUT"
swiftc -O -target "$(uname -m)-apple-macos14.0" "$HEED_KEYCHAIN_ROOT/Sources/main.swift" -framework Security -framework LocalAuthentication -o "$HEED_KEYCHAIN_OUTPUT/heed-keychain.new"
"$HEED_KEYCHAIN_OUTPUT/heed-keychain.new" --self-test
mv -f "$HEED_KEYCHAIN_OUTPUT/heed-keychain.new" "$HEED_KEYCHAIN_OUTPUT/heed-keychain"
printf 'Protected credential helper built: %s\n' "$HEED_KEYCHAIN_OUTPUT/heed-keychain"
