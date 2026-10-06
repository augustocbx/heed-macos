#!/bin/bash
# Launch a separate QA menu: no launchd, system services, real privacy changes or public releases.
set -euo pipefail
HEED_QA_SOURCE="$(cd "$(dirname "$0")/../.." && pwd)"
bash "$HEED_QA_SOURCE/packages/desktop/install-menubar.sh" --build-only
HEED_QA_BINARY="${TMPDIR:-/tmp}/heed-menubar-build/Heed"
HEED_QA_ROOT="$(/usr/bin/python3 "$HEED_QA_SOURCE/scripts/release/menu_update_qa.py" prepare "$HEED_QA_BINARY")"
HEED_QA_PID="$(/usr/bin/python3 - "$HEED_QA_ROOT" <<'PYLAUNCH'
import os, subprocess, sys
root = sys.argv[1]
with open(root + '/menu.log', 'ab') as log:
    process = subprocess.Popen([root + '/Heed QA.app/Contents/MacOS/Heed', '--update-qa', root],
        env={**os.environ, 'HEED_APP_DIR':root + '/home/app', 'HEED_HOME':root + '/home/.heed'},
        start_new_session=True, stdin=subprocess.DEVNULL, stdout=log, stderr=log)
    print(process.pid)
PYLAUNCH
)"
printf 'QA folder: %s\nQA PID: %s\n' "$HEED_QA_ROOT" "$HEED_QA_PID"
printf 'Use the separate menu: Updates > Update…; confirm the local 0.1.1 fixture.\n'
printf 'Verify: /usr/bin/python3 "%s/helpers/scripts/release/menu_update_qa.py" verify --fixture "%s"\n' "$HEED_QA_ROOT" "$HEED_QA_ROOT"
printf 'Stop: /usr/bin/python3 "%s/helpers/scripts/release/menu_update_qa.py" stop --fixture "%s"\n' "$HEED_QA_ROOT" "$HEED_QA_ROOT"
