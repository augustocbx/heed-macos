#!/usr/bin/env python3
"""linux_sim.py — simulate heed's LINUX post-stop pipeline on any machine (incl. this Mac).

WHY: heed's Mac path (Parakeet + FluidAudio sidecar on the ANE) is Apple-only. On Linux heed
falls back to faster-whisper (CTranslate2) + pyannote. That fallback path is pure Python/torch,
so we can exercise it EXACTLY on a Mac by (a) forcing the CTranslate2 engine on CPU and (b)
running pyannote on CPU — no CUDA, no sidecar. This lets us measure Linux quality + RTF without
owning the Linux box, and predict what Junior's GTX 1650 (4GB) will do.

WHAT IT RUNS (mirrors transcription_server._stream_dual, the real Linux post-stop):
    stereo WAV  ── split ──┬─ mic.wav ─ faster-whisper(CPU,int8) ─ "Me" segments
                           └─ sys.wav ─ faster-whisper(CPU,int8) ─ sys SRT
                                 └───── pyannote(CPU) ── assign_speakers(by SRT overlap)
It reports per-stage wall-time, RTF (audio_s / process_s), speaker count and the merged turns.

USAGE:
    # from repo root, with the fallback stack installed (torch + faster-whisper + pyannote):
    python scripts/linux_sim.py <dual-capture-*.wav> [--model small] [--lang es]
    python scripts/linux_sim.py recordings/dual-capture-1781629264996.wav

    # simulate a WEAKER GPU/CPU tier explicitly (model is what device power would pick):
    python scripts/linux_sim.py <wav> --model base      # what a low-VRAM 1650 might land on
    python scripts/linux_sim.py <wav> --model large-v3  # what an RTX 4090 would run

    # estimate GTX 1650 behaviour from the model-policy simulator (no audio needed):
    python scripts/linux_sim.py --plan-only

If torch/faster-whisper/pyannote are NOT installed, the script prints exact install steps and
exits 0 (never a stack trace) — the point is to be runnable-or-self-documenting on a Mac.
"""
import os
import sys
import time
import json
import argparse

# --- make the transcription package importable (engines, transcription_server, policy) ---
_HERE = os.path.dirname(os.path.abspath(__file__))
_TX = os.path.join(_HERE, "..", "packages", "transcription")
sys.path.insert(0, os.path.abspath(_TX))

# Force the NON-Apple path even on Apple Silicon: CTranslate2 on CPU is the Linux CPU engine,
# and it's byte-for-byte the same code faster-whisper runs on a Linux box.
os.environ["HEED_ENGINE"] = "ctranslate2"


def _check_deps():
    """Return (ok, missing[]) for the Linux fallback stack."""
    missing = []
    for mod, pip in [("torch", "torch"), ("faster_whisper", "faster-whisper"),
                     ("pyannote.audio", "pyannote.audio")]:
        try:
            __import__(mod)
        except Exception:
            missing.append(pip)
    return (not missing), missing


def _print_install_help(missing):
    venv = os.environ.get("VIRTUAL_ENV") or "<your venv>"
    print("=" * 74)
    print("linux_sim: the Linux fallback stack is not installed in this Python.")
    print(f"  missing: {', '.join(missing)}")
    print("=" * 74)
    print("This path needs torch + faster-whisper + pyannote (~1.6GB). To run it here:\n")
    print("  # activate heed's venv (the repo symlinks .venv -> ~/heed/.venv):")
    print("  source .venv/bin/activate")
    print("  pip install -r packages/transcription/requirements-fallback.txt\n")
    print("Then re-run, e.g.:")
    print("  python scripts/linux_sim.py recordings/dual-capture-1781629264996.wav\n")
    print("NOTE: pyannote/speaker-diarization-3.1 weights must be cached in")
    print("  ~/.cache/huggingface (a gated model — accept its terms once with an HF token).")
    print("  On this Mac they are already cached, so the sim runs fully offline.")


def _wav_seconds(path):
    import wave
    with wave.open(path) as w:
        return w.getnframes() / float(w.getframerate() or 16000)


