#!/bin/bash
# restart_and_run.sh <gate_rms> <aec_mode> <label> [dedup]
# Restarts the stack with the given echo config (env) and runs the eval across all samples.
set -e
GATE="$1"; AEC="$2"; LABEL="$3"; DEDUP="$4"
cd /Users/junrod/heed-v3
pkill -f "concurrently -n server" 2>/dev/null || true
pkill -f "transcription_server.py" 2>/dev/null || true
pkill -f "bun run server.ts" 2>/dev/null || true
pkill -f "dev:client" 2>/dev/null || true
pkill -f "node.*vite" 2>/dev/null || true
sleep 2
HEED_MIC_GATE_RMS="$GATE" HEED_AEC_MODE="$AEC" nohup bun run dev > /tmp/heed-dev.log 2>&1 &
disown
for i in $(seq 1 90); do grep -qE "first record is instant|pre-warm skipped" /tmp/heed-dev.log 2>/dev/null && break; sleep 1; done
sleep 2
echo ">>> CONFIG: gate=$GATE aec=$AEC label=$LABEL dedup=$DEDUP"
/Users/junrod/heed/.venv/bin/python3 eval_echo/run_config.py "$LABEL" $DEDUP
