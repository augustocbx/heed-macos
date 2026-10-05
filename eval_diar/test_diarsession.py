"""Validate the PRODUCTION DiarSession (ported into transcription_server.py) reproduces the harness
result: 0 phantoms across the 3 recordings. Drives the sidecar directly (offline diarize on rolling
windows) and feeds each window to DiarSession.feed(), scoring active-tick airtime vs post-stop GT."""
import os, sys
sys.path.insert(0, "../packages/transcription")
from sidecar import Sidecar, extract_sys, slice_wav, wav_dur
from transcription_server import DiarSession  # import must not start the server (guarded by __main__)

RECS = [
    ("../recordings/dual-capture-1782873076439.wav", 342),
    ("../recordings/dual-capture-1782867599480.wav", 86),
    ("../recordings/dual-capture-1782864214513.wav", 53),
]
W, STEP = 30.0, 2.0


def gt_count(sc, sysw):
    full = sc.diarize(sysw)
    d = {}
    for s in full.get("segments", []):
        d[s["speaker"]] = d.get(s["speaker"], 0.0) + (s["end"] - s["start"])
    tot = sum(d.values()) or 1.0
    return sum(1 for v in d.values() if v >= 3.0 and v / tot >= 0.12)


def run(sc, src):
    sysw = extract_sys(src)
    dur = wav_dur(sysw)
    gt = gt_count(sc, sysw)
    sess = DiarSession()
    ticks = {}
    seq = []
    t = STEP
    while t <= dur + STEP:
        ws = max(0.0, t - W)
        wd = min(W, dur - ws)
        if wd < 2:
            break
        sl = slice_wav(sysw, ws, wd)
        d = sc.diarize(sl)
        os.unlink(sl)
        res = sess.feed(d.get("segments", []), d.get("embeddings", {}), window_s=wd)
        sp = res.get("label")
        if sp:
            ticks[sp] = ticks.get(sp, 0) + 1
            seq.append(sp)
        t += STEP
    os.unlink(sysw)
    real = {k: n * STEP for k, n in ticks.items()}
    tot = sum(real.values()) or 1.0
    kept = [k for k, v in real.items() if v >= 3.0 and v / tot >= 0.12]
    churn = sum(1 for i in range(1, len(seq)) if seq[i] != seq[i - 1])
    return gt, len(kept), kept, churn, len(seq)


sc = Sidecar()
total_ph = 0
for src, _ in RECS:
    gt, live, kept, churn, n = run(sc, src)
    ph = max(0, live - gt)
    total_ph += ph
    print(f"{os.path.basename(src)[:34]:34} GT={gt} live={live} phantom={ph} churn={churn}/{n} {kept}")
print(f"\nTOTAL phantom: {total_ph}  (objetivo 0) — {'PORT OK' if total_ph == 0 else 'MISMATCH'}")
sc.close()
