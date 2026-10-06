#!/bin/bash
# restart_and_run.sh <gate_rms> <aec_mode> <label> [dedup]
# Restart only this checkout's idle, verified services before the local echo eval.
set -euo pipefail
HEED_EVAL_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HEED_MIC_GATE_RMS="$1"; HEED_AEC_MODE="$2"; HEED_EVAL_LABEL="$3"; HEED_EVAL_DEDUP="${4:-}"
export HEED_MIC_GATE_RMS HEED_AEC_MODE
cd "$HEED_EVAL_ROOT"
python3 scripts/service_config.py api >/dev/null
export HEED_LIFECYCLE_GUARD_TOKEN="$(python3 -c 'import uuid;print(uuid.uuid4())')"
python3 packages/desktop/guard-lifecycle.py acquire
trap 'python3 packages/desktop/guard-lifecycle.py release || true' EXIT
python3 scripts/service_runtime.py restart --root "$HEED_EVAL_ROOT"
python3 scripts/service_runtime.py start --root "$HEED_EVAL_ROOT"
python3 - "$HEED_EVAL_ROOT" <<'PYREADY'
import json,sys,time,urllib.request
sys.path.insert(0,sys.argv[1]+'/scripts')
from service_config import transcription_url
from service_runtime import read_identity
for _ in range(90):
    health=read_identity(transcription_url(),'heed-transcription',sys.argv[1])
    if health and health['ready']:break
    time.sleep(1)
else:sys.exit('This checkout transcription models did not become ready; unrelated services were preserved.')
PYREADY
printf 'CONFIG: gate=%s aec=%s label=%s dedup=%s\n' "$HEED_MIC_GATE_RMS" "$HEED_AEC_MODE" "$HEED_EVAL_LABEL" "$HEED_EVAL_DEDUP"
.venv/bin/python3 eval_echo/run_config.py "$HEED_EVAL_LABEL" ${HEED_EVAL_DEDUP:+"$HEED_EVAL_DEDUP"}
