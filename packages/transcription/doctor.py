"""heed doctor — end-to-end self-test.

Run right after `npx create-heed` (or anytime) to confirm EVERY stage works on THIS machine,
BEFORE the user's first real meeting. It exercises the whole chain — ffmpeg, hardware probe,
model policy, a real Whisper transcription, diarization, and the notes engine — and prints a
per-stage health report. Core stages failing => non-zero exit so the installer can flag it.
Optional stages (diarization, notes) failing just degrade features, not the core product.

Usage:  python doctor.py
"""
import os
import sys
import subprocess

import capability
import policy


def _check(label, fn):
    try:
        ok, detail = fn()
        print(f"  [{'OK  ' if ok else 'FAIL'}] {label}: {detail}", flush=True)
        return ok
    except Exception as e:
        print(f"  [FAIL] {label}: {str(e)[:110]}", flush=True)
        return False


def main():
    print("\nheed doctor — checking this machine end-to-end...\n", flush=True)
    state = {}

    def ffmpeg_check():
        r = subprocess.run(["ffmpeg", "-version"], capture_output=True)
        return r.returncode == 0, "found"

    def probe_check():
        caps = capability.probe()
        state["caps"] = caps
        return caps.measured, f"{caps.accelerator}/{caps.engine}, reference small @ {caps.rtf}x real-time"

    def policy_check():
        plan = policy.decide(state["caps"], measure_final_rtf=capability.measure_model_rtf)
        state["plan"] = plan
        return True, f"final={plan.final_model}, live={plan.live_model}"

    def transcription_check():
        # Engine-agnostic: make_engine returns Parakeet (ANE) on Mac, MLX or faster-whisper otherwise.
        import engines
        caps, plan = state["caps"], state["plan"]
        dev = {"whisper": "cuda" if caps.accelerator == "cuda" else "cpu", "gpu_name": caps.gpu_name or ""}
        eng = engines.make_engine(plan.live_model, dev)
        segs, _ = eng.transcribe(capability.BUNDLED_SAMPLE, language="en")
        text = " ".join(s.text for s in segs).strip()
        return len(text) > 0, f'{caps.engine} → "{text[:40]}..."'

    def diarization_check():
        # Mac: FluidAudio via the Parakeet diar sidecar (CoreML, no token). Linux: pyannote.
        import engines
        if engines.is_apple_silicon() and engines.parakeet_available():
            r = engines.get_parakeet_diar().diarize(capability.BUNDLED_SAMPLE)
            n = len(set(str(s.get("speaker")) for s in r.get("segments", [])))
            return True, f"FluidAudio (CoreML, no token) — {n} speaker(s) on sample"
        os.environ["HF_HUB_OFFLINE"] = "1"
        from pyannote.audio import Pipeline
        Pipeline.from_pretrained("pyannote/speaker-diarization-3.1")
        return True, "pyannote speaker diarization available"

    def ollama_check():
        import urllib.request
        urllib.request.urlopen("http://localhost:11434/api/tags", timeout=3)
        return True, "notes engine reachable on :11434"

    core = [
        _check("ffmpeg (audio I/O)", ffmpeg_check),
        _check("hardware probe", probe_check),
        _check("model policy", policy_check),
        _check("transcription", transcription_check),
    ]
    diar_ok = _check("diarization (optional)", diarization_check)
    notes_ok = _check("notes engine / Ollama (optional)", ollama_check)

    print(flush=True)
    if all(core):
        print("heed is READY — transcription works on this machine.", flush=True)
        if not diar_ok:
            print("  note: diarization off -> transcription-only mode (still fully usable).", flush=True)
        if not notes_ok:
            print("  note: AI notes off -> install/start Ollama to enable them.", flush=True)
        sys.exit(0)
    else:
        print("heed has a problem in a CORE stage above — transcription may not work yet.", flush=True)
        sys.exit(1)


if __name__ == "__main__":
    main()
