"""Run the echo eval for the CURRENT server config across all cached samples. Processes each
recording's mic through the live /stream/feed path (mic with system reference), transcribes, scores
echo-leak + voice-preservation, optionally applies the Layer-3 text dedup, and aggregates.

Usage:  python3 run_config.py <label> [dedup]
  <label>  a name for this config (e.g. "baseline", "gate", "gate+aec-adaptive")
  dedup    if present, also apply Layer-3 text dedup and report the dedup'd score

The audio config (gate threshold, AEC mode) is whatever the running server is set to (via env)."""
import json, os, sys, urllib.request
import soundfile as sf
from score import score
from dedup import dedup

ROOT = os.path.dirname(__file__)
CACHE = os.path.join(ROOT, "cache")
SR = 16000
CH = int(0.7 * SR)


def post(p, b):
    r = urllib.request.Request("http://127.0.0.1:5002" + p,
        data=json.dumps(b).encode(), headers={"Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(r, timeout=120))


def process_mic(mic_wav, sys_wav):
    """Feed the recording through the live path (mic gets the system reference) → mic transcript."""
    mic, _ = sf.read(mic_wav, dtype="int16"); mic = mic[:, 0] if mic.ndim > 1 else mic
    sysa, _ = sf.read(sys_wav, dtype="int16"); sysa = sysa[:, 0] if sysa.ndim > 1 else sysa
    n = min(len(mic), len(sysa))
    post("/stream/start", {"language": "es", "channel": "mic"})
    post("/stream/start", {"language": "es", "channel": "sys"})
    tmp_m = os.path.join(CACHE, "_m.wav"); tmp_s = os.path.join(CACHE, "_s.wav")
    for i in range(0, n - CH, CH):
        sf.write(tmp_m, mic[i:i+CH], SR); sf.write(tmp_s, sysa[i:i+CH], SR)
        post("/stream/feed", {"wav_path": tmp_m, "channel": "mic", "audio_s": 0.7, "ref_wav_path": tmp_s})
        post("/stream/feed", {"wav_path": tmp_s, "channel": "sys", "audio_s": 0.7})
    return post("/stream/finish", {"channel": "mic"}).get("text", "")


def main():
    label = sys.argv[1] if len(sys.argv) > 1 else "config"
    use_dedup = "dedup" in sys.argv[2:]
    gt = json.load(open(os.path.join(CACHE, "groundtruth.json")))
    rows = []
    proc_cache = {}
    for name, g in gt.items():
        mic_proc = process_mic(g["mic"], g["sys"])
        proc_cache[name] = mic_proc  # save the pre-dedup transcript for offline dedup tuning
        if use_dedup:
            mic_proc = dedup(mic_proc, g["sys_txt"])
        s = score(mic_proc, g["sys_txt"], g["mic_raw"])
        s["name"] = name
        rows.append(s)
        print(f"  {name[-6:]}: echo={s['echo_in_mic']:.2f} kept={s['junior_kept']:.2f} score={s['score']:.2f}")
    # aggregate: echo only on samples with foreign speech; preservation on samples with Junior
    echo_rows = [r for r in rows if r["n_sys"] > 5]
    jun_rows = [r for r in rows if r["n_junior"] > 5]
    agg = {
        "label": label, "dedup": use_dedup,
        "echo_in_mic": round(sum(r["echo_in_mic"] for r in echo_rows) / max(1, len(echo_rows)), 3),
        "junior_kept": round(sum(r["junior_kept"] for r in jun_rows) / max(1, len(jun_rows)), 3),
        "score": round(sum(r["score"] for r in echo_rows) / max(1, len(echo_rows)), 3),
        "n_echo_samples": len(echo_rows), "n_jun_samples": len(jun_rows),
    }
    print(f"\n=== {label}{' +dedup' if use_dedup else ''} === echo={agg['echo_in_mic']} kept={agg['junior_kept']} SCORE={agg['score']} (over {len(echo_rows)} echo samples)")
    out = os.path.join(ROOT, "results.jsonl")
    with open(out, "a") as f:
        f.write(json.dumps(agg, ensure_ascii=False) + "\n")
    json.dump(proc_cache, open(os.path.join(CACHE, f"proc_{label}.json"), "w"), ensure_ascii=False, indent=1)
    return agg


if __name__ == "__main__":
    main()
