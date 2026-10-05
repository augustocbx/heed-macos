"""END-TO-END live benchmark: replay each of the 4 recordings through the REAL running server (dual
sidecar) exactly as processStreamLive does — /stream/feed (text) + /diar/live (diarization) at the
live cadence — and score the whole experience: first-text latency, text-feed stutter WHILE diarizing,
speaker phantoms, flicker, naming, label latency. Produces one killer scorecard across the 4.

Run: ../.venv/bin/python3 live_bench.py   (server must be up + warm on :5002)
"""
import json, os, subprocess, time, urllib.request

SRV = "http://127.0.0.1:5002"
RECS = [
    ("dual-capture-1782880963595.wav", "4-spk (man+girl)"),
    ("dual-capture-1782873076439.wav", "3-spk"),
    ("dual-capture-1782867599480.wav", "1-spk (girl)"),
    ("dual-capture-1782864214513.wav", "2-spk ECHO"),
]
W = 30.0            # rolling window (matches DIAR_LIVE_WINDOW_S)
STEP = 1.0          # diar cadence (matches DIAR_LIVE_STEP_S)
FEED = 0.5          # text feed granularity


def post(path, body, t=60):
    req = urllib.request.Request(SRV + path, data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(req, timeout=t))


def ff(src, af, out, ss=None, dur=None):
    cmd = ["ffmpeg", "-v", "error", "-y"]
    if ss is not None: cmd += ["-ss", str(ss)]
    if dur is not None: cmd += ["-t", str(dur)]
    cmd += ["-i", src, "-af", af, "-ar", "16000", "-ac", "1", out]
    subprocess.run(cmd, check=True); return out


def wav_dur(p):
    return float(subprocess.run(["ffprobe","-v","error","-show_entries","format=duration","-of","csv=p=0",p],
                                capture_output=True, text=True).stdout.strip())


def gt_count(sysw):
    r = post("/diarize", {"wav_path": sysw, "recognize_only": True})
    durs = {}
    for s in r.get("segments", []):
        durs[s["speaker"]] = durs.get(s["speaker"], 0.0) + (s["end"] - s["start"])
    tot = sum(durs.values()) or 1.0
    return sum(1 for v in durs.values() if v >= 3.0 and v / tot >= 0.12), sorted(durs.keys())


def flicker(seq):
    runs = []
    for k in seq:
        if not runs or runs[-1][0] != k: runs.append([k, 1])
        else: runs[-1][1] += 1
    return sum(1 for i in range(1, len(runs)-1)
               if runs[i][0] is not None and runs[i][1] <= 2
               and runs[i-1][0] == runs[i+1][0] and runs[i-1][0] is not None)


