#!/usr/bin/env python3
"""
heed — post-stop postmortem harness.

Thin wrapper over transcription_server.finalize_recording() (the SAME code the /finalize endpoint and
the real post-stop use) so we can iterate on real recordings and eyeball the result.

Usage:
  .venv/bin/python3 scripts/postmortem.py [wav_path] [--lang es]
Defaults to the newest recordings/dual-capture-*.wav.
"""
import os
import sys
import glob
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "packages", "transcription"))

import transcription_server as ts  # noqa: E402


def newest_recording():
    files = glob.glob(os.path.join(ROOT, "recordings", "dual-capture-*.wav"))
    return max(files, key=os.path.getmtime) if files else None


def fmt(t):
    m, s = divmod(int(t), 60)
    return f"{m:02d}:{s:02d}"


def main():
    # The harness imports the module without booting the server, so the diarize backend global is
    # never set → current_backend()=="unknown" and voice naming/eviction can't match. Pin it here so
    # match_voice / the Voice-RAG eviction run standalone exactly as they do in the live server.
    ts.diarize_backend = "parakeet"
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    lang = sys.argv[sys.argv.index("--lang") + 1] if "--lang" in sys.argv else "es"
    wav = args[0] if args else newest_recording()
    if not wav or not os.path.exists(wav):
        print("no recording found"); sys.exit(1)
    is_dual = "dual-capture-" in os.path.basename(wav)
    print(f"[postmortem] audio: {wav}\n[postmortem] lang: {lang} | dual: {is_dual}")

    t0 = time.time()
    result = ts.finalize_recording(wav, lang, is_dual)
    dt = time.time() - t0
    turns = result["turns"]

    print("\n===== COHERENT TRANSCRIPT (re-transcribed, real timestamps, echo removed) =====")
    for t in turns:
        print(f"[{fmt(t['start'])}-{fmt(t['end'])}] {t['speaker']}: {t['text']}")

    from collections import Counter
    import math
    dist = Counter(t["speaker"] for t in turns)
    dur_by = {}
    for t in turns:
        dur_by[t["speaker"]] = dur_by.get(t["speaker"], 0.0) + (t["end"] - t["start"])
    print("\n===== METRICS =====")
    print(f"turns: {len(turns)} | speakers ({len(result['speakers'])}): {result['speakers']}")
    print("distribution (turns / seconds):")
    for spk, n in dist.most_common():
        print(f"  {spk}: {n} turns, {dur_by.get(spk,0):.0f}s")
    print(f"auto-named: {result.get('auto_named', {})}")

    emb = result.get("embeddings", {})
    def cos(a, b):
        s = sum(x*y for x, y in zip(a, b)); na = math.sqrt(sum(x*x for x in a)); nb = math.sqrt(sum(y*y for y in b))
        return s/(na*nb+1e-9)
    ks = [k for k in result["speakers"] if k in emb]
    if len(ks) > 1:
        print("inter-speaker cosine matrix (low = distinct people, good):")
        print("        " + "  ".join(f"{k[:6]:>6}" for k in ks))
        for a in ks:
            print(f"  {a[:6]:>6} " + " ".join(f"{cos(emb[a],emb[b]):>6.2f}" for b in ks))
    print("\nsample line per speaker:")
    for spk in dist:
        first = next((t for t in turns if t["speaker"] == spk), None)
        if first:
            print(f"  [{fmt(first['start'])}] {spk}: {first['text'][:70]}")
    print(f"\npipeline time: {dt:.1f}s (audio ~{fmt(os.path.getsize(wav)/64000)})")


if __name__ == "__main__":
    main()