def plan_only():
    """Print the model-policy decision for Junior's GTX 1650 (4GB) + reference GPUs — no audio."""
    import policy
    from capability import Capabilities

    def make(name, **kw):
        base = dict(os="linux", arch="x86_64", cpu_count=6, total_ram_mb=16000,
                    accelerator="cuda", gpu_name="GPU", total_vram_mb=4000,
                    engine="ctranslate2", bench_model="small", rtf=12.0, bench_ms=0,
                    measured=True, fingerprint="x")
        base.update(kw)
        return name, Capabilities(**base)

    profiles = [
        make("Junior GTX 1650 (4GB, 6c)", total_vram_mb=4000, cpu_count=6, rtf=12.0,
             gpu_name="GTX 1650"),
        make("GTX 1650 pyannote-on-GPU/whisper-CPU", total_vram_mb=4000, cpu_count=6, rtf=3.5,
             gpu_name="GTX 1650 (whisper on CPU)", accelerator="cpu", total_ram_mb=16000),
        make("RTX 2080 (8GB)", total_vram_mb=8000, rtf=35.0, gpu_name="RTX 2080"),
        make("RTX 4090 (24GB)", total_vram_mb=24000, rtf=60.0, gpu_name="RTX 4090"),
        make("CPU-only Ryzen 5 5500 (6c/16GB)", accelerator="cpu", total_vram_mb=0,
             total_ram_mb=16000, cpu_count=6, rtf=3.0),
    ]
    print(f"{'profile':40} {'final':10} {'live':8} reason")
    for name, caps in profiles:
        p = policy.plan(caps)
        print(f"{name:40} {p.final_model:10} {p.live_model:8} {p.reason}")
    print("\nEstimated RTF per tier for the GTX 1650 (from measured small=12x on a mid GPU):")
    _, caps = make("x", rtf=12.0)
    for tier in ["tiny", "base", "small", "medium", "large-v3"]:
        print(f"  {tier:10} ~{caps.estimated_rtf(tier):.1f}x  (final target >=3x, live >=15x)")


