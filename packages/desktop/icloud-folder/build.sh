#!/bin/bash
set -euo pipefail
HEED_ICLOUD_ROOT="$(cd "$(dirname "$0")" && pwd)"
HEED_ICLOUD_OUTPUT="${HEED_ICLOUD_OUTPUT:-$HEED_ICLOUD_ROOT/.build/heed-icloud}"
mkdir -p "$(dirname "$HEED_ICLOUD_OUTPUT")"
swiftc -O -target "$(uname -m)-apple-macos14.0" "$HEED_ICLOUD_ROOT/HeedICloud.swift" -o "$HEED_ICLOUD_OUTPUT"
