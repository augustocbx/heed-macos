"""Sweep the Layer-3 dedup threshold over the cached baseline transcripts (fast, text-only).
Finds the threshold that removes the foreign echo while keeping the most of Junior's own words.
The score's echo metric is fixed (thr 0.62 in score.py); the dedup thr is what we vary."""
import json, os, sys
from score import score
from dedup import dedup

ROOT = os.path.dirname(__file__); CACHE = os.path.join(ROOT, "cache")
gt = json.load(open(os.path.join(CACHE, "groundtruth.json")))
proc = json.load(open(os.path.join(CACHE, sys.argv[1] if len(sys.argv) > 1 else "proc_baseline.json")))

print(f"{'thr':>5} {'echo':>6} {'kept':>6} {'score':>6}")
for thr in [0.50, 0.55, 0.58, 0.62, 0.66, 0.70, 0.75, 0.80]:
    echo_rows, jun_rows, sc_rows = [], [], []
    for name, g in gt.items():
        if name not in proc:
            continue
        d = dedup(proc[name], g["sys_txt"], thr)
        s = score(d, g["sys_txt"], g["mic_raw"])
        if s["n_sys"] > 5:
            echo_rows.append(s["echo_in_mic"]); sc_rows.append(s["score"])
        if s["n_junior"] > 5:
            jun_rows.append(s["junior_kept"])
    e = sum(echo_rows)/max(1, len(echo_rows)); k = sum(jun_rows)/max(1, len(jun_rows)); sc = sum(sc_rows)/max(1, len(sc_rows))
    print(f"{thr:>5.2f} {e:>6.3f} {k:>6.3f} {sc:>6.3f}")
