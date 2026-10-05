"""Cache the OFFLINE diarizer output per rolling window for the 4 tuning recordings, so DiarSession
param sweeps run instantly (no sidecar per iteration). Run once (~5 min). W fixed at 30; STEP=1
(finest) — sweeps can subsample. Also caches the full-channel post-stop diarize = ground truth."""
import json, os, sys
from sidecar import Sidecar, extract_sys, slice_wav, wav_dur

RECS = [
    "../recordings/dual-capture-1782880963595.wav",  # 234s ~4 spk (man-split case)
    "../recordings/dual-capture-1782873076439.wav",  # 342s 3 spk
    "../recordings/dual-capture-1782867599480.wav",  # 86s 1 spk
    "../recordings/dual-capture-1782864214513.wav",  # 54s 2 spk ECHO
]
W = 30.0
STEP = 1.0
CACHE = os.path.join(os.path.dirname(__file__), "cache")
os.makedirs(CACHE, exist_ok=True)


def build(sc, src):
    name = os.path.basename(src)
    out = os.path.join(CACHE, name + ".json")
    sysw = extract_sys(src)
    dur = wav_dur(sysw)
    # ground truth: full-channel post-stop diarize (+ filter applied later in the scorer)
    full = sc.diarize(sysw)
    windows = []
    t = STEP
    while t <= dur + STEP:
        ws = max(0.0, t - W)
        wd = min(W, dur - ws)
        if wd < 2:
            break
        sl = slice_wav(sysw, ws, wd)
        d = sc.diarize(sl)
        os.unlink(sl)
        windows.append({"t": round(t, 2), "window_s": round(wd, 3),
                        "segments": d.get("segments", []), "embeddings": d.get("embeddings", {})})
        t += STEP
    os.unlink(sysw)
    json.dump({"rec": name, "dur": dur, "W": W, "STEP": STEP,
               "gt_full": {"segments": full.get("segments", []), "embeddings": full.get("embeddings", {})},
               "windows": windows}, open(out, "w"))
    print(f"cached {name}: dur={dur:.0f}s windows={len(windows)} -> {out}")


sc = Sidecar()
for r in RECS:
    build(sc, r)
sc.close()
print("done")
