#!/bin/bash
set -euo pipefail
HEED_ICLOUD_ROOT="$(cd "$(dirname "$0")" && pwd)"
HEED_ICLOUD_OUTPUT="${HEED_ICLOUD_OUTPUT:-$HEED_ICLOUD_ROOT/.build/heed-icloud}"
mkdir -p "$(dirname "$HEED_ICLOUD_OUTPUT")"
HEED_ICLOUD_TEMP="$(mktemp -d -t heed-icloud-build)"
HEED_ICLOUD_SOURCE="$HEED_ICLOUD_TEMP/main.swift"
trap 'rm -rf "$HEED_ICLOUD_TEMP"' EXIT
cat "$HEED_ICLOUD_ROOT/ScopedFiles.swift" "$HEED_ICLOUD_ROOT/Admission.swift" "$HEED_ICLOUD_ROOT/Deletion.swift" "$HEED_ICLOUD_ROOT/Acceptance.swift" "$HEED_ICLOUD_ROOT/AcceptanceAuthority.swift" "$HEED_ICLOUD_ROOT/ProtocolTests.swift" "$HEED_ICLOUD_ROOT/Runtime.swift" "$HEED_ICLOUD_ROOT/HeedICloud.swift" > "$HEED_ICLOUD_SOURCE"
swiftc -O -target "$(uname -m)-apple-macos14.0" "$HEED_ICLOUD_SOURCE" -o "$HEED_ICLOUD_OUTPUT"