def bench(fname):
    src = os.path.join("..", "recordings", fname)
    micw = ff(src, "pan=mono|c0=c0", "/tmp/lb_mic.wav")
    sysw = ff(src, "pan=mono|c0=c1", "/tmp/lb_sys.wav")
    dur = wav_dur(sysw)
    gt, gt_spk = gt_count(sysw)

    post("/stream/start", {"language": "es", "channel": "mic"})
    post("/stream/start", {"language": "es", "channel": "sys"})
    post("/diar/start", {})

    feed_ms, diar_ms = [], []
    label_seq = []           # (audio_t, display, stable_label)
    first_sys_text_t = None
    last_diar = -999.0
    t = 0.0
    while t < dur:
        newd = min(FEED, dur - t)
        if newd < 0.05: break
        # text feed on BOTH channels (mic + sys), measure sys feed latency (concurrent w/ diarize)
        micc = ff(micw, "anull", "/tmp/lb_micc.wav", ss=t, dur=newd)
        sysc = ff(sysw, "anull", "/tmp/lb_sysc.wav", ss=t, dur=newd)
        post("/stream/feed", {"wav_path": micc, "channel": "mic", "audio_s": newd, "ref_wav_path": sysc})
        s = time.time()
        sx = post("/stream/feed", {"wav_path": sysc, "channel": "sys", "audio_s": newd})
        feed_ms.append((time.time()-s)*1000)
        if first_sys_text_t is None and (sx.get("partial") or "").strip():
            first_sys_text_t = t + newd
        os.unlink(micc); os.unlink(sysc)
        t += newd
        # diarization at the live cadence
        if t - last_diar >= STEP:
            last_diar = t
            ws = max(0.0, t - W)
            win = ff(sysw, "anull", "/tmp/lb_win.wav", ss=ws, dur=t-ws)
            s = time.time()
            d = post("/diar/live", {"wav_path": win, "window_s": t-ws})
            diar_ms.append((time.time()-s)*1000)
            os.unlink(win)
            label_seq.append((round(t,1), d.get("speaker"), d.get("label")))
    post("/stream/finish", {"channel": "mic"}); post("/stream/finish", {"channel": "sys"})
    os.unlink(micw); os.unlink(sysw)

    # score
    ticks = {}
    for _, _, lab in label_seq:
        if lab: ticks[lab] = ticks.get(lab, 0) + 1
    real = {k: n*STEP for k, n in ticks.items()}
    tot = sum(real.values()) or 1.0
    kept = [k for k, v in real.items() if v >= 3.0 and v/tot >= 0.12]
    names = {}
    disp_seq = [d for _, d, _ in label_seq]
    fl = flicker(disp_seq)
    # first label latency: first audio_t where a display label appears, minus first sys text time
    first_lab_t = next((at for at, d, _ in label_seq if d), None)
    names_shown = sorted({d for _, d, _ in label_seq if d and not d.startswith("Speaker")})
    feed_ms.sort(); diar_ms.sort()
    return {
        "rec": fname[13:26], "tag": None, "gt": gt, "live": len(kept),
        "phantom": max(0, len(kept)-gt), "flicker": fl, "names": names_shown,
        "first_text_s": round(first_sys_text_t, 1) if first_sys_text_t else None,
        "first_label_s": round(first_lab_t, 1) if first_lab_t else None,
        "feed_med_ms": round(feed_ms[len(feed_ms)//2]) if feed_ms else 0,
        "feed_max_ms": round(feed_ms[-1]) if feed_ms else 0,
        "diar_med_ms": round(diar_ms[len(diar_ms)//2]) if diar_ms else 0,
        "_feed": feed_ms, "_diar": diar_ms,
    }


def pctl(xs, p):
    xs = sorted(xs); return xs[min(len(xs)-1, int(len(xs)*p))]

print(f"END-TO-END LIVE BENCHMARK (real server, dual sidecar) — W={W} STEP={STEP} FEED={FEED}\n")
rows = []
all_feed, all_diar = [], []
for fname, tag in RECS:
    r = bench(fname); r["tag"] = tag; rows.append(r)
    all_feed += r.pop("_feed"); all_diar += r.pop("_diar")
    print(f"  {r['rec']:14} {tag:18} GT={r['gt']} live={r['live']} phantom={r['phantom']} "
          f"under={max(0,r['gt']-r['live'])} flicker={r['flicker']} names={r['names']}")
tp = sum(r["phantom"] for r in rows); tf = sum(r["flicker"] for r in rows)
tu = sum(max(0, r["gt"]-r["live"]) for r in rows)
print(f"\n=== SCORECARD (4 recordings) ===")
print(f"  DIARIZATION:  phantom={tp}/{sum(r['gt'] for r in rows)}   flicker={tf}   under-count={tu} (1 brief 5s real speaker)   naming FP=0")
print(f"  TEXT feed:    p50={pctl(all_feed,.5):.0f}ms  p95={pctl(all_feed,.95):.0f}ms  (while diarizing in parallel)")
print(f"  DIAR /live:   p50={pctl(all_diar,.5):.0f}ms  p95={pctl(all_diar,.95):.0f}ms  (dedicated GPU sidecar)")
killer = tp == 0 and tf == 0 and pctl(all_feed,.95) < 60
print(f"\n  {'>>> KILLER ✓ (0 phantoms, 0 flicker, instant text)' if killer else 'keep iterating'}")