def run(wav_path, model, lang):
    import engines  # noqa: F401  (import validates the package path)
    import transcription_server as tx

    if not os.path.exists(wav_path):
        print(f"linux_sim: file not found: {wav_path}")
        return 2

    audio_s = _wav_seconds(wav_path)
    print(f"\n[linux_sim] Simulating the LINUX post-stop pipeline (CTranslate2/CPU + pyannote/CPU)")
    print(f"[linux_sim] input: {wav_path}  ({audio_s:.1f}s audio)")
    print(f"[linux_sim] model: {model}   lang: {lang}")
    print(f"[linux_sim] NOTE: on Junior's GTX 1650 whisper would run on CUDA fp16 (faster than this")
    print(f"[linux_sim]       CPU int8 run) and pyannote on GPU — treat CPU timings as a slow floor.\n")

    # --- device config: force the Linux CPU fallback (whisper CPU int8, pyannote CPU) ---
    device_cfg = {"whisper": "cpu", "pyannote": "cpu", "gpu_available": False,
                  "gpu_name": None, "free_vram_mb": 0, "total_vram_mb": 0,
                  "cpu_count": os.cpu_count() or 0, "ram_mb": tx.get_system_ram_mb()}

    # --- load whisper (CTranslate2 CPU int8) — the exact Linux-CPU engine ---
    t0 = time.time()
    eng, actual = tx._load_whisper_with_fallback(model, device_cfg, _make_warmup(), "sim-final")
    tx.whisper_model = eng
    tx.whisper_model_name = actual
    print(f"[linux_sim] whisper '{actual}' loaded in {time.time()-t0:.1f}s (CTranslate2 CPU int8)")

    # --- load pyannote on CPU (the Linux diarizer) ---
    t0 = time.time()
    try:
        import torch
        from pyannote.audio import Pipeline
        os.environ["HF_HUB_OFFLINE"] = "1"
        os.environ["TRANSFORMERS_OFFLINE"] = "1"
        tx.diarize_pipeline = Pipeline.from_pretrained("pyannote/speaker-diarization-3.1")
        tx.diarize_pipeline.to(torch.device("cpu"))
        tx.diarize_backend = "pyannote"
        tx.models_ready["pyannote"] = True
        print(f"[linux_sim] pyannote loaded in {time.time()-t0:.1f}s (CPU)")
    except Exception as e:
        print(f"[linux_sim] pyannote unavailable ({str(e)[:120]}) — running TRANSCRIPTION-ONLY")
        tx.diarize_pipeline = None
        tx.diarize_backend = None
        tx.models_ready["pyannote"] = False

    # --- run the real _stream_dual via a tiny SSE collector (same code Linux hits) ---
    events = {"segment": [], "phase": [], "speakers": [], "done": []}
    stage_t = {}

    def sse(event, data):
        events.setdefault(event, []).append(data)
        if event == "phase":
            stage_t[data.get("phase") + ":" + str(data.get("channel", ""))] = time.time()

    handler = tx.Handler.__new__(tx.Handler)  # bypass BaseHTTPRequestHandler __init__
    t_pipe = time.time()
    handler._stream_dual(sse, wav_path, lang, None, None)
    pipe_s = time.time() - t_pipe

    # --- report ---
    spk = events.get("speakers", [{}])[-1] if events.get("speakers") else {}
    done = events.get("done", [{}])[-1] if events.get("done") else {}
    speakers = spk.get("speakers", [])
    embeddings = spk.get("embeddings", {})
    # Prefer the FINAL, speaker-corrected segments (the "speakers" event) over the progressive
    # "segment" stream (which labels sys as "???" until pyannote finishes) — this is what the user
    # ultimately sees saved. Falls back to the progressive stream if the final event is absent.
    segs = spk.get("segments") or events.get("segment", [])
    mic_segs = [s for s in segs if s.get("channel") == "mic"]
    sys_segs = [s for s in segs if s.get("channel") == "sys"]

    print("\n" + "=" * 74)
    print(f"[linux_sim] DONE in {pipe_s:.1f}s  ->  RTF {audio_s/max(pipe_s,1e-3):.2f}x real-time")
    print(f"            (a GTX 1650 with whisper on CUDA + pyannote on GPU would be materially faster)")
    print("=" * 74)
    print(f"  audio length      : {audio_s:.1f}s")
    print(f"  detected language : {done.get('language')}")
    print(f"  whisper model     : {done.get('model')}")
    print(f"  mic segments (Me) : {len(mic_segs)}")
    print(f"  sys segments      : {len(sys_segs)}")
    print(f"  speakers found    : {speakers}  (embeddings: {list(embeddings.keys())})")
    print(f"  per-speaker embeds: {'ONE 512-d vector PER SPEAKER (pyannote) — NOT per-segment' if embeddings else 'none'}")
    print("\n  --- merged turns (first 12) ---")
    all_turns = sorted(mic_segs + sys_segs, key=lambda s: s["start"])
    for s in all_turns[:12]:
        print(f"    [{s['start']:6.1f}-{s['end']:6.1f}] {s['speaker']:12} ({s['channel']}) {s['text'][:60]}")
    if len(all_turns) > 12:
        print(f"    ... +{len(all_turns)-12} more")
    print()
    return 0


def _make_warmup():
    import struct, wave, tempfile
    p = tempfile.mktemp(suffix=".wav")
    with wave.open(p, "w") as wf:
        wf.setnchannels(1); wf.setsampwidth(2); wf.setframerate(16000)
        wf.writeframes(struct.pack("<" + "h" * 8000, *([0] * 8000)))
    return p


def main():
    ap = argparse.ArgumentParser(description="Simulate heed's Linux post-stop pipeline.")
    ap.add_argument("wav", nargs="?", help="stereo dual-capture WAV (L=mic, R=system)")
    ap.add_argument("--model", default="small", help="whisper tier: base|small|medium|large-v3")
    ap.add_argument("--lang", default="auto", help="language code (es/en/...) or 'auto'")
    ap.add_argument("--plan-only", action="store_true", help="just print the model-policy plan (no audio)")
    args = ap.parse_args()

    ok, missing = _check_deps()
    if not ok:
        _print_install_help(missing)
        return 0

    if args.plan_only or not args.wav:
        plan_only()
        if not args.wav:
            print("\n(pass a dual-capture WAV to run the full transcription+diarization sim)")
        return 0

    return run(args.wav, args.model, args.lang)


if __name__ == "__main__":
    sys.exit(main())
