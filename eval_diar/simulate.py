"""Simulate the LIVE offline-rolling diarization over a recording and score it vs the post-stop
ground truth. Measures the two things Junior cares about: phantom speakers (a single speaker split
into many) and naming false positives (wrong saved name). Params are env-tunable for sweeping.

  W        rolling window seconds            (default 25)
  STEP     cadence seconds                   (default 2)
  MERGE    within-window merge cosine thr    (default 0.55)
  RECON    session reconciliation cosine thr (default 0.55)
  NAMETHR  wespeaker naming threshold        (default 0.62)
  MARGIN   top1-top2 naming margin           (default 0.08)
  MINDUR   min accumulated s before naming   (default 4.0)
  MINKEEP  min accumulated s to count a spk  (default 3.0)

Usage: python3 simulate.py <recording.wav>            # single, verbose trace
       python3 simulate.py --all                       # the 3 tuning recordings, summary only
"""
import os, sys
from sidecar import Sidecar, extract_sys, slice_wav, wav_dur
from reconcile import Registry, merge_within_window, name_speakers, load_voices

RECS = [
    "../recordings/dual-capture-1782873076439.wav",  # 342s, 3 spk
    "../recordings/dual-capture-1782867599480.wav",  # 86s, 1 spk
    "../recordings/dual-capture-1782864214513.wav",  # 53s, 2 spk
]

W = float(os.environ.get("W", 25))
STEP = float(os.environ.get("STEP", 2))
MERGE = float(os.environ.get("MERGE", 0.55))
RECON = float(os.environ.get("RECON", 0.55))
NAMETHR = float(os.environ.get("NAMETHR", 0.62))
MARGIN = float(os.environ.get("MARGIN", 0.08))
MINDUR = float(os.environ.get("MINDUR", 4.0))
MINKEEP = float(os.environ.get("MINKEEP", 3.0))
CONSOLIDATE = float(os.environ.get("CONSOLIDATE", 0.5))


def run(sc, src, verbose=False):
    sysw = extract_sys(src)
    dur = wav_dur(sysw)
    # ground truth = the REAL post-stop pipeline: full-channel diarize THEN the same spurious-speaker
    # filter the server applies (>= 3s AND >= 12% of total) — NOT the raw sidecar count.
    full = sc.diarize(sysw)
    gt_dur = {}
    for s in full.get("segments", []):
        gt_dur[s["speaker"]] = gt_dur.get(s["speaker"], 0.0) + (s["end"] - s["start"])
    gt_tot = sum(gt_dur.values()) or 1.0
    gt_count = sum(1 for d in gt_dur.values() if d >= 3.0 and d / gt_tot >= 0.12)

    voices = load_voices()
    reg = Registry(recon_thr=RECON, voices=voices)
    active_ticks = {}   # session label -> # ticks it was the speaker NOW (real airtime = *STEP)
    seq = []            # sequence of active session labels (for churn)
    t = STEP            # start early with a GROWING window (mirrors the live server), not at t=W
    while t <= dur + STEP:
        ws = max(0.0, t - W)
        wd = min(W, dur - ws)
        if wd < 2:
            break
        sl = slice_wav(sysw, ws, wd)
        r = sc.diarize(sl)
        os.unlink(sl)
        segs = r.get("segments", [])
        embs = r.get("embeddings", {})
        durs = {}
        for s in segs:
            durs[s["speaker"]] = durs.get(s["speaker"], 0.0) + (s["end"] - s["start"])
        embs = {k: v for k, v in embs.items() if k in durs}
        active = None
        if embs:
            groups = merge_within_window(embs, durs, MERGE)
            mapping = reg.update(groups)
            reg.consolidate(CONSOLIDATE)
            name_speakers(reg, NAMETHR, MARGIN, MINDUR)
            # who is talking NOW = dominant speaker in the NEW slice [wd-STEP, wd] (window-local),
            # i.e. the text that just appeared — mirrors the server's per-turn labeling.
            slice_start = wd - STEP
            best_s, best_ov = None, 0.0
            for s in segs:
                ov = min(wd, s["end"]) - max(slice_start, s["start"])
                if ov > best_ov:
                    best_ov, best_s = ov, s
            last = best_s if best_s is not None else max(segs, key=lambda s: s["end"])
            active_gi = next((gi for gi, g in enumerate(groups) if last["speaker"] in g["ids"]), None)
            if active_gi is not None:
                active = reg.resolve(mapping[active_gi])  # stable session label (alias-resolved)
                active_ticks[active] = active_ticks.get(active, 0) + 1
                seq.append(active)
        if verbose:
            print(f"t={t:6.1f}  active={reg.display_of(active) if active else '-'}")
        t += STEP
    os.unlink(sysw)

    # REAL airtime per speaker + post-stop's spurious filter (>= MIN_ABS s AND >= MIN_FRAC of total).
    real = {lab: n * STEP for lab, n in active_ticks.items()}
    total = sum(real.values()) or 1.0
    MIN_ABS = float(os.environ.get("MIN_ABS", 3.0))
    MIN_FRAC = float(os.environ.get("MIN_FRAC", 0.12))
    kept_labels = [lab for lab, d in real.items() if d >= MIN_ABS and d / total >= MIN_FRAC]
    live_count = len(kept_labels)
    names = [(lab, reg.name_of(lab), round(reg.score_of(lab), 3), round(real[lab], 1)) for lab in kept_labels]
    churn = sum(1 for i in range(1, len(seq)) if seq[i] != seq[i - 1])
    return {"rec": os.path.basename(src), "gt": gt_count, "live": live_count,
            "phantom": max(0, live_count - gt_count), "names": names, "churn": churn, "ticks": len(seq)}


def main():
    sc = Sidecar()
    print(f"cfg: W={W} STEP={STEP} MERGE={MERGE} RECON={RECON} NAME(thr={NAMETHR} margin={MARGIN} mindur={MINDUR})")
    if sys.argv[1:] and sys.argv[1] != "--all":
        s = run(sc, sys.argv[1], verbose=True)
        print(s)
    else:
        tot_ph = 0
        for rec in RECS:
            s = run(sc, rec)
            tot_ph += s["phantom"]
            print(f"{s['rec'][:34]:34}  GT={s['gt']} live={s['live']} phantom={s['phantom']} "
                  f"churn={s['churn']}/{s['ticks']}  names={s['names']}")
        print(f"\nTOTAL phantom across 3: {tot_ph}   (objetivo: 0)")
    sc.close()


if __name__ == "__main__":
    main()
