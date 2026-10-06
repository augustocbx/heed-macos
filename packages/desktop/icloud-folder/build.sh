#!/bin/bash
set -euo pipefail
HEED_ICLOUD_ROOT="$(cd "$(dirname "$0")" && pwd)"
HEED_ICLOUD_OUTPUT="${HEED_ICLOUD_OUTPUT:-$HEED_ICLOUD_ROOT/.build/heed-icloud}"
mkdir -p "$(dirname "$HEED_ICLOUD_OUTPUT")"
HEED_ICLOUD_SOURCE="$(mktemp -t heed-icloud-source).swift"
trap 'rm -f "$HEED_ICLOUD_SOURCE"' EXIT
cat "$HEED_ICLOUD_ROOT/ScopedFiles.swift" "$HEED_ICLOUD_ROOT/ProtocolTests.swift" "$HEED_ICLOUD_ROOT/Runtime.swift" "$HEED_ICLOUD_ROOT/HeedICloud.swift" > "$HEED_ICLOUD_SOURCE"
swiftc -O -target "$(uname -m)-apple-macos14.0" "$HEED_ICLOUD_SOURCE" -o "$HEED_ICLOUD_OUTPUT"
