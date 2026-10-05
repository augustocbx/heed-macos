"""Crux experiment: does the OFFLINE diarizer over-split a single continuous speaker when run on a
SHORT rolling window? For each recording, we (1) diarize the FULL sys channel = ground truth speaker
count, then (2) slide a window of size W and report how many speakers each window sees. If a
single-speaker recording yields 1 speaker per window, offline-rolling is viable. If windows over-split,
we need a bigger window or clustering tuning.

Usage: python3 exp_window.py <recording.wav> [W=25] [step=3]
"""
import sys, os
from sidecar import Sidecar, extract_sys, slice_wav, wav_dur

SRC = sys.argv[1]
W = float(sys.argv[2]) if len(sys.argv) > 2 else 25.0
STEP = float(sys.argv[3]) if len(sys.argv) > 3 else 3.0

sc = Sidecar()
sysw = extract_sys(SRC)
dur = wav_dur(sysw)
print(f"recording: {os.path.basename(SRC)}  sys_dur={dur:.1f}s  window={W}s step={STEP}s")

# (1) ground truth: full-channel offline diarize
full = sc.diarize(sysw)
gt_speakers = full.get("speakers", [])
gt_segs = full.get("segments", [])
gt_dur = {}
for s in gt_segs:
    gt_dur[s["speaker"]] = gt_dur.get(s["speaker"], 0.0) + (s["end"] - s["start"])
print(f"\nGROUND TRUTH (full, post-stop quality): {len(gt_speakers)} speaker(s)")
for spk, d in sorted(gt_dur.items(), key=lambda x: -x[1]):
    print(f"   {spk}: {d:.1f}s")

# (2) rolling windows: how many speakers per window
print(f"\nROLLING WINDOWS (offline on last {W}s):")
print(f"{'t_end':>6}  {'#spk':>4}  detail")
t = W
overs = 0
n = 0
while t <= dur + STEP:
    ws = max(0.0, t - W)
    wd = min(W, dur - ws)
    if wd < 2:
        break
    sl = slice_wav(sysw, ws, wd)
    r = sc.diarize(sl)
    os.unlink(sl)
    spks = r.get("speakers", [])
    segs = r.get("segments", [])
    durs = {}
    for s in segs:
        durs[s["speaker"]] = durs.get(s["speaker"], 0.0) + (s["end"] - s["start"])
    detail = " ".join(f"{k}={v:.1f}s" for k, v in sorted(durs.items(), key=lambda x: -x[1]))
    print(f"{t:6.1f}  {len(spks):>4}  {detail}")
    n += 1
    if len(spks) > len(gt_speakers):
        overs += 1
    t += STEP

print(f"\nSUMMARY: {overs}/{n} windows over-split beyond GT ({len(gt_speakers)} spk). "
      f"{'VIABLE (offline window keeps 1 speaker)' if overs == 0 else 'needs bigger W or clustering tune'}")
sc.close()
os.unlink(sysw)
