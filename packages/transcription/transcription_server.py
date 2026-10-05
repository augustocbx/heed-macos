#!/usr/bin/env python3
"""
heed transcription + diarization server
Keeps models loaded in memory for instant processing.
Runs as an HTTP server on port 5002.

Endpoints:
  POST /transcribe  {wav_path, language, srt_output}  → {text, srt_path, segments}
  POST /diarize     {wav_path, srt_path, min_speakers, max_speakers} → {speakers, segments, text}
  POST /process     {wav_path, language, diarize, min_speakers, max_speakers} → full result (parallel)
  GET  /health      → {ready, whisper, pyannote}
"""
import json
import os
import re
import sys
import time
import warnings
import threading
import subprocess
from http.server import HTTPServer, BaseHTTPRequestHandler
from socketserver import ThreadingMixIn
from concurrent.futures import ThreadPoolExecutor

# Threading HTTP server so health/hardware checks don't block while whisper is processing.
# Without this, the server is single-threaded and ANY request during transcription hangs.
class ThreadingHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True

# Locks to prevent concurrent calls to the same whisper model (not thread-safe).
# Different model instances (final vs live) CAN run concurrently.
whisper_lock = threading.Lock()
whisper_live_lock = threading.Lock()

warnings.filterwarnings("ignore")
# HF_HUB_OFFLINE is set AFTER model loading in load_models() so that
# first-time downloads (auto-picked whisper models) can reach HuggingFace.

PORT = int(os.environ.get("HEED_TRANSCRIPTION_PORT", "5002"))

# Stable-by-default profile to prioritize transcript quality/reliability.
# Set HEED_TRANSCRIPTION_PROFILE=adaptive to re-enable aggressive auto-tuning.
TRANSCRIPTION_PROFILE = (os.environ.get("HEED_TRANSCRIPTION_PROFILE", "stable") or "stable").strip().lower()
if TRANSCRIPTION_PROFILE not in {"stable", "adaptive"}:
    TRANSCRIPTION_PROFILE = "stable"

# --- Model loading (once, kept in memory) ---
whisper_model = None  # final transcription model
whisper_model_live = None  # live chunk model (lighter, for low-latency preview)
whisper_model_name = "small"
whisper_model_live_name = "small"
# RuntimeGovernor + the bits it needs to hot-swap the live model under contention.
live_governor = None
_devices = None
_warmup_path = None
# Per-engine LIVE cadence hint the Node server reads from /health. Parakeet (Apple Neural
# Engine, ~50ms per chunk) can poll fast with short windows → near-instant words on screen.
# Whisper engines keep the safe 3s/2000ms cadence so slow CPUs never starve mid-recording.
# Measured: Parakeet needs >=2s of audio to emit clean text (1s -> empty, 1.5s -> clipped).
live_tuning = {"chunk_s": 3.0, "interval_ms": 2000, "mode": "chunk"}
# Active transcription engine ("parakeet" | "mlx" | "ctranslate2"), set in load_models().
# Drives which languages the UI may offer (Parakeet = 28 European; Whisper = all).
active_engine = "ctranslate2"
whisper_runtime_info = {
    "final_model": "small",
    "live_model": "base",
    "device": "cpu",
    "quality": "very_good",
    "speed": "fast",
    "reason": "initializing",
}
pyannote_runtime_info = {
    "model": "pyannote/speaker-diarization-3.1",
    "device": "cpu",
    "profile": "balanced",
    "batch_size": 8,
    "reason": "initializing",
}
diarize_pipeline = None
# Which backend answers diarization: "pyannote" (Linux/CUDA/CPU) or "parakeet" (Apple
# Silicon, via the FluidAudio sidecar — no gated HF token). None = diarization off.
diarize_backend = None
models_ready = {"whisper": False, "pyannote": False}
models_warm = False  # True once the live ASR + diarization are pre-warmed (first record is instant)
load_error = None  # actionable message if model loading failed fatally — surfaced in /health so the UI
                   # and `doctor` can tell the user what to do instead of an eternal silent "ready:false".

# --- Live mic echo gate (Layer 1 of echo handling) ---
# When YOU aren't really talking, the mic only carries faint LEAKAGE of the system audio (measured
# ~28 dB below the source on an M5 with headphones). Parakeet is sensitive enough to transcribe that
# faint echo into your transcript. We gate the MIC channel: if a live chunk's RMS is below the speech
# floor, we DON'T feed it to the ASR (the system channel still transcribes the other voice cleanly).
# Calibrated on a real M5 recording: echo maxed at RMS 0.0148, the user's quiet speech started at
# 0.0201 — so 0.016 separates them with margin both ways. Tunable per setup.
# Default OFF: a 12-recording eval showed the energy gate cut the user's own quiet speech more than
# it removed echo (the text dedup, Layer 3, handles echo far better). Kept tunable for heavy-leak setups.
MIC_GATE_RMS = float(os.environ.get("HEED_MIC_GATE_RMS", "0"))  # absolute gate (off by default)
# Relative echo gate (default ON): gate the mic when the system is playing (sys RMS > active) AND
# the mic is echo-level relative to it (mic RMS < ratio * sys RMS). Stable, no transcript lag.
SYS_ACTIVE_RMS = float(os.environ.get("HEED_SYS_ACTIVE_RMS", "0.02"))
ECHO_GATE_RATIO = float(os.environ.get("HEED_ECHO_GATE_RATIO", "0.2"))  # conservative: only clear echo
_last_partial = {}  # channel -> last partial returned, so a gated tick keeps the text stable

# --- Live AEC (Layer 2 of echo handling): WebRTC AEC3 via the LiveKit SDK ---
# Cancels the SYSTEM channel (clean far-end reference) out of the MIC before transcription, so the
# other speaker's voice that leaks into the mic (speakers / non-isolating headphones, esp. during
# double-talk where the energy gate can't help) gets removed at the signal level. The APM is
# persistent so its adaptive filter converges across chunks; reset per recording on /stream/start.
_apm = None
_apm_ok = None  # None=untried, True=loaded, False=unavailable (graceful: AEC just off)

def _get_apm():
    global _apm, _apm_ok
    if _apm_ok is False:
        return None
    if _apm is None:
        try:
            from livekit import rtc
            _apm = rtc.AudioProcessingModule(
                echo_cancellation=True, noise_suppression=True,
                high_pass_filter=True, auto_gain_control=False,
            )
            _apm_ok = True
            print("[heed] AEC (WebRTC AEC3) armed for mic echo cancellation", flush=True)
        except Exception as e:
            _apm_ok = False
            print(f"[heed] AEC unavailable (echo cancellation off, gate still on): {str(e)[:80]}", flush=True)
            return None
    return _apm

def _reset_apm():
    global _apm
    _apm = None  # recreate fresh on the next recording so the filter starts clean

def _aec_clean(mic_path, ref_path):
    """Cancel the system reference out of the mic chunk (AEC3, 10 ms frames). Returns a cleaned
    temp WAV path, or the original mic_path if AEC is unavailable / fails (never breaks the feed)."""
    apm = _get_apm()
    if apm is None:
        return mic_path
    try:
        from livekit import rtc
        import numpy as _np, wave as _wave, tempfile as _tf
        def _load(p):
            with _wave.open(p) as wf:
                return _np.frombuffer(wf.readframes(wf.getnframes()), dtype=_np.int16)
        near = _load(mic_path); far = _load(ref_path)
        m = min(len(near), len(far))
        if m < 160:
            return mic_path
        near = near[:m].copy(); far = far[:m]
        FR = 160  # 10 ms @ 16 kHz
        for i in range(0, m - FR + 1, FR):
            apm.process_reverse_stream(rtc.AudioFrame(far[i:i+FR].tobytes(), 16000, 1, FR))
            nf = rtc.AudioFrame(near[i:i+FR].tobytes(), 16000, 1, FR)
            apm.process_stream(nf)
            near[i:i+FR] = _np.frombuffer(bytes(nf.data), dtype=_np.int16)
        tmp = _tf.mktemp(suffix=".wav")
        with _wave.open(tmp, "w") as wf:
            wf.setnchannels(1); wf.setsampwidth(2); wf.setframerate(16000)
            wf.writeframes(near.tobytes())
        return tmp
    except Exception as e:
        print(f"[heed] AEC chunk failed (passing mic through): {str(e)[:80]}", flush=True)
        return mic_path


def _wav_rms_peak(path):
    """RMS (0-1, normalized) and peak (int16) of a WAV. Cheap, subsampled."""
    try:
        import wave as _w, struct as _s
        with _w.open(path) as wf:
            fr = wf.readframes(wf.getnframes())
        n = len(fr) // 2
        if n == 0:
            return 0.0, 0
        smp = _s.unpack("<" + "h" * n, fr)
        step = max(1, n // 50000)
        sub = smp[::step]
        rms = (sum(x * x for x in sub) / len(sub)) ** 0.5 / 32768.0
        peak = max((abs(x) for x in sub), default=0)
        return rms, peak
    except Exception:
        return 0.0, 0


# --- Adaptive AEC (Task 2): only cancel when there's ACTUAL echo ---
# AEC3 slightly degrades the near-end voice even with no echo, so for users with isolating
# headphones (no leakage) we should NOT run it. We watch "listening" windows (system playing, mic
# below the speech floor) and estimate the leak ratio = mic_energy / system_energy there. If the mic
# picks up a real fraction of the system audio → echo present → keep AEC on; if the mic is ~silent
# when the system plays → no leak (clean headphones) → turn AEC off for the rest of the recording.
# Default ON until decided (never leak a foreign voice while we're still measuring).
AEC_MODE = os.environ.get("HEED_AEC_MODE", "off")  # off | always | adaptive — eval: off wins (AEC hurt voice in aggregate)
AEC_LEAK_RATIO = float(os.environ.get("HEED_AEC_LEAK_RATIO", "0.06"))
AEC_DECIDE_AFTER = int(os.environ.get("HEED_AEC_DECIDE_AFTER", "5"))
_echo = {"mic": 0.0, "sys": 0.0, "n": 0, "on": True}

def _reset_echo():
    global _echo
    _echo = {"mic": 0.0, "sys": 0.0, "n": 0, "on": True}

def _echo_observe_and_decide(raw_mic_rms, sys_rms):
    """Update the leak estimate from a listening window and (once enough seen) latch AEC on/off."""
    if sys_rms > 0.02 and raw_mic_rms < MIC_GATE_RMS:
        _echo["mic"] += raw_mic_rms
        _echo["sys"] += sys_rms
        _echo["n"] += 1
        if _echo["n"] == AEC_DECIDE_AFTER:
            ratio = _echo["mic"] / (_echo["sys"] + 1e-9)
            _echo["on"] = ratio > AEC_LEAK_RATIO
            print(f"[heed] AEC adaptive: leak ratio={ratio:.3f} -> AEC {'ON' if _echo['on'] else 'OFF (clean, no echo)'}", flush=True)
    return _echo["on"]


# --- Layer 3: cross-channel TEXT dedup (the winner, per the multi-sample eval) ---
# We always have the OTHER speaker's CLEAN transcript (the system channel). Any words in the MIC
# transcript that match it are residual echo → strip them. A rigorous 12-recording eval showed this
# removes the foreign echo (echo→0) while keeping ~0.78 of the user's own words — beating the signal
# gate + AEC, which hurt voice preservation in aggregate. Operates purely on text (no audio damage).
import re as _re_dd
from difflib import SequenceMatcher as _SM
_DD_STOP = set("de la el en y a que los las un una por con para se su lo le del al es e o u me mi tu".split())

def _dd_words(t):
    return [w for w in _re_dd.findall(r"[a-záéíóúñü0-9']+", (t or "").lower()) if w]

def _dd_index(grams):
    idx = {}
    for g in grams:
        for w in g:
            if w not in _DD_STOP:
                idx.setdefault(w, []).append(g)
    return idx

def _dd_match(g, idx, thr):
    seen = set(); gs = " ".join(g)
    for w in g:
        if w in _DD_STOP:
            continue
        for cg in idx.get(w, ()):
            if cg in seen:
                continue
            seen.add(cg)
            if _SM(None, gs, " ".join(cg)).ratio() >= thr:
                return True
    return False

DEDUP_THR = float(os.environ.get("HEED_DEDUP_THR", "0.63"))

def dedup_echo(mic_txt, sys_txt, thr=None):
    """Remove from mic_txt any 3-word run that matches the system (other speaker) transcript."""
    thr = DEDUP_THR if thr is None else thr
    mw = _dd_words(mic_txt)
    if len(mw) < 3 or not (sys_txt or "").strip():
        return mic_txt
    sg = [tuple(_dd_words(sys_txt)[i:i+3]) for i in range(len(_dd_words(sys_txt)) - 2)]
    idx = _dd_index(sg)
    flag = [False] * len(mw)
    for i in range(len(mw) - 2):
        if _dd_match(tuple(mw[i:i+3]), idx, thr):
            flag[i] = flag[i+1] = flag[i+2] = True
    return " ".join(w for w, f in zip(mw, flag) if not f)


# --- Ollama model catalog ---
# Curated list of LLMs we recommend for meeting note generation.
# `vram_mb` is the model footprint when loaded on GPU. We use this to filter
# what's actually safe to run alongside pyannote on the user's hardware.
#
# Sources / sizing:
#   - Llama 3.2: ai.meta.com/blog/llama-3-2 (Sept 2024)
#   - Qwen 2.5:  qwenlm.github.io/blog/qwen2.5 (Sept 2024)
#   - Gemma 3:   blog.google (March 2025)
#   - Gemma 4:   blog.google (April 2026), Apache 2.0, multimodal, 256K ctx
PYANNOTE_RESERVE_MB = 1500   # pyannote 3.1 model + clustering tensors (Linux/CUDA only)
SAFETY_MARGIN_MB = 500       # transient PyTorch allocator overhead
# Apple Silicon has unified memory (no separate VRAM) and diarizes with FluidAudio on the ANE
# (not pyannote), so the pyannote reserve does NOT apply. We only hold back headroom for the OS +
# browser + heed's own ANE model working set, per the "use ~70-80%, leave 20-30% ceiling" target.
MAC_HEADROOM_RESERVE_MB = 3000
# The DEFAULT recommendation on Mac stays deliberately conservative: pick the best model that fits in
# roughly half of unified memory, so a live meeting (Zoom + browser + heed on the ANE) never swaps.
# The user can still choose a bigger model — this only bounds the auto-suggested default.
MAC_DEFAULT_BUDGET_FRACTION = 0.5

MODEL_CATALOG = [
    # --- Llama family (Meta) ---
    {
        "id": "llama3.2:1b", "name": "Llama 3.2 1B", "vendor": "Meta",
        "size_mb": 1300, "vram_mb": 800,
        "quality": "good", "speed": "very_fast",
        "description": "Tiny, fast, runs on almost any GPU. Good for short meetings.",
    },
    {
        "id": "llama3.2:3b", "name": "Llama 3.2 3B", "vendor": "Meta",
        "size_mb": 2000, "vram_mb": 2400,
        "quality": "very_good", "speed": "fast",
        "description": "Sweet spot for quality on mid-range GPUs.",
    },
    {
        "id": "llama3.3:70b", "name": "Llama 3.3 70B", "vendor": "Meta",
        "size_mb": 40000, "vram_mb": 42000,
        "quality": "best", "speed": "slow",
        "description": "Frontier-level quality. Needs serious VRAM (A100/H100 or 2x 4090).",
    },
    # --- Qwen family (Alibaba) ---
    {
        "id": "qwen2.5:1.5b", "name": "Qwen 2.5 1.5B", "vendor": "Alibaba",
        "size_mb": 990, "vram_mb": 1100,
        "quality": "very_good", "speed": "fast",
        "description": "Punches above its weight. Great multilingual.",
    },
    {
        "id": "qwen2.5:7b", "name": "Qwen 2.5 7B", "vendor": "Alibaba",
        "size_mb": 4400, "vram_mb": 4500,
        "quality": "very_good", "speed": "fast",
        "description": "Solid all-rounder for mid GPUs.",
    },
    {
        "id": "qwen2.5:14b", "name": "Qwen 2.5 14B", "vendor": "Alibaba",
        "size_mb": 8800, "vram_mb": 9000,
        "quality": "excellent", "speed": "fast",
        "description": "High quality, fits 12GB+ GPUs.",
    },
    {
        "id": "qwen2.5:32b", "name": "Qwen 2.5 32B", "vendor": "Alibaba",
        "size_mb": 18500, "vram_mb": 19000,
        "quality": "excellent", "speed": "medium",
        "description": "Top-tier reasoning. Needs 24GB+.",
    },
    # --- Gemma 3 (Google) ---
    {
        "id": "gemma3:1b", "name": "Gemma 3 1B", "vendor": "Google",
        "size_mb": 815, "vram_mb": 850,
        "quality": "good", "speed": "fast",
        "description": "Compact and efficient.",
    },
    {
        "id": "gemma3:12b", "name": "Gemma 3 12B", "vendor": "Google",
        "size_mb": 7800, "vram_mb": 8000,
        "quality": "excellent", "speed": "fast",
        "description": "Excellent quality at moderate VRAM.",
    },
    {
        "id": "gemma3:27b", "name": "Gemma 3 27B", "vendor": "Google",
        "size_mb": 16600, "vram_mb": 17000,
        "quality": "excellent", "speed": "fast",
        "description": "Heavy-weight Gemma. 18GB+ VRAM.",
    },
    # --- Gemma 4 (Google, NEW April 2026) ---
    {
        "id": "gemma4:e2b", "name": "Gemma 4 E2B", "vendor": "Google",
        "size_mb": 7200, "vram_mb": 4000,
        "quality": "very_good", "speed": "fast",
        "new": True,
        "description": "NEW. Multimodal, 256K context. Effective 2B params, 4GB VRAM.",
    },
    {
        "id": "gemma4:e4b", "name": "Gemma 4 E4B", "vendor": "Google",
        "size_mb": 9600, "vram_mb": 6000,
        "quality": "excellent", "speed": "fast",
        "new": True,
        "description": "NEW. Default Gemma 4. Best quality at 6GB.",
    },
    {
        "id": "gemma4:26b-a4b", "name": "Gemma 4 26B MoE", "vendor": "Google",
        "size_mb": 18000, "vram_mb": 18000,
        "quality": "excellent", "speed": "fast",
        "new": True,
        "description": "NEW. Mixture of Experts. #6 worldwide on Arena.",
    },
    {
        "id": "gemma4:31b", "name": "Gemma 4 31B", "vendor": "Google",
        "size_mb": 20000, "vram_mb": 20000,
        "quality": "best", "speed": "medium",
        "new": True,
        "description": "NEW. Dense 31B. #3 worldwide open model on Arena.",
    },
]


def model_fits_gpu(model, free_vram_mb, pyannote_reserve=PYANNOTE_RESERVE_MB):
    """A model is GPU-safe if loading it leaves enough memory for the diarizer + safety margin.

    On Linux/CUDA, pyannote shares the GPU so we reserve PYANNOTE_RESERVE_MB. On Apple Silicon the
    diarizer is FluidAudio on the ANE (negligible unified-memory cost) → caller passes pyannote_reserve=0.
    """
    needed = model["vram_mb"] + pyannote_reserve + SAFETY_MARGIN_MB
    return free_vram_mb >= needed


def pick_default_model(free_vram_mb, pyannote_reserve=PYANNOTE_RESERVE_MB):
    """Pick the highest-quality model that fits the GPU.

    Tie-break: respect catalog order (Llama before Qwen before Gemma) so the picker
    is deterministic and the user-requested default (llama3.2:1b for low-VRAM GPUs)
    is honored. Falls back to the smallest LLM if nothing fits.
    """
    quality_rank = {"good": 1, "very_good": 2, "excellent": 3, "best": 4}
    fitting = [(i, m) for i, m in enumerate(MODEL_CATALOG) if model_fits_gpu(m, free_vram_mb, pyannote_reserve)]
    if fitting:
        # Highest quality desc, then earliest in catalog asc
        fitting.sort(key=lambda x: (-quality_rank.get(x[1].get("quality"), 0), x[0]))
        return fitting[0][1]
    # Nothing fits on GPU → smallest model (will run on CPU)
    cpu_fallback = sorted(MODEL_CATALOG, key=lambda m: m["vram_mb"])
    return cpu_fallback[0] if cpu_fallback else None


def _apple_chip_name():
    """Best-effort Apple Silicon chip label, e.g. 'Apple M5'. Falls back to 'Apple Silicon'."""
    try:
        import subprocess
        out = subprocess.run(
            ["sysctl", "-n", "machdep.cpu.brand_string"],
            capture_output=True, text=True, timeout=2,
        )
        name = (out.stdout or "").strip()
        if name:
            return name
    except Exception:
        pass
    return "Apple Silicon"


def apple_unified_memory_info():
    """Single source of truth for Apple Silicon 'GPU' memory (unified RAM).

    BOTH get_hardware_info() (the AI-notes model picker / GPU-fit warning) and get_device_config()
    (transcription device placement) read THIS, so the two can never again disagree about the same
    chip — which was exactly the bug that made a 16GB M5 report "doesn't fit in your GPU".
    """
    ram_mb = get_system_ram_mb()
    return {
        "gpu_name": _apple_chip_name(),
        "total_vram_mb": ram_mb,  # unified memory
        # Stable budget: total minus OS/browser/ANE-working-set headroom. No transient "free VRAM"
        # concept on unified memory (nothing hogs a separate pool the way Steam/Chrome hog CUDA VRAM).
        "free_vram_mb": max(0, ram_mb - MAC_HEADROOM_RESERVE_MB),
    }


def get_hardware_info():
    """Return current hardware capabilities + which models are GPU-compatible.

    Frontend uses this to render the model picker + the AI-notes GPU/CPU warning. On Apple Silicon
    "GPU" means Metal over unified memory (Ollama) and the diarizer is FluidAudio on the ANE, so the
    CUDA probe below never applies — the Apple branch fills the same fields from unified RAM instead.
    """
    info = {
        "gpu_available": False,
        "gpu_name": None,
        "total_vram_mb": 0,
        "free_vram_mb": 0,
        "pyannote_reserve_mb": PYANNOTE_RESERVE_MB,
        "safety_margin_mb": SAFETY_MARGIN_MB,
        "tier": "cpu_only",
        "default_model": None,
        "models": [],
    }
    # How much memory to hold back for the diarizer when deciding if an LLM fits (0 on Mac — FluidAudio
    # runs on the ANE, not in the unified-memory pool Ollama draws from).
    pyannote_reserve = PYANNOTE_RESERVE_MB

    # Apple Silicon: detect WITHOUT importing torch (a Mac-lite install has none). Must precede the
    # `import torch` CUDA probe, and mirrors get_device_config()'s torchless Apple branch.
    try:
        import engines
        _apple = engines.is_apple_silicon()
    except Exception:
        _apple = False

    if _apple:
        mem = apple_unified_memory_info()  # shared with get_device_config — single source of truth
        info["gpu_available"] = True
        info["gpu_name"] = mem["gpu_name"]
        info["total_vram_mb"] = mem["total_vram_mb"]
        info["free_vram_mb"] = mem["free_vram_mb"]
        info["pyannote_reserve_mb"] = 0
        pyannote_reserve = 0
        print(f"[heed] Apple Silicon hardware: {info['gpu_name']} ({info['total_vram_mb']}MB unified)", flush=True)
    else:
        try:
            import torch
            if torch.cuda.is_available():
                free_b, total_b = torch.cuda.mem_get_info(0)
                info["gpu_available"] = True
                info["gpu_name"] = torch.cuda.get_device_name(0)
                info["total_vram_mb"] = int(total_b // 1024 // 1024)
                info["free_vram_mb"] = int(free_b // 1024 // 1024)
        except Exception as e:
            print(f"[heed] hardware probe failed: {e}", flush=True)

    # Tier classifies the HARDWARE (use total VRAM), not current state.
    # Free VRAM is what we use to filter individual models below.
    total = info["total_vram_mb"]
    free = info["free_vram_mb"]
    if total >= 22000:
        info["tier"] = "ultra"
    elif total >= 14000:
        info["tier"] = "high"
    elif total >= 7000:
        info["tier"] = "mid"
    elif total >= 3000:
        info["tier"] = "low"
    else:
        info["tier"] = "cpu_only"

    # `gpu_compatible` is a property of the HARDWARE, not the current memory state.
    # We compute it against TOTAL VRAM so the answer is stable across reboots and
    # whatever Chrome / Steam / random GPU consumer is running.
    #
    # `gpu_runtime_ok` reflects what actually fits RIGHT NOW (free VRAM). The UI
    # uses this to warn the user if they need to free memory before installing a
    # large model — but it does NOT use it to hide models from the catalog.
    for m in MODEL_CATALOG:
        gpu_ok = info["gpu_available"] and model_fits_gpu(m, total, pyannote_reserve)
        runtime_ok = info["gpu_available"] and model_fits_gpu(m, free, pyannote_reserve)
        info["models"].append({
            **m,
            "gpu_compatible": gpu_ok,
            "gpu_runtime_ok": runtime_ok,
            "recommended_runtime": "gpu" if gpu_ok else "cpu",
        })

    # Default model is picked against FREE VRAM — the one that works RIGHT NOW.
    # If we recommend a model that doesn't fit free VRAM, the user downloads it,
    # Ollama loads it, steals VRAM from pyannote, and everything OOMs.
    # The catalog still uses TOTAL (so we don't hide models), but "recommended"
    # must be something that runs on first click without closing anything.
    #
    # On Mac, unified memory is shared LIVE with the meeting apps (Zoom/browser), so the auto-suggested
    # default stays in ~half of RAM — a comfortable sweet-spot, not the biggest model that fits. The
    # user can always pick a bigger one; `gpu_runtime_ok` above still permits it.
    default_budget = int(total * MAC_DEFAULT_BUDGET_FRACTION) if _apple else free
    default = pick_default_model(default_budget, pyannote_reserve)
    info["default_model"] = default["id"] if default else None
    return info


def get_device_config():
    """Auto-detect hardware and decide where each model runs.

    Strategy is based on FREE VRAM at startup, not total — because Ollama or other
    GPU consumers may be hogging memory. We need >=1.5GB free to safely run pyannote
    inference (model + temp tensors during clustering).

    - >=6GB free: both on GPU
    - 1.5-6GB free: pyannote on GPU (it benefits more), whisper on CPU
    - <1.5GB free: both on CPU
    - No CUDA: both on CPU
    """
    cpu_count = os.cpu_count() or 0
    ram_mb = get_system_ram_mb()

    # Apple Silicon: detect WITHOUT importing torch. On Mac the engine is Parakeet/FluidAudio running on
    # the ANE via the Swift sidecar — torch is only a Linux/CPU-fallback dep, and a Mac-lite install has
    # NO torch. This branch MUST come before `import torch` or a torchless Mac crashes at boot.
    try:
        import engines
        _apple = engines.is_apple_silicon()
    except Exception:
        _apple = False
    if _apple:
        mem = apple_unified_memory_info()  # shared with get_hardware_info — single source of truth
        print(f"[heed] Apple Silicon detected: {mem['gpu_name']} ({cpu_count} cores, {ram_mb}MB RAM)", flush=True)
        print("[heed] Strategy: diarization on Metal/ANE (FluidAudio), whisper fallback on CPU", flush=True)
        return {
            "whisper": "cpu",  # faster-whisper (fallback) uses CTranslate2, not PyTorch — CPU is fastest
            "pyannote": "mps",  # placeholder; on Mac-parakeet pyannote is never loaded (FluidAudio diarizes)
            "gpu_available": True,
            "gpu_name": mem["gpu_name"],
            "total_vram_mb": mem["total_vram_mb"],  # unified memory
            "free_vram_mb": mem["free_vram_mb"],
            "cpu_count": cpu_count,
            "ram_mb": ram_mb,
        }

    # non-Apple (Linux/Windows): torch is needed to probe CUDA. Torchless → all CPU (never crash).
    try:
        import torch
    except Exception:
        print(f"[heed] torch unavailable — CPU for all models ({cpu_count} cores, {ram_mb}MB RAM)", flush=True)
        return {
            "whisper": "cpu", "pyannote": "cpu", "gpu_available": False, "gpu_name": None,
            "free_vram_mb": 0, "total_vram_mb": 0, "cpu_count": cpu_count, "ram_mb": ram_mb,
        }

    if not torch.cuda.is_available():
        print(f"[heed] No CUDA — using CPU for all models ({cpu_count} cores, {ram_mb}MB RAM)", flush=True)
        return {
            "whisper": "cpu",
            "pyannote": "cpu",
            "gpu_available": False,
            "gpu_name": None,
            "free_vram_mb": 0,
            "total_vram_mb": 0,
            "cpu_count": cpu_count,
            "ram_mb": ram_mb,
        }

    free_bytes, total_bytes = torch.cuda.mem_get_info(0)
    free_mb = free_bytes // 1024 // 1024
    total_mb = total_bytes // 1024 // 1024
    gpu_name = torch.cuda.get_device_name(0)
    print(f"[heed] GPU: {gpu_name} ({total_mb}MB total, {free_mb}MB free)", flush=True)

    if free_mb >= 6000:
        print("[heed] Strategy: both models on GPU", flush=True)
        return {
            "whisper": "cuda",
            "pyannote": "cuda",
            "gpu_available": True,
            "gpu_name": gpu_name,
            "free_vram_mb": int(free_mb),
            "total_vram_mb": int(total_mb),
            "cpu_count": cpu_count,
            "ram_mb": ram_mb,
        }
    elif free_mb >= 1500:
        # Pyannote benefits MORE from GPU than whisper (25s→5s vs 9s→5s)
        print(f"[heed] Strategy: pyannote on GPU, whisper on CPU ({free_mb}MB free)", flush=True)
        return {
            "whisper": "cpu",
            "pyannote": "cuda",
            "gpu_available": True,
            "gpu_name": gpu_name,
            "free_vram_mb": int(free_mb),
            "total_vram_mb": int(total_mb),
            "cpu_count": cpu_count,
            "ram_mb": ram_mb,
        }
    else:
        print(f"[heed] Strategy: both on CPU (only {free_mb}MB free, need >=1500MB for pyannote on GPU)", flush=True)
        return {
            "whisper": "cpu",
            "pyannote": "cpu",
            "gpu_available": True,
            "gpu_name": gpu_name,
            "free_vram_mb": int(free_mb),
            "total_vram_mb": int(total_mb),
            "cpu_count": cpu_count,
            "ram_mb": ram_mb,
        }


def get_system_ram_mb():
    """Best-effort total system RAM (MB) without external deps like psutil."""
    try:
        page_size = os.sysconf("SC_PAGE_SIZE")
        phys_pages = os.sysconf("SC_PHYS_PAGES")
        if page_size and phys_pages:
            return int((page_size * phys_pages) // 1024 // 1024)
    except Exception:
        pass
    return 0


def pick_whisper_models(device_cfg):
    """Auto-select whisper model based on hardware power.

    Progressive scaling — starts at base, goes up with hardware:
      base    → entry level (laptop, 4-8GB RAM, weak CPU)
      small   → mid range (12+ cores, 12-16GB RAM, or any GPU)  ← your GTX 1650
      medium  → high end (16+ cores, 24GB+ RAM, or 8GB+ VRAM)
      large-v3→ ultra (24+ cores, 32GB+ RAM, or 16GB+ VRAM)

    Live and final ALWAYS use the same model (same quality, shared instance).
    """
    cpu_count = int(device_cfg.get("cpu_count", os.cpu_count() or 0) or 0)
    ram_mb = int(device_cfg.get("ram_mb", get_system_ram_mb()) or 0)
    whisper_device = device_cfg.get("whisper", "cpu")
    free_vram = int(device_cfg.get("free_vram_mb", 0) or 0)

    # Whisper accuracy tiers (ascending). Footprint ≈ runtime memory in MB. `large-v3` is the
    # 4-bit MLX build (measured: same accuracy as fp16, ~1.5x faster, ~1/3 the memory).
    TIERS = ["base", "small", "medium", "large-v3"]
    TIER_MEM_MB = {"base": 200, "small": 600, "medium": 1600, "large-v3": 1200}

    model = "base"
    gpu_fast = whisper_device == "cuda" or "Apple Silicon" in str(device_cfg.get("gpu_name", ""))

    if gpu_fast:
        # On a fast accelerator (Apple GPU via MLX, or NVIDIA/CUDA) bigger models run in a
        # fraction of real time, so we pick the LARGEST tier that fits the memory headroom —
        # giving each machine its best accuracy. "Marvel on any hardware" = best that fits,
        # never a fixed model.
        total_mem = int(device_cfg.get("total_vram_mb", 0) or 0) or ram_mb  # VRAM (CUDA) or unified RAM (Apple)
        # Headroom budget for the FINAL model: leave room for pyannote (~1.5GB), the live model,
        # Ollama and the OS so we never push past ~80% and collapse the machine.
        budget = max(0, int(free_vram) - 1800)
        # Hard cap by total-memory class so low-RAM machines don't over-reach.
        if total_mem >= 16000:
            cap = "large-v3"
        elif total_mem >= 11000:
            cap = "medium"
        elif total_mem >= 7000:
            cap = "small"
        else:
            cap = "base"
        cap_i = TIERS.index(cap)
        for i, tier in enumerate(TIERS):
            if i <= cap_i and TIER_MEM_MB[tier] <= budget:
                model = tier
        reason = f"{model} (GPU-fast, {total_mem}MB mem, {budget}MB budget, cap={cap})"
    else:
        # CPU-only: large models can't keep up in real time — scale conservatively by cores+RAM.
        if cpu_count >= 24 and ram_mb >= 32000:
            model, reason = "large-v3", f"large-v3 (CPU ultra, {cpu_count} cores, {ram_mb}MB RAM)"
        elif cpu_count >= 16 and ram_mb >= 24000:
            model, reason = "medium", f"medium (CPU high, {cpu_count} cores, {ram_mb}MB RAM)"
        elif cpu_count >= 8 and ram_mb >= 12000:
            model, reason = "small", f"small (CPU mid, {cpu_count} cores, {ram_mb}MB RAM)"
        else:
            model, reason = "base", f"base (CPU entry, {cpu_count} cores, {ram_mb}MB RAM)"

    # LIVE preview model: cap at `small` on GPU. `medium`/`large` for live regressed latency
    # badly during active recording (GPU/CPU contention with the recorder), and `small` is
    # already accurate + fast (~0.3s/chunk). The final pass uses the big `model` for accuracy.
    if gpu_fast:
        live_model = model if model in ("tiny", "base", "small") else "small"
    else:
        live_model = model if model in ("tiny", "base") else "base"

    return {
        "final": model,
        "live": live_model,
        "reason": reason,
    }


def pick_pyannote_tuning(device_cfg):
    """Pick pyannote tuning profile.

    Stable profile (default): conservative known-good batch size.
    Adaptive profile (opt-in): scales aggressively with hardware.
    """
    device = device_cfg.get("pyannote", "cpu")
    free_mb = int(device_cfg.get("free_vram_mb", 0) or 0)
    cpu_count = int(device_cfg.get("cpu_count", os.cpu_count() or 0) or 0)
    ram_mb = int(device_cfg.get("ram_mb", get_system_ram_mb()) or 0)

    if TRANSCRIPTION_PROFILE != "adaptive":
        return {
            "device": device,
            "profile": "stable",
            "batch_size": 8,
            "reason": "stable profile (known-good, conservative batch=8)",
        }

    if device == "cuda":
        if free_mb >= 14000:
            return {
                "device": "cuda",
                "profile": "max",
                "batch_size": 32,
                "reason": f"high free VRAM ({free_mb}MB)",
            }
        if free_mb >= 9000:
            return {
                "device": "cuda",
                "profile": "high",
                "batch_size": 24,
                "reason": f"mid-high free VRAM ({free_mb}MB)",
            }
        if free_mb >= 5000:
            return {
                "device": "cuda",
                "profile": "balanced",
                "batch_size": 16,
                "reason": f"mid free VRAM ({free_mb}MB)",
            }
        if free_mb >= 2500:
            return {
                "device": "cuda",
                "profile": "safe",
                "batch_size": 10,
                "reason": f"low free VRAM ({free_mb}MB)",
            }
        return {
            "device": "cuda",
            "profile": "minimum",
            "batch_size": 8,
            "reason": f"very low free VRAM ({free_mb}MB)",
        }

    cpu_threads = max(2, min(16, cpu_count))
    if cpu_count >= 16 and ram_mb >= 24000:
        return {
            "device": "cpu",
            "profile": "cpu-max",
            "batch_size": 12,
            "cpu_threads": cpu_threads,
            "reason": f"strong CPU ({cpu_count} cores, {ram_mb}MB RAM)",
        }
    return {
        "device": "cpu",
        "profile": "cpu-balanced",
        "batch_size": 8,
        "cpu_threads": max(2, min(12, cpu_threads)),
        "reason": f"standard CPU ({cpu_count} cores, {ram_mb}MB RAM)",
    }


_WHISPER_FALLBACK_ORDER = ["large-v3", "medium", "small", "base", "tiny"]


def _load_whisper_with_fallback(model_name, devices, warmup_path, label="whisper"):
    """Load `model_name`; if it fails (OOM, missing download, etc.) step DOWN through smaller
    tiers until one loads. The warm-up transcribe doubles as a load/compile validation. Returns
    (engine, actual_model_name) and never hard-fails unless EVERY tier fails."""
    import engines
    start = _WHISPER_FALLBACK_ORDER.index(model_name) if model_name in _WHISPER_FALLBACK_ORDER else _WHISPER_FALLBACK_ORDER.index("small")
    for name in _WHISPER_FALLBACK_ORDER[start:]:
        try:
            eng = engines.make_engine(name, devices)
            list(eng.transcribe(warmup_path, language="en")[0])  # validates real load + compile
            if name != model_name:
                print(f"[heed] {label}: '{model_name}' unavailable — degraded to '{name}'", flush=True)
            return eng, name
        except Exception as e:
            print(f"[heed] {label}: '{name}' failed to load ({str(e)[:80]}); stepping down...", flush=True)
    raise RuntimeError(f"{label}: no whisper model could be loaded")


def _swap_live_model(new_model):
    """Hot-swap the live preview model when the governor decides to degrade/recover.
    Loads + warms the new model OUTSIDE the transcribe lock, then swaps the reference under it."""
    global whisper_model_live, whisper_model_live_name
    try:
        eng, name = _load_whisper_with_fallback(new_model, _devices, _warmup_path, "live-swap")
        with whisper_live_lock:
            whisper_model_live = eng
            whisper_model_live_name = name
        print(f"[heed] Governor: live model -> {name}", flush=True)
        return True
    except Exception as e:
        print(f"[heed] Governor: live swap failed ({str(e)[:80]})", flush=True)
        return False


def load_models():
    global whisper_model, whisper_model_live, diarize_pipeline, whisper_model_name, whisper_model_live_name, whisper_runtime_info, pyannote_runtime_info, diarize_backend
    global live_governor, _devices, _warmup_path, live_tuning, active_engine, models_warm

    try:
        devices = get_device_config()
    except Exception as e:
        print(f"[heed] device detection failed ({str(e)[:60]}) — CPU defaults", flush=True)
        devices = {"whisper": "cpu", "pyannote": "cpu", "gpu_available": False, "gpu_name": None,
                   "free_vram_mb": 0, "total_vram_mb": 0, "cpu_count": os.cpu_count() or 0,
                   "ram_mb": get_system_ram_mb()}
    _devices = devices
    print(f"[heed] Transcription profile: {TRANSCRIPTION_PROFILE}", flush=True)

    # --- Hardware-aware model selection: CapabilityProbe -> ModelPolicy -> verify-the-pick.
    # If anything in the new path fails, fall back to the legacy conservative picker so heed
    # NEVER hard-fails at startup (first robustness guarantee).
    try:
        import capability, policy
        caps = capability.probe(log=lambda m: print(m, flush=True))
        plan = policy.decide(caps, measure_final_rtf=capability.measure_model_rtf)
        whisper_model_name = plan.final_model
        whisper_model_live_name = plan.live_model
        pick_reason = plan.reason
    except Exception as e:
        print(f"[heed] Capability probe failed ({e}) — using legacy picker", flush=True)
        whisper_pick = pick_whisper_models(devices)
        whisper_model_name = whisper_pick["final"]
        whisper_model_live_name = whisper_pick["live"]
        pick_reason = whisper_pick["reason"]
    whisper_quality = "very_good"
    whisper_speed = "fast"
    if whisper_model_name == "medium":
        whisper_quality = "excellent"
        whisper_speed = "medium"
    elif whisper_model_name == "large-v3":
        whisper_quality = "best"
        whisper_speed = "slower"
    whisper_runtime_info = {
        "final_model": whisper_model_name,
        "live_model": whisper_model_live_name,
        "device": devices.get("whisper", "cpu"),
        "quality": whisper_quality,
        "speed": whisper_speed,
        "reason": pick_reason,
    }
    print(
        f"[heed] Whisper auto-pick: final={whisper_model_name}, live={whisper_model_live_name} ({pick_reason})",
        flush=True,
    )

    # --- Whisper engine (hardware-aware: MLX on Apple Silicon, CTranslate2 on CUDA/CPU) ---
    import engines
    engine_kind = engines.select_engine_kind(devices)
    active_engine = engine_kind
    print(f"[heed] Whisper engine: {engine_kind} (final={whisper_model_name}, live={whisper_model_live_name})", flush=True)

    # Build the silent warm-up clip once; it validates each model actually loads.
    _warmup_path = os.path.join(os.path.dirname(__file__), "_warmup.wav")
    try:
        import struct, wave
        with wave.open(_warmup_path, "w") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(16000)
            wf.writeframes(struct.pack("<" + "h" * 8000, *([0] * 8000)))
    except Exception:
        pass

    t = time.time()
    # On Apple Silicon the ENGINE is Parakeet (ANE) for both live and post-stop — Whisper is only ever
    # touched by the file-upload path (/api/transcribe → /process-stream) and the non-parakeet live
    # chunk mode. So DON'T load Whisper at boot on parakeet: it wasted ~1-3GB of RAM and slowed the
    # cold-start. It lazy-loads on first file upload via _ensure_whisper(). (Linux/CPU: unchanged.)
    if engine_kind != "parakeet":
        whisper_model, whisper_model_name = _load_whisper_with_fallback(whisper_model_name, devices, _warmup_path, "final")
        models_ready["whisper"] = True
        print(f"[heed] Whisper final={whisper_model_name} ready in {time.time()-t:.1f}s ({engine_kind})", flush=True)
        # Live preview: a SEPARATE, lighter model for low latency. Reuse the final instance if they
        # ended up the same name (saves memory). Live also degrades gracefully on its own.
        if whisper_model_live_name and whisper_model_live_name != whisper_model_name:
            t_live = time.time()
            print(f"[heed] Loading live whisper {whisper_model_live_name} ({engine_kind})...", flush=True)
            whisper_model_live, whisper_model_live_name = _load_whisper_with_fallback(whisper_model_live_name, devices, _warmup_path, "live")
            print(f"[heed] Whisper live={whisper_model_live_name} ready in {time.time()-t_live:.1f}s", flush=True)
        else:
            whisper_model_live = whisper_model
            whisper_model_live_name = whisper_model_name
            print(f"[heed] Whisper live = final (same {whisper_model_live_name} instance, saves RAM)", flush=True)
    else:
        models_ready["whisper"] = True  # parakeet handles transcription; whisper lazy-loads if needed
        print(f"[heed] Whisper NOT loaded at boot (engine=parakeet) — lazy on file-upload only, frees ~1-3GB RAM", flush=True)

    # Arm the RuntimeGovernor for the live preview: it self-corrects the live model under
    # recording-time contention (the 8-15s regression). Ceiling = the policy's live pick so it
    # never upgrades past what the hardware was judged able to run.
    try:
        from governor import RuntimeGovernor
        live_governor = RuntimeGovernor(start_model=whisper_model_live_name,
                                        ceiling=whisper_model_live_name, floor="tiny")
        print(f"[heed] Live governor armed (start={whisper_model_live_name}, floor=tiny)", flush=True)
    except Exception as e:
        live_governor = None
        print(f"[heed] Live governor unavailable (non-critical): {e}", flush=True)

    # Live strategy, per engine:
    #  - "full" (Parakeet/MLX, fast): RE-TRANSCRIBE the whole growing audio each tick and REPLACE
    #    the on-screen text. Full context = accurate (no word-cutting), and it's affordable because
    #    Parakeet does 30s in ~0.3s. This is the killer live UX Whisper-on-CPU could never do.
    #  - "chunk" (CTranslate2/CPU, slow): keep stitching short 3s chunks — re-transcribing the whole
    #    file each tick would be far too slow on CPU. Safe, proven path.
    if engine_kind == "parakeet":
        # "stream": true real-time. The sidecar runs a streaming ASR session (Nemotron
        # multilingual); heed feeds only the NEW audio each tick and shows the model's
        # append-only partial (confirmed prefix never re-renders). ~25-50ms/chunk.
        live_tuning = {"chunk_s": 1.0, "interval_ms": 700, "mode": "stream"}
    elif engine_kind == "mlx":
        live_tuning = {"chunk_s": 2.0, "interval_ms": 700, "mode": "full"}
    else:
        live_tuning = {"chunk_s": 3.0, "interval_ms": 2000, "mode": "chunk"}
    print(f"[heed] Live: mode={live_tuning['mode']} interval={live_tuning['interval_ms']}ms ({engine_kind})", flush=True)

    # Pre-warm the live models in the BACKGROUND so the FIRST recording is instant (no cold-start
    # stall). Warms THREE things that previously lazy-loaded on the first record:
    #   - streaming ASR on BOTH channels (dual records use mic+sys): "en" loads the shared 'latin'
    #     variant that also covers es/fr/it/pt/de (most users);
    #   - the streaming DIARIZATION model (Sortformer) — this was the main culprit: it lazy-loaded
    #     on the first diar-start, so diarization took several seconds the first time only;
    # and exercises the first ANE inference compile with a tiny silent clip.
    # Non-blocking: the server is ready immediately; the warm finishes within seconds of boot. If
    # the user records before it finishes, the lazy path still works (just the old cold-start).
    if engine_kind == "parakeet":
        # Warm with a REAL-VOICE clip (not silence): silence skips the ANE kernels that real mel
        # features exercise, so the first real inference still paid a compile cost (part of the ~10s
        # cold-start). A 2s speech clip compiles the same path the first record hits → first text <1s.
        _voice_clip = os.path.join(os.path.dirname(__file__), "_warmup_voice.wav")
        warm_clip = _voice_clip if os.path.exists(_voice_clip) else _warmup_path
        def _prewarm_stream():
            global models_warm
            try:
                asr = engines.get_parakeet()            # ASR sidecar (ANE)
                have_clip = bool(warm_clip) and os.path.exists(warm_clip)
                for ch in ("mic", "sys"):
                    asr.stream_start("en", ch)
                    if have_clip:
                        asr.stream_feed(warm_clip, ch)
                    asr.stream_finish(ch)
                # Warm the DEDICATED diarization sidecar (GPU) — the live /diar/live path is the offline
                # `diarize`. Runs in parallel with ASR so warming it doesn't stall the ASR warm.
                try:
                    diar = engines.get_parakeet_diar()
                    if have_clip:
                        diar.diarize(warm_clip)
                except Exception:
                    pass
                models_warm = True
                print("[heed] Live models pre-warmed (ASR sidecar + diarization sidecar) — first record is instant", flush=True)
            except Exception as e:
                models_warm = True  # don't block recording forever if warm fails
                print(f"[heed] Stream pre-warm skipped: {str(e)[:80]}", flush=True)
        # SYNCHRONOUS: load_models (itself a background thread) doesn't report fully done until the
        # warm finishes, and /health exposes `warm`. The recorder waits for `warm` before starting
        # so the FIRST record never contends with the warm-up (the old cold-start). The Sortformer
        # model load (~the cost) happens here, once, up front.
        _prewarm_stream()
    else:
        models_warm = True  # non-parakeet engines have no streaming pre-warm gate

    # Now safe to go offline for pyannote
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"

    # --- Diarization backend selection ---
    # On Apple Silicon, the Parakeet sidecar ALSO loads FluidAudio speaker diarization (CoreML,
    # downloaded from a PUBLIC HF repo — NO gated token). Prefer it: zero-friction install, no
    # pyannote/torch token wall. Everywhere else (Linux/CUDA/CPU) keep pyannote unchanged.
    if engine_kind == "parakeet" and engines.parakeet_available():
        try:
            t = time.time()
            engines.get_parakeet_diar()  # ensure the dedicated diarization sidecar (GPU) is up
            diarize_backend = "parakeet"
            models_ready["pyannote"] = True
            pyannote_runtime_info = {
                "model": "fluidaudio (CoreML, no token)",
                "device": "ane",
                "profile": "parakeet-sidecar",
                "reason": "Apple Silicon: zero-token diarization via FluidAudio",
            }
            print(f"[heed] Diarization: FluidAudio sidecar (no token) ready in {time.time()-t:.1f}s", flush=True)
            print(f"[heed] All models ready! (whisper=ok, diarization=on via parakeet-sidecar)", flush=True)
            return
        except Exception as e:
            diarize_backend = None
            print(f"[heed] FluidAudio sidecar diarization unavailable ({str(e)[:100]}) — trying pyannote", flush=True)

    # --- Pyannote (OPTIONAL: diarization is a bonus, not a hard requirement) ---
    # If it fails to load (missing weights, OOM, gated model on a fresh box), heed keeps working
    # in transcription-only mode instead of hard-failing. "who said what" degrades to plain text.
    print(f"[heed] Loading pyannote on {devices['pyannote']}...", flush=True)
    t = time.time()
    try:
        import torch
        from pyannote.audio import Pipeline
        diarize_pipeline = Pipeline.from_pretrained("pyannote/speaker-diarization-3.1")
        pyannote_tuning = pick_pyannote_tuning(devices)
        if devices["pyannote"] in ("cuda", "mps"):
            diarize_pipeline.to(torch.device(devices["pyannote"]))
        else:
            cpu_threads = int(pyannote_tuning.get("cpu_threads", 0) or 0)
            if cpu_threads > 0:
                try:
                    torch.set_num_threads(cpu_threads)
                    torch.set_num_interop_threads(max(1, cpu_threads // 2))
                    print(f"[heed] Pyannote CPU threads tuned: {cpu_threads}", flush=True)
                except Exception as e:
                    print(f"[heed] Could not tune pyannote CPU threads: {e}", flush=True)

        bs = int(pyannote_tuning.get("batch_size", 8) or 8)
        try:
            diarize_pipeline._segmentation.batch_size = bs
            if hasattr(diarize_pipeline, '_embedding'):
                diarize_pipeline._embedding.batch_size = bs
        except Exception as e:
            print(f"[heed] Could not apply pyannote batch_size={bs}: {e}", flush=True)

        pyannote_runtime_info = {
            "model": "pyannote/speaker-diarization-3.1",
            "device": pyannote_tuning.get("device", devices["pyannote"]),
            "profile": pyannote_tuning.get("profile", "balanced"),
            "batch_size": bs,
            "reason": pyannote_tuning.get("reason", "auto"),
            **({"cpu_threads": pyannote_tuning.get("cpu_threads")} if pyannote_tuning.get("cpu_threads") else {}),
        }
        models_ready["pyannote"] = True
        diarize_backend = "pyannote"
        print(f"[heed] Pyannote ready in {time.time()-t:.1f}s ({devices['pyannote']})", flush=True)
    except Exception as e:
        diarize_pipeline = None
        models_ready["pyannote"] = False
        pyannote_runtime_info = {"model": None, "disabled": True, "reason": f"load failed: {str(e)[:120]}"}
        print(f"[heed] Pyannote unavailable ({str(e)[:100]}) — running TRANSCRIPTION-ONLY (no diarization)", flush=True)

    print(f"[heed] All models ready! (whisper={'ok' if models_ready['whisper'] else 'FAIL'}, "
          f"diarization={'on' if models_ready['pyannote'] else 'off'})", flush=True)


# --- Transcription (faster-whisper) ---
# Shared faster-whisper decode policy — defined in ONE place (high cohesion) so every
# transcribe() call (final + live + dual mic/sys channels) behaves identically.
# condition_on_previous_text=False stops repetition cascades (the "y y y..." loops) without
# touching real speech. NOTE: vad_filter was tried and REMOVED — on quiet mic audio Silero VAD
# chopped out real words ("uno dos tres probando..." → "dos, ando, hit"). The empty/garbage
# sessions were NOT a Whisper-params problem; root cause is the process-stream crash (libavdevice).
WHISPER_OPTS = {
    "condition_on_previous_text": False,
}


def is_degenerate_repetition(text):
    """Detect Whisper repetition-loop hallucinations.

    Covers single-token loops ('ya ya ya ya...', 'y y y') AND short-cycle loops
    ('o elementos o elementos o elementos...'). Heuristic: a real sentence has diverse
    words, so if a chunk of >=6 words has a very LOW unique-token ratio (<0.35) it's a
    degenerate loop, not speech. The accurate final pass re-transcribes regardless.
    """
    words = text.split()
    if len(words) < 6:
        return False
    return len(set(words)) / len(words) < 0.35


# Reasons → short, actionable user message (the UI localizes/styles it). This is heed's
# robustness differentiator: instead of silently showing garbage on bad audio, we tell the
# user WHY (mic too quiet, echo, unclear) so they can fix it. Engine-agnostic, mac + Linux.
QUALITY_HINTS = {
    "low_volume": "Tu microfono se escucha muy bajo — acercate o subi el volumen de entrada.",
    "unclear": "Audio poco claro (eco o ruido). Usa auriculares para la salida y un buen microfono.",
}


def assess_audio_quality(text, audio_s, peak):
    """Flag likely-bad transcription from cheap signals (peak amplitude + word yield +
    repetition loops). Conservative: only fires on clear failure so we never nag good audio.
    `peak` is the int16 peak (0..32767) already computed by the energy gate."""
    t = (text or "").strip()
    if peak and peak < 1000:
        return {"ok": False, "reason": "low_volume", "hint": QUALITY_HINTS["low_volume"]}
    # Loud-ish audio (clear energy) that yields almost no words = echo / muddy / unintelligible.
    if t and audio_s and audio_s >= 6 and peak and peak > 3000:
        if len(t) / audio_s < 2.0:
            return {"ok": False, "reason": "unclear", "hint": QUALITY_HINTS["unclear"]}
    if t and is_degenerate_repetition(t):
        return {"ok": False, "reason": "unclear", "hint": QUALITY_HINTS["unclear"]}
    return {"ok": True, "reason": "", "hint": ""}


def _ensure_whisper():
    """Lazy-load the final Whisper model on first use. On parakeet (Apple Silicon) the boot skips
    loading Whisper to save RAM; the only callers are the file-upload paths, so we pay the load once
    here, on demand."""
    global whisper_model, whisper_model_name
    if whisper_model is None:
        with whisper_lock:
            if whisper_model is None:
                name = whisper_model_name or "small"
                whisper_model, whisper_model_name = _load_whisper_with_fallback(name, _devices, _warmup_path, "final-lazy")
                models_ready["whisper"] = True
                print(f"[heed] Whisper lazy-loaded ({whisper_model_name}) for file upload", flush=True)
    return whisper_model


def _ensure_whisper_live():
    """Lazy-load the live Whisper model (non-parakeet live chunk mode). Reuses the final instance."""
    global whisper_model_live, whisper_model_live_name
    if whisper_model_live is None:
        m = _ensure_whisper()
        whisper_model_live = m
        whisper_model_live_name = whisper_model_name
    return whisper_model_live


def transcribe(wav_path, language="auto", srt_output=None):
    lang = None if language == "auto" else language
    _ensure_whisper()
    # Lock: whisper model is not thread-safe — serialize access.
    with whisper_lock:
        segments_gen, info = whisper_model.transcribe(wav_path, language=lang, **WHISPER_OPTS)
        # MUST consume the generator inside the lock (it holds model state)
        segments_list = list(segments_gen)

    srt_lines = []
    plain_lines = []
    for idx, seg in enumerate(segments_list, 1):
        start_ts = format_ts(seg.start)
        end_ts = format_ts(seg.end)
        text = seg.text.strip()
        srt_lines.append(f"{idx}\n{start_ts} --> {end_ts}\n{text}\n")
        plain_lines.append(text)

    srt_content = "\n".join(srt_lines)
    text = "\n".join(plain_lines) if plain_lines else ""

    srt_path = srt_output or wav_path + ".srt"
    with open(srt_path, "w") as f:
        f.write(srt_content)

    txt_path = wav_path.rsplit(".", 1)[0] + ".txt"
    with open(txt_path, "w") as f:
        f.write(text)

    return {
        "text": text,
        "srt_path": srt_path,
        "txt_path": txt_path,
        "language": info.language if info else language,
        "model": whisper_model_name,
    }


def _language_support():
    """What the UI should offer for the ACTIVE engine: the supported codes (None = all
    Whisper langs the client already lists) and whether language auto-detection works."""
    import engines
    codes, supports_auto = engines.supported_languages(active_engine)
    return {"engine": active_engine, "codes": codes, "supports_auto": supports_auto}


def format_ts(seconds):
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = seconds % 60
    ms = int((s - int(s)) * 1000)
    return f"{h:02d}:{m:02d}:{int(s):02d},{ms:03d}"


# --- Voice memory (saved speaker embeddings) ---
VOICES_PATH = os.path.join(os.path.expanduser("~"), ".heed-app", "voices.json")

def _now_iso():
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()

def _normalize_voice_entry(val):
    # Legacy format was a bare embedding list (always pyannote on Linux). Tag it so the
    # per-backend matcher treats it correctly (pyannote and wespeaker live in different spaces).
    if isinstance(val, list):
        return {"embedding": val, "backend": "pyannote", "dim": len(val), "count": 1}
    return val

def load_voices():
    if not os.path.exists(VOICES_PATH):
        return {}
    try:
        with open(VOICES_PATH) as f:
            raw = json.load(f)
        return {name: _normalize_voice_entry(v) for name, v in raw.items()}
    except Exception:
        return {}

def save_voices(voices):
    os.makedirs(os.path.dirname(VOICES_PATH), exist_ok=True)
    with open(VOICES_PATH, "w") as f:
        json.dump(voices, f, indent=2)

def current_backend():
    """Embedding-model id for the active diarizer. pyannote and FluidAudio's WeSpeaker produce
    incompatible vector spaces, so voices are tagged and matched within the same backend only."""
    if diarize_backend == "parakeet":
        return "wespeaker"
    if diarize_backend == "pyannote":
        return "pyannote"
    return "unknown"

# Cross-session match threshold is per embedding-model (different vector spaces, different scales).
#   pyannote   : cosine-sim >= 0.7 (original Linux value).
#   wespeaker  : 0.5, tuned on M5 (FluidAudio WeSpeaker v2, 256-dim L2-normalized). Measured a
#                huge separation: SAME voice across disjoint 70s windows = 0.71 (near windows 0.94),
#                DIFFERENT voices = ~0.0 (orthogonal). 0.5 sits well clear of both sides.
MATCH_THRESHOLD = {"pyannote": 0.7, "wespeaker": 0.5}  # wespeaker 0.5: RECOGNITION-first (do not break
# the brilliant post-stop). A higher threshold (0.78) missed a real saved voice matching at 0.70 while a
# different speaker matched at 0.76 → no threshold separates them. Reliable naming needs CLEAN voiceprints
# (enrollment), not a threshold. 0.5 keeps recognizing known voices as before.

def cosine_similarity(a, b):
    import math
    dot = sum(x * y for x, y in zip(a, b))
    norm_a = math.sqrt(sum(x * x for x in a))
    norm_b = math.sqrt(sum(x * x for x in b))
    if norm_a == 0 or norm_b == 0:
        return 0
    return dot / (norm_a * norm_b)

def match_voice(embedding, backend, threshold=None):
    """Best known voice for this embedding WITHIN the same backend. Returns (name|None, score)."""
    if threshold is None:
        threshold = MATCH_THRESHOLD.get(backend, 0.7)
    best_name, best_score = None, 0.0
    for name, entry in load_voices().items():
        if entry.get("backend") != backend:
            continue
        score = cosine_similarity(embedding, entry.get("embedding", []))
        if score > best_score:
            best_score, best_name = score, name
    if best_name and best_score >= threshold:
        return best_name, best_score
    return None, best_score

def save_voice(name, embedding, backend):
    """Store a voiceprint (overwrites any prior one for that name)."""
    voices = load_voices()
    emb = list(embedding)
    voices[name] = {"embedding": emb, "backend": backend, "dim": len(emb),
                    "count": 1, "updatedAt": _now_iso()}
    save_voices(voices)
    return len(voices)

UPDATE_COUNT_CAP = 8       # cap the averaging weight so a voice never becomes a blurry "attractor"
UPDATE_DRIFT_MIN = 0.6     # reject an update whose sample is far from the current print (contamination)

def update_voice(name, embedding, backend):
    """Running-mean update so a recognized voice's profile sharpens over sessions — but CONSERVATIVE:
    the averaging weight is capped (so a voice can't become a blurry magnet that matches everyone, which
    is how a saved voice got corrupted matching a different-gender speaker), and an update whose sample
    drifts far from the current print is rejected (that would be a wrong match contaminating the voice)."""
    import math
    voices = load_voices()
    entry = voices.get(name)
    if not entry or entry.get("backend") != backend:
        return
    old = entry.get("embedding", [])
    if len(old) != len(embedding):
        return
    # drift guard: only average in a sample that's clearly the SAME voice as the current print
    if cosine_similarity(old, embedding) < UPDATE_DRIFT_MIN:
        return
    count = min(int(entry.get("count", 1)), UPDATE_COUNT_CAP)  # cap the weight
    merged = [(o * count + n) / (count + 1) for o, n in zip(old, embedding)]
    norm = math.sqrt(sum(x * x for x in merged)) or 1.0
    merged = [x / norm for x in merged]
    entry.update({"embedding": merged, "count": min(count + 1, UPDATE_COUNT_CAP + 1), "updatedAt": _now_iso()})
    voices[name] = entry
    save_voices(voices)


# --- Live rolling diarization session (the "post-stop en vivo" approach) -----------------------
# Instead of streaming Sortformer (which over-segments one speaker into phantom Speaker 2/3), we run
# the OFFLINE diarizer (same engine as the brilliant post-stop) on a rolling window every ~2s and
# reconcile speakers across windows by their 256-dim voiceprint. Proven in eval_diar/ over Junior's 3
# recordings: 0 phantom speakers, conservative naming (never a wrong name). See eval_diar/DIAR_TUNING.md.
def _emb_avg(vecs, weights):
    n = len(vecs[0]); out = [0.0] * n; tw = sum(weights) or 1.0
    for v, w in zip(vecs, weights):
        for i in range(n):
            out[i] += v[i] * w
    return [x / tw for x in out]


class DiarSession:
    """Per-recording live diarization state. feed() takes one window's offline-diarizer output
    (segments + per-speaker embeddings) and returns the STABLE, conservatively-named speaker talking
    NOW. Reset at record start via diar_live_reset()."""
    # Tuned via eval_diar sweep over the 4 recent recordings (0 phantoms, 0 flickers, echo-robust).
    MERGE = 0.45         # collapse a single speaker the short window split (diff people ≤0.19 → safe)
    RECON = 0.55         # match a window speaker to an existing session speaker (kept conservative)
    CONSOLIDATE = 0.5    # merge accidental session-speaker splits
    NAME_THR = 0.62      # recognition-first (reverted from 0.78, which missed a real voice at 0.70).
                         # Reliable naming needs clean voiceprints (enrollment), not a high threshold.
    NAME_MARGIN = 0.08   # top1 must beat top2 by this → no ambiguous names
    NAME_MINDUR = 4.0    # accumulated speech before a name is allowed
    CUR_SLICE = 1.5      # "who talks NOW" = dominant speaker in the last N s of the window
    CONFIRM = 2          # hysteresis: a NEW speaker must dominate this many consecutive windows before
                         # the shown label switches → kills 1-2 tick flickers (what Junior saw as the
                         # "man split in 2"). First speaker (from None) shows immediately.
    backend = "wespeaker"

    def __init__(self):
        self.speakers = []   # {label, emb, dur, name, name_score}
        self.alias = {}
        self.n = 0
        self._shown = None   # currently displayed session label (post-hysteresis)
        self._cand = None    # candidate label building confirmations
        self._cand_n = 0

    def _resolve(self, label):
        seen = set()
        while label in self.alias and label not in seen:
            seen.add(label); label = self.alias[label]
        return label

    def _merge_within(self, embs, durs):
        groups = []
        for sid in sorted(embs.keys(), key=lambda k: -durs.get(k, 0)):
            hit = None
            for g in groups:
                if cosine_similarity(embs[sid], g["emb"]) >= self.MERGE:
                    hit = g; break
            if hit is None:
                groups.append({"ids": [sid], "emb": list(embs[sid]), "dur": durs[sid]})
            else:
                hit["emb"] = _emb_avg([hit["emb"], embs[sid]], [hit["dur"], durs[sid]])
                hit["dur"] += durs[sid]; hit["ids"].append(sid)
        return groups

    def _reconcile(self, groups):
        mapping = {}
        for gi, g in enumerate(groups):
            best, bs = None, 0.0
            for sp in self.speakers:
                c = cosine_similarity(g["emb"], sp["emb"])
                if c > bs:
                    bs, best = c, sp
            if best is None or bs < self.RECON:
                self.n += 1
                best = {"label": f"Speaker {self.n}", "emb": list(g["emb"]), "dur": 0.0,
                        "name": None, "name_score": 0.0}
                self.speakers.append(best)
            else:
                best["emb"] = _emb_avg([best["emb"], g["emb"]], [best["dur"], g["dur"]])
            best["dur"] += g["dur"]
            mapping[gi] = best["label"]
        return mapping

    def _consolidate(self):
        order = sorted(self.speakers, key=lambda s: -s["dur"]); merged = []
        for sp in order:
            hit = next((m for m in merged if cosine_similarity(sp["emb"], m["emb"]) >= self.CONSOLIDATE), None)
            if hit is None:
                merged.append(sp)
            else:
                hit["emb"] = _emb_avg([hit["emb"], sp["emb"]], [hit["dur"], sp["dur"]]); hit["dur"] += sp["dur"]
                if sp["name"] and sp["name_score"] > hit["name_score"]:
                    hit["name"], hit["name_score"] = sp["name"], sp["name_score"]
                self.alias[sp["label"]] = hit["label"]
        self.speakers = merged

    def _name(self):
        voices = [(nm, e) for nm, e in load_voices().items() if e.get("backend") == self.backend]
        for sp in self.speakers:
            if sp["dur"] < self.NAME_MINDUR:
                continue
            scored = sorted((cosine_similarity(sp["emb"], e.get("embedding", [])), nm) for nm, e in voices)
            if not scored:
                continue
            top_s, top_n = scored[-1]
            second_s = scored[-2][0] if len(scored) > 1 else 0.0
            if top_s >= self.NAME_THR and (top_s - second_s) >= self.NAME_MARGIN and top_s > sp["name_score"]:
                sp["name"], sp["name_score"] = top_n, top_s

    def _display(self, label):
        label = self._resolve(label)
        for sp in self.speakers:
            if sp["label"] == label:
                return sp["name"] or sp["label"]
        return label

    def feed(self, segments, embeddings, window_s=None):
        durs = {}
        for s in segments:
            k = str(s["speaker"]); durs[k] = durs.get(k, 0.0) + (float(s["end"]) - float(s["start"]))
        embs = {str(k): v for k, v in embeddings.items() if str(k) in durs and v}
        if not embs:
            return {"speaker": None, "label": None,
                    "speakers": [sp["name"] or sp["label"] for sp in self.speakers]}
        groups = self._merge_within(embs, durs)
        mapping = self._reconcile(groups)
        self._consolidate()
        self._name()
        # who talks NOW = dominant speaker in the last CUR_SLICE s of the window, anchored at the
        # window END (== the current recording position) so silence at the tail doesn't shift it.
        now = float(window_s) if window_s else max(float(s["end"]) for s in segments)
        lo = now - self.CUR_SLICE
        best_s, best_ov = None, 0.0
        for s in segments:
            ov = min(now, float(s["end"])) - max(lo, float(s["start"]))
            if ov > best_ov:
                best_ov, best_s = ov, s
        raw_label = None
        if best_s is not None:
            gi = next((i for i, g in enumerate(groups) if str(best_s["speaker"]) in g["ids"]), None)
            if gi is not None:
                raw_label = self._resolve(mapping[gi])   # stable session identity of who talks now
        # Hysteresis: switch the SHOWN speaker only when a NEW one is confirmed across CONFIRM windows.
        # From silence/first-ever speaker, switch immediately (no flicker risk). A 1-tick blip never
        # reaches CONFIRM → the shown label stays put. Brief None (gap) keeps the last shown speaker.
        if raw_label is not None:
            if raw_label == self._shown:
                self._cand, self._cand_n = None, 0
            elif self._shown is None:
                self._shown = raw_label; self._cand, self._cand_n = None, 0
            else:
                if raw_label == self._cand:
                    self._cand_n += 1
                else:
                    self._cand, self._cand_n = raw_label, 1
                if self._cand_n >= self.CONFIRM:
                    self._shown = raw_label; self._cand, self._cand_n = None, 0
        shown = self._shown
        cur = self._display(shown) if shown is not None else None
        return {"speaker": cur, "label": shown, "raw_label": raw_label,
                "speakers": [sp["name"] or sp["label"] for sp in self.speakers]}


_diar_session = DiarSession()


class MicFilter(DiarSession):
    """Keeps ONLY the owner's (Junior's) voice on the mic channel; suppresses foreign audio the laptop
    mic picks up acoustically (external TV, another person in the room) — the case the 3 echo layers
    can't touch (no system-channel reference for external audio). Uses the voice RAG: diarize the mic,
    identify the owner cluster (matched to the saved voice, else the dominant cluster since it's HIS
    mic), and suppress anything that's a DIFFERENT voice. Conservative: a single-voice mic is always
    kept (never drops the owner); with a weak owner voiceprint it only suppresses a clearly-matched
    owner's counterpart. Auto-learns the owner's voiceprint from the consistent cluster (never the TV,
    which is far from the print)."""
    OWNER = "Junior"
    OWNER_MATCH = 0.45     # cosine to the saved owner voice to call a cluster "the owner" (for learn)
    OWNER_KEEP = 0.30      # keep the mic if the CURRENT voice is at least this close to the owner print.
                           # Owner splits (quiet/noisy mic) stay >0.3; a foreign voice (TV) is <0.15 →
                           # clean separation, and we NEVER drop the owner over a noisy split.
    LEARN_CONSISTENT = 0.40  # only learn from a cluster within this cosine of the existing print
    STRONG_COUNT = 5       # owner voiceprint is "strong" enough to filter at/after this sample count
    FOREIGN_CONFIRM = 2    # require N consecutive foreign windows before gating → never drop a brief
                           # noisy owner segment; instantly un-gate the moment the owner is detected

    def __init__(self):
        super().__init__()
        self._foreign_streak = 0

    def _owner_cluster(self):
        """(label, score, how) of the cluster that is the owner. how: 'matched'|'dominant'|'none'."""
        ov = load_voices().get(self.OWNER)
        if ov and ov.get("backend") == self.backend and self.speakers:
            emb = ov.get("embedding", [])
            best, bs = None, 0.0
            for sp in self.speakers:
                c = cosine_similarity(sp["emb"], emb)
                if c > bs:
                    bs, best = c, sp
            if best and bs >= self.OWNER_MATCH:
                return best["label"], bs, "matched"
        if self.speakers:
            dom = max(self.speakers, key=lambda s: s["dur"])
            return dom["label"], 0.0, "dominant"
        return None, 0.0, "none"

    def classify(self, segments, embeddings, window_s=None):
        """-> {keep: bool, reason}. keep=False means the current mic voice is NOT the owner (filter it).
        Decision is DIRECT: cosine(current voice, owner voiceprint). Robust to the owner's own mic being
        split into several clusters (a noisy/quiet mic) — every owner split still sits well above the
        threshold, while a foreign voice (TV) is near-orthogonal. Only filters with a STRONG print;
        a weak/absent print keeps everything (never drop the owner)."""
        res = self.feed(segments, embeddings, window_s)
        cur = res.get("label")
        if cur is None:
            return {"keep": True, "reason": "silence"}
        ov = load_voices().get(self.OWNER)
        if not ov or ov.get("backend") != self.backend or int(ov.get("count", 1)) < self.STRONG_COUNT:
            return {"keep": True, "reason": "weak-owner-keep"}   # not enough voiceprint yet → keep all
        lab = self._resolve(cur)
        sp = next((s for s in self.speakers if s["label"] == lab), None)
        if sp is None:
            return {"keep": True, "reason": "no-cluster"}
        sim = cosine_similarity(sp["emb"], ov.get("embedding", []))
        if sim >= self.OWNER_KEEP:
            self._foreign_streak = 0
            return {"keep": True, "reason": f"owner({sim:.2f})"}
        # foreign — but only GATE after CONFIRM consecutive foreign windows (never drop a brief noisy
        # owner segment), and un-gate instantly the moment the owner is heard again.
        self._foreign_streak += 1
        if self._foreign_streak >= self.FOREIGN_CONFIRM:
            return {"keep": False, "reason": f"foreign({sim:.2f})"}
        return {"keep": True, "reason": f"foreign-pending({sim:.2f})"}

    def learn(self):
        """Strengthen the owner voiceprint from the cluster consistent with the existing print (never
        the TV, which is far). If no print yet, seed from the dominant cluster (his mic = him)."""
        if not self.speakers:
            return None
        ov = load_voices().get(self.OWNER)
        if not ov or ov.get("backend") != self.backend:
            dom = max(self.speakers, key=lambda s: s["dur"])
            if dom["dur"] >= 8.0:
                save_voice(self.OWNER, dom["emb"], self.backend)
                return ("seed", dom["dur"])
            return None
        emb = ov.get("embedding", [])
        best, bs = None, 0.0
        for sp in self.speakers:
            c = cosine_similarity(sp["emb"], emb)
            if c > bs:
                bs, best = c, sp
        if best and bs >= self.LEARN_CONSISTENT and best["dur"] >= 5.0:
            update_voice(self.OWNER, best["emb"], self.backend)
            return ("update", round(bs, 3))
        return None


_mic_session = MicFilter()

def diar_live_reset():
    global _diar_session, _mic_session
    _diar_session = DiarSession()
    _mic_session = MicFilter()


def _sys_silent_frames(sys_path, frame_s=0.25, thr=0.01):
    """Per-frame boolean 'system is SILENT' mask for the system channel (RMS < thr). Used to learn the
    owner's voice ONLY from mic moments with no system audio playing → no laptop-echo contamination."""
    try:
        import wave as _w, struct as _s
        with _w.open(sys_path) as wf:
            sr = wf.getframerate() or 16000
            fr = wf.readframes(wf.getnframes())
        n = len(fr) // 2
        smp = _s.unpack("<" + "h" * n, fr)
        fl = max(1, int(frame_s * sr))
        mask = []
        for i in range(0, n, fl):
            seg = smp[i:i + fl]
            rms = (sum(x * x for x in seg) / len(seg)) ** 0.5 / 32768.0 if seg else 0.0
            mask.append(rms < thr)
        return mask, frame_s
    except Exception:
        return [], frame_s


def learn_owner_voice(mic_path, sys_path, owner="Junior"):
    """Refined auto-learn (Junior's plan): learn the OWNER's voiceprint from the MIC channel, using the
    cluster that talks the most while the SYSTEM is SILENT (clean, no echo) — the dominant, recurring
    voice. Consistency-checked against the existing print so the TV (which varies) never overwrites it;
    bootstraps if there's no print yet and one voice clearly dominates the clean speech."""
    import engines
    try:
        md = engines.get_parakeet_diar().diarize(mic_path)
    except Exception as e:
        return {"learned": None, "reason": f"diar-failed:{str(e)[:40]}"}
    segs = md.get("segments", []); embs = md.get("embeddings", {})
    if not embs:
        return {"learned": None, "reason": "no-mic-voice"}
    mask, fs = _sys_silent_frames(sys_path) if sys_path else ([], 0.25)

    def clean_dur(a, b):
        if not mask:
            return b - a           # no system channel → treat all as clean
        i0 = int(a / fs); i1 = max(i0 + 1, int(b / fs))
        sil = sum(1 for i in range(i0, min(i1, len(mask))) if mask[i])
        return sil * fs

    clean, total = {}, {}
    for s in segs:
        sid = str(s["speaker"]); total[sid] = total.get(sid, 0.0) + (s["end"] - s["start"])
        clean[sid] = clean.get(sid, 0.0) + clean_dur(s["start"], s["end"])
    clean = {k: v for k, v in clean.items() if k in embs}
    if not clean or max(clean.values()) < 4.0:
        return {"learned": None, "reason": "too-little-clean-speech"}
    owner_sid = max(clean, key=clean.get)
    owner_emb = embs.get(owner_sid)
    ov = load_voices().get(owner)
    if ov and ov.get("backend") == "wespeaker" and ov.get("embedding"):
        sim = cosine_similarity(owner_emb, ov["embedding"])
        if sim < 0.35:   # dominant clean voice is NOT the known owner (TV-heavy recording) → skip
            return {"learned": None, "reason": f"inconsistent-skip({sim:.2f})"}
        update_voice(owner, owner_emb, "wespeaker")
        return {"learned": "update", "sim": round(sim, 3), "clean_s": round(clean[owner_sid], 1)}
    # bootstrap: no print yet → only seed if one voice clearly dominates the CLEAN speech
    if clean[owner_sid] >= 0.6 * sum(clean.values()):
        save_voice(owner, owner_emb, "wespeaker")
        return {"learned": "seed", "clean_s": round(clean[owner_sid], 1)}
    return {"learned": None, "reason": "ambiguous-bootstrap"}


# --- Diarization ---
# Diarization over-counts speakers on hard audio (similar voices, podcasts): one real voice
# can split into an extra "phantom" cluster with little total speech. This drops speakers whose
# total speech is tiny both absolutely and relative to the rest, reassigning their segments to
# the temporally-nearest surviving speaker (keeps all transcript text, just fixes the label).
# Model-agnostic: applied to both FluidAudio and pyannote output.
# --- Voice-embedding clustering backbone (heed's own diarization, per-segment cosine) --------------
# Thresholds calibrated on the measured cosine landscape of real meetings: max inter-speaker ≈ 0.36,
# same-person/echo cross-channel ≈ 0.71-0.86. Bias = OVER-DETECT (a HIGHER threshold = MORE clusters,
# never lose a speaker; the user merges with one click). Tune via eval_diar sweep on real audio.
AGGLO_THRESHOLD = 0.55       # assign a segment to a cluster only if cosine >= this, else new cluster
PHANTOM_MERGE_COS = 0.62     # 2nd pass: collapse clusters whose centroids are this close (same voice split)
SEED_MIN_DUR = 1.0           # only segments >= this may SEED a new cluster (short embeddings are noisy)
CLUSTER_MIN_DUR = 2.5        # 3rd pass: absorb clusters totalling less than this into their nearest voice


def _assign_by_overlap(seg, clusters, segments):
    """Cluster id whose segments overlap `seg` most in time (fallback for no-emb / short segments)."""
    best_cid, best_ov = None, 0.0
    for cid, c in clusters.items():
        for j in c["idxs"]:
            ov = min(seg["end"], segments[j]["end"]) - max(seg["start"], segments[j]["start"])
            if ov > best_ov:
                best_ov, best_cid = ov, cid
    return best_cid


def cluster_segments(segments, threshold=AGGLO_THRESHOLD, merge_cos=PHANTOM_MERGE_COS):
    """Agglomerative cosine clustering over PER-SEGMENT voice embeddings — heed's diarization backbone.

    segments: list of {"start","end","emb":[256 floats], ...}. Returns (labels, clusters):
      labels[i]  -> cluster id for segments[i]
      clusters   -> {cid: {"emb": centroid, "dur": seconds, "idxs": [segment indices]}}
    Robust to noisy per-segment embeddings (same voice ranges 0.14-1.0 cosine): only long segments
    seed clusters, short ones join their best match, and tiny leftover clusters are absorbed — so we
    separate the speakers FluidAudio merged WITHOUT exploding into junk singletons.
    """
    labels = [None] * len(segments)
    clusters = {}
    next_id = 0
    # Phase A — assign; longest segments first (reliable anchors). A short segment may JOIN its best
    # cluster but never SEED one (its embedding is too noisy to trust as a new voice).
    order = sorted((i for i, s in enumerate(segments) if s.get("emb")),
                   key=lambda i: (segments[i]["end"] - segments[i]["start"]), reverse=True)
    for i in order:
        s = segments[i]
        emb = s["emb"]
        dur = max(1e-3, s["end"] - s["start"])
        best_cid, best_c = None, -1.0
        for cid, c in clusters.items():
            cc = cosine_similarity(emb, c["emb"])
            if cc > best_c:
                best_c, best_cid = cc, cid
        if best_cid is not None and best_c >= threshold:
            c = clusters[best_cid]
            c["emb"] = _emb_avg([c["emb"], emb], [c["dur"], dur])
            c["dur"] += dur
            c["idxs"].append(i)
            labels[i] = best_cid
        elif dur >= SEED_MIN_DUR:
            clusters[next_id] = {"emb": list(emb), "dur": dur, "idxs": [i]}
            labels[i] = next_id
            next_id += 1
        # else: short + no good cluster -> leave for the post-hoc time-overlap pass

    def _consolidate(min_cos):
        merged = True
        while merged and len(clusters) > 1:
            merged = False
            ids = list(clusters.keys())
            for a in range(len(ids)):
                done = False
                for b in range(a + 1, len(ids)):
                    ca, cb = ids[a], ids[b]
                    if cosine_similarity(clusters[ca]["emb"], clusters[cb]["emb"]) >= min_cos:
                        A, B = clusters[ca], clusters[cb]
                        A["emb"] = _emb_avg([A["emb"], B["emb"]], [A["dur"], B["dur"]])
                        A["dur"] += B["dur"]
                        A["idxs"].extend(B["idxs"])
                        for j in B["idxs"]:
                            labels[j] = ca
                        del clusters[cb]
                        merged = done = True
                        break
                if done:
                    break

    # Phase B — consolidate near-identical clusters (same voice split by assignment order).
    _consolidate(merge_cos)

    # Phase C — absorb tiny clusters (noise / a couple of bad segments) into their nearest voice by
    # centroid cosine, UNCONDITIONALLY (they're too small to be a real distinct speaker). Kills singletons.
    for cid in [c for c in clusters if clusters[c]["dur"] < CLUSTER_MIN_DUR]:
        if len(clusters) <= 1 or cid not in clusters:
            continue
        best_to, best_c = None, -1.0
        for other in clusters:
            if other == cid:
                continue
            cc = cosine_similarity(clusters[cid]["emb"], clusters[other]["emb"])
            if cc > best_c:
                best_c, best_to = cc, other
        if best_to is not None:
            A, B = clusters[best_to], clusters[cid]
            A["emb"] = _emb_avg([A["emb"], B["emb"]], [A["dur"], B["dur"]])
            A["dur"] += B["dur"]
            A["idxs"].extend(B["idxs"])
            for j in B["idxs"]:
                labels[j] = best_to
            del clusters[cid]

    # Post-hoc — segments not yet assigned (no emb, or short with no good cluster): by time overlap.
    for i, s in enumerate(segments):
        if labels[i] is not None:
            continue
        cid = _assign_by_overlap(s, clusters, segments)
        labels[i] = cid if cid is not None else (next(iter(clusters)) if clusters else 0)
    return labels, clusters


def _filter_spurious_speakers(segments, min_fraction=0.12, min_abs_s=3.0):
    if not segments:
        return segments
    totals = {}
    for s in segments:
        totals[s["speaker"]] = totals.get(s["speaker"], 0.0) + (s["end"] - s["start"])
    if len(totals) <= 1:
        return segments
    grand = sum(totals.values()) or 1.0
    keep = {spk for spk, t in totals.items() if t >= min_abs_s and (t / grand) >= min_fraction}
    if not keep:                       # everyone tiny (very short clip) → keep the largest
        keep = {max(totals, key=totals.get)}
    if len(keep) == len(totals):
        return segments                # nothing spurious
    segs = sorted(segments, key=lambda s: s["start"])
    for i, s in enumerate(segs):
        if s["speaker"] in keep:
            continue
        new_spk = next((segs[j]["speaker"] for j in range(i - 1, -1, -1) if segs[j]["speaker"] in keep), None)
        if new_spk is None:
            new_spk = next((segs[j]["speaker"] for j in range(i + 1, len(segs)) if segs[j]["speaker"] in keep), None)
        s["speaker"] = new_spk or next(iter(keep))
    return segs


def _renumber_speakers(segments):
    """Map arbitrary speaker labels to contiguous 'Speaker 1/2/...' in first-appearance order
    (Sortformer uses non-contiguous slot ids like 0,2 → would show 'Speaker 1, Speaker 3')."""
    mapping = {}
    n = 0
    for s in sorted(segments, key=lambda x: x["start"]):
        if s["speaker"] not in mapping:
            n += 1
            mapping[s["speaker"]] = f"Speaker {n}"
    return [{**s, "speaker": mapping[s["speaker"]]} for s in segments]


def _diarize_parakeet(wav_path, srt_path=None, recognize_only=False):
    """Diarization via the FluidAudio sidecar (Apple Silicon, no gated token).
    Returns the SAME contract as the pyannote path so callers don't branch.
    Cross-session voice naming works here too: the sidecar exposes per-speaker WeSpeaker
    embeddings, which we match against ~/.heed-app/voices.json (backend-tagged)."""
    import engines
    diar = engines.get_parakeet_diar().diarize(wav_path)  # {"segments":[...], "embeddings":{sid:[...]}}
    raw_embeddings = diar.get("embeddings", {})       # keyed by RAW FluidAudio speaker id
    # Drop phantom speakers, then map remaining ids -> contiguous "Speaker 1/2/...".
    raw_segments = _filter_spurious_speakers([
        {"start": float(s.get("start", 0.0)), "end": float(s.get("end", 0.0)), "speaker": str(s.get("speaker", "?"))}
        for s in diar.get("segments", [])
    ])

    # Map FluidAudio speaker ids -> "Speaker 1/2/..." in first-appearance order.
    speakers_map = {}
    counter = 0
    diar_segments = []
    for seg in sorted(raw_segments, key=lambda s: s["start"]):
        sid = str(seg.get("speaker", "?"))
        if sid not in speakers_map:
            counter += 1
            speakers_map[sid] = f"Speaker {counter}"
        diar_segments.append({
            "start": round(float(seg.get("start", 0.0)), 2),
            "end": round(float(seg.get("end", 0.0)), 2),
            "speaker": speakers_map[sid],
        })
    diar_segments.sort(key=lambda s: s["start"])

    # Cross-session voice recognition: match each speaker's voiceprint to known voices,
    # auto-rename on a hit (decision 3), and average the profile in (decision 4).
    speaker_embeddings, auto_named = _name_known_voices(speakers_map, raw_embeddings, diar_segments, recognize_only)

    if srt_path and os.path.exists(srt_path):
        srt_segments = parse_srt(srt_path)
        merged = assign_speakers(diar_segments, srt_segments)
        lines = []
        last = None
        for seg in merged:
            if seg["speaker"] != last:
                lines.append(f"\n{seg['speaker']}:")
                last = seg["speaker"]
            lines.append(f"  {seg['text']}")
        text = "\n".join(lines).strip()
    else:
        merged = diar_segments
        text = ""

    final_speakers = sorted({s["speaker"] for s in diar_segments})
    return {
        "speakers": final_speakers,
        "speaker_count": len(final_speakers),
        "segments": merged,
        "text": text,
        "embeddings": speaker_embeddings,
        "auto_named": auto_named,
    }


def _name_known_voices(speakers_map, raw_embeddings, diar_segments, recognize_only=False):
    """Given raw-sid->label map + raw-sid->embedding, match each speaker against saved voices
    (current backend). On a hit: rename the label IN PLACE in diar_segments, mark it auto, and
    average the embedding into the stored profile. Returns (speaker_embeddings, auto_named)
    keyed by the FINAL speaker label. Shared by the FluidAudio path (pyannote builds its own)."""
    backend = current_backend()
    speaker_embeddings = {}
    auto_named = {}
    rename = {}
    for sid, label in speakers_map.items():
        emb = raw_embeddings.get(sid) or raw_embeddings.get(str(sid))
        if not emb:
            continue
        speaker_embeddings[label] = emb
        matched, score = match_voice(emb, backend)
        if matched and matched != label:
            rename[label] = matched
            auto_named[matched] = {"name": matched, "score": round(float(score), 3)}
            if not recognize_only:  # live recognition just reads; only the final pass averages/saves
                update_voice(matched, emb, backend)
    if rename:
        for s in diar_segments:
            if s["speaker"] in rename:
                s["speaker"] = rename[s["speaker"]]
        speaker_embeddings = {rename.get(k, k): v for k, v in speaker_embeddings.items()}
    return speaker_embeddings, auto_named


def _ffmpeg_channel(wav_path, ch, out_path):
    """Extract one channel (0 = mic, 1 = system) as mono 16 kHz — what the sidecar expects."""
    import subprocess
    subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-i", wav_path,
         "-filter_complex", f"[0:a]pan=mono|c0=c{ch},aresample=16000[a]",
         "-map", "[a]", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", out_path],
        check=True,
    )


def _dominant_diar_speaker(seg, diar_segs):
    """Speaker whose diarization overlaps `seg` most; if none overlaps, snap to the nearest in time."""
    best, best_ov = None, 0.0
    for d in diar_segs:
        ov = min(seg["end"], d["end"]) - max(seg["start"], d["start"])
        if ov > best_ov:
            best_ov, best = ov, d["speaker"]
    if best:
        return best
    nearest, nd = None, 1e9
    mid = (seg["start"] + seg["end"]) / 2.0
    for d in diar_segs:
        dist = 0.0 if d["start"] <= mid <= d["end"] else min(abs(mid - d["start"]), abs(mid - d["end"]))
        if dist < nd:
            nd, nearest = dist, d["speaker"]
    return nearest


# A mic voice whose cosine to any SYSTEM voice is >= this is the remote leaking through the speakers
# (echo), not the owner. The owner's voice never loops back to the system channel, so it stays below.
OWNER_ECHO_COS = 0.65


def finalize_recording(wav_path, language="auto", is_dual=True):
    """Post-stop pipeline (the real 'brilliant' one): re-transcribe BOTH channels with REAL Parakeet
    timestamps, diarize the system channel (remote speakers), and — crucially for no-headphone setups —
    acoustically strip the mic's echo by keeping only the mic voice that does NOT match any system
    voice (the owner). Names known voices. Returns coherent, time-stamped, attributed turns.

    Single source of truth: the /finalize endpoint and scripts/postmortem.py both call this.
    Returns {"turns":[{start,end,speaker,text}], "speakers":[...], "embeddings":{...}, "auto_named":{...}}.
    """
    import engines
    import tempfile
    asr = engines.get_parakeet()

    # Use the FluidAudio path directly on Apple Silicon so this works whether or not the server's
    # boot set the `diarize_backend` global (the harness imports the module without booting).
    def _diar(path):
        if engines.is_apple_silicon():
            return _diarize_parakeet(path)
        return diarize(path)

    def segs_for(path):
        tok = asr.transcribe_ts(path, language)
        return engines.tokens_to_segments(tok.get("tokens", []))

    tmp = []
    try:
        if not is_dual:
            mono = tempfile.mktemp(suffix=".wav"); tmp.append(mono)
            _ffmpeg_channel(wav_path, 0, mono)
            d = _diar(mono)
            turns = [{**s, "speaker": _dominant_diar_speaker(s, d["segments"]) or "Speaker 1", "channel": "sys"}
                     for s in segs_for(mono)]
            turns.sort(key=lambda x: x["start"])
            return {"turns": turns, "speakers": d.get("speakers", []),
                    "embeddings": d.get("embeddings", {}), "auto_named": d.get("auto_named", {})}

        mic = tempfile.mktemp(suffix=".wav"); tmp.append(mic); _ffmpeg_channel(wav_path, 0, mic)
        sysw = tempfile.mktemp(suffix=".wav"); tmp.append(sysw); _ffmpeg_channel(wav_path, 1, sysw)

        # Acoustically cancel the system out of the mic (no-headphones echo), then transcribe both.
        mic_clean = _aec_clean(mic, sysw)
        if mic_clean != mic:
            tmp.append(mic_clean)
        sys_segs = segs_for(sysw)
        mic_segs = segs_for(mic_clean)

        # --- Voice-clustering backbone: diarize BOTH channels per-segment, pool, cluster by cosine. ---
        # This finds the TRUE distinct voices (FluidAudio merged them per-channel; the %-filter deleted
        # minorities). Echo folds in for free: the presenter's mic-echo (cos ~0.86 to their sys voice)
        # clusters WITH their system cluster, so it never becomes a phantom speaker.
        sys_raw = engines.get_parakeet_diar().diarize(sysw)
        mic_raw = engines.get_parakeet_diar().diarize(mic_clean)
        pool = []
        for s in sys_raw.get("segments", []):
            if s.get("emb"):
                pool.append({"start": float(s["start"]), "end": float(s["end"]), "emb": s["emb"], "ch": "sys"})
        for s in mic_raw.get("segments", []):
            if s.get("emb"):
                pool.append({"start": float(s["start"]), "end": float(s["end"]), "emb": s["emb"], "ch": "mic"})

        labels, clusters = cluster_segments(pool)
        for i, seg in enumerate(pool):
            seg["cid"] = labels[i]

        # Name each cluster via saved voiceprints (cross-session recognition); unmatched -> "Speaker N"
        # in first-appearance order. The owner (e.g. "Junior") is recognized here when their voice is saved.
        # NOTE: we do NOT try to split two soft in-room voices that share one mic — measured, their
        # per-segment WeSpeaker embeddings interleave (a foreign line can sit 0.87 to the owner's print
        # while the owner's own line sits 0.75), so no threshold separates them at that SNR. heed's
        # over-detect + one-click merge in the UI is the escape hatch until enrollment/SOTA embeddings land.
        backend = current_backend()
        matched_name = {}
        for cid, c in clusters.items():
            m, _sc = match_voice(c["emb"], backend)
            matched_name[cid] = m

        # Per-cluster channel presence: a cluster with real SYSTEM duration is a remote/presenter voice
        # (its mic segments are echo). A mic-only cluster is someone whose voice is only on the mic
        # (the owner, or a person in the room) — keep their mic text.
        cl_ch = {cid: {"mic": 0.0, "sys": 0.0} for cid in clusters}
        for seg in pool:
            cl_ch[seg["cid"]][seg["ch"]] += seg["end"] - seg["start"]
        sys_based = {cid for cid in clusters if cl_ch[cid]["sys"] >= 1.0}

        # "Speaker N" for the unmatched clusters, in first-appearance order.
        first_start = {cid: min(pool[j]["start"] for j in clusters[cid]["idxs"]) for cid in clusters}
        cluster_label, n = {}, 0
        for cid in sorted(clusters, key=lambda c: first_start[c]):
            if matched_name[cid]:
                cluster_label[cid] = matched_name[cid]
            else:
                n += 1
                cluster_label[cid] = f"Speaker {n}"

        # Assign each TEXT segment to the cluster of the diarization segment it overlaps most (same channel).
        diar_by_ch = {"mic": [s for s in pool if s["ch"] == "mic"], "sys": [s for s in pool if s["ch"] == "sys"]}

        def cluster_for(seg, ch):
            best, bo = None, 0.0
            for d in diar_by_ch[ch]:
                ov = min(seg["end"], d["end"]) - max(seg["start"], d["start"])
                if ov > bo:
                    bo, best = ov, d["cid"]
            if best is None and diar_by_ch[ch]:
                mid = (seg["start"] + seg["end"]) / 2.0
                best = min(diar_by_ch[ch],
                           key=lambda d: 0.0 if d["start"] <= mid <= d["end"] else min(abs(mid - d["start"]), abs(mid - d["end"])))["cid"]
            return best

        turns = []
        for s in sys_segs:
            cid = cluster_for(s, "sys")
            if cid is None:
                continue
            turns.append({"start": s["start"], "end": s["end"], "text": s["text"], "speaker": cluster_label[cid], "channel": "sys"})
        for s in mic_segs:
            cid = cluster_for(s, "mic")
            if cid is None or cid in sys_based:   # sys_based mic text = echo of a remote voice -> drop
                continue
            turns.append({"start": s["start"], "end": s["end"], "text": s["text"], "speaker": cluster_label[cid], "channel": "mic"})
        turns.sort(key=lambda x: x["start"])

        # Do NOT auto-average recognized voiceprints here: a post-stop cluster can silently contain a
        # second quiet mic voice (measured: two soft in-room speakers fuse), and update_voice() on that
        # blended centroid slowly turns a saved print into a blurry attractor that matches everyone —
        # the exact corruption update_voice() warns about. Voiceprints are (re)saved only on an explicit
        # user rename, where the identity is certain.
        embeddings = {cluster_label[cid]: clusters[cid]["emb"] for cid in clusters}
        auto_named = {cluster_label[cid]: {"name": matched_name[cid], "score": 1.0}
                      for cid in clusters if matched_name[cid]}
        return {"turns": turns, "speakers": sorted({t["speaker"] for t in turns}),
                "embeddings": embeddings, "auto_named": auto_named}
    finally:
        for p in tmp:
            try:
                if p and os.path.exists(p):
                    os.unlink(p)
            except Exception:
                pass


def diarize(wav_path, srt_path=None, min_speakers=None, max_speakers=None, recognize_only=False):
    if diarize_backend == "parakeet":
        return _diarize_parakeet(wav_path, srt_path, recognize_only)
    # Tune clustering for accuracy (slightly conservative to avoid splitting same voice)
    params = diarize_pipeline.parameters(instantiated=True)
    params["clustering"]["threshold"] = 0.8

    kwargs = {}
    if min_speakers:
        kwargs["min_speakers"] = int(min_speakers)
    if max_speakers:
        kwargs["max_speakers"] = int(max_speakers)

    try:
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass  # torchless (Mac-lite) — this is the pyannote/Linux path, unreached on Mac-parakeet

    try:
        result = diarize_pipeline(wav_path, **kwargs)
    except torch.cuda.OutOfMemoryError as oom:
        # Last-ditch fallback: free everything, move pipeline to CPU and retry once.
        # This recovers from situations where Ollama or another GPU consumer pushed
        # us over the limit mid-meeting.
        print(f"[heed] pyannote CUDA OOM — falling back to CPU and retrying: {oom}", flush=True)
        try:
            torch.cuda.empty_cache()
            diarize_pipeline.to(torch.device("cpu"))
            result = diarize_pipeline(wav_path, **kwargs)
        except Exception as e2:
            raise RuntimeError(f"pyannote failed on both GPU and CPU: {e2}") from oom
    annotation = result.speaker_diarization

    # Get speaker embeddings (one per detected speaker)
    embeddings = result.speaker_embeddings  # numpy array, shape (num_speakers, embedding_dim)

    # Build speaker map: pyannote label -> "Speaker N", with raw embeddings kept per raw label.
    raw_labels = list(annotation.labels())
    speakers_map = {}
    raw_embeddings = {}
    counter = 0
    for i, raw_label in enumerate(raw_labels):
        counter += 1
        speakers_map[raw_label] = f"Speaker {counter}"
        if i < len(embeddings):
            raw_embeddings[raw_label] = embeddings[i].tolist()

    # Build segments using the "Speaker N" labels
    diar_segments = []
    for turn, _, speaker in annotation.itertracks(yield_label=True):
        diar_segments.append({
            "start": round(turn.start, 2),
            "end": round(turn.end, 2),
            "speaker": speakers_map[speaker],
        })
    # Drop phantom over-counted speakers (reassign their segments to the nearest real speaker).
    diar_segments = _filter_spurious_speakers(diar_segments)
    # Filtering can leave NON-CONTIGUOUS labels (e.g. "Speaker 4" with no "Speaker 3") — the Mac/live
    # paths renumber but this pyannote path didn't (Linux-only bug). Renumber to contiguous "Speaker 1..N"
    # in first-appearance order AND remap the embeddings the same way so cross-session naming stays aligned.
    _relabel, _k = {}, 0
    for s in sorted(diar_segments, key=lambda x: x["start"]):
        if s["speaker"] not in _relabel:
            _k += 1
            _relabel[s["speaker"]] = f"Speaker {_k}"
    for s in diar_segments:
        s["speaker"] = _relabel[s["speaker"]]
    # Cross-session voice recognition (auto-rename known voices in place + average the profile).
    # Re-key embeddings from raw labels -> renumbered "Speaker N" before matching (dropping filtered ones).
    label_embeddings = {_relabel[speakers_map[rl]]: emb for rl, emb in raw_embeddings.items()
                        if speakers_map[rl] in _relabel}
    sid_map = {lbl: lbl for lbl in label_embeddings}  # labels are already final "Speaker N"
    speaker_embeddings, auto_named = _name_known_voices(sid_map, label_embeddings, diar_segments)
    kept_speakers = {s["speaker"] for s in diar_segments}
    speaker_embeddings = {k: v for k, v in speaker_embeddings.items() if k in kept_speakers}

    # Merge with SRT if provided
    if srt_path and os.path.exists(srt_path):
        srt_segments = parse_srt(srt_path)
        merged = assign_speakers(diar_segments, srt_segments)
        lines = []
        last = None
        for seg in merged:
            if seg["speaker"] != last:
                lines.append(f"\n{seg['speaker']}:")
                last = seg["speaker"]
            lines.append(f"  {seg['text']}")
        text = "\n".join(lines).strip()
    else:
        merged = diar_segments
        text = ""

    return {
        "speakers": sorted(kept_speakers),
        "speaker_count": len(kept_speakers),
        "segments": merged,
        "text": text,
        "embeddings": speaker_embeddings,
        "auto_named": auto_named,
    }


def parse_srt(srt_path):
    import re
    with open(srt_path) as f:
        content = f.read()
    blocks = re.split(r"\n\n+", content.strip())
    segments = []
    for block in blocks:
        lines = block.strip().split("\n")
        ts_line = next((l for l in lines if "-->" in l), None)
        if not ts_line:
            continue
        ts_line = ts_line.replace(",", ".").strip("[] ")
        match = re.match(r"(\d+):(\d+):([\d.]+)\s*-->\s*(\d+):(\d+):([\d.]+)", ts_line)
        if not match:
            continue
        start = int(match[1]) * 3600 + int(match[2]) * 60 + float(match[3])
        end = int(match[4]) * 3600 + int(match[5]) * 60 + float(match[6])
        found_ts = False
        text_parts = []
        for l in lines:
            if "-->" in l:
                found_ts = True
                continue
            if found_ts:
                text_parts.append(l.strip())
        text = " ".join(text_parts).strip()
        if text:
            segments.append({"start": start, "end": end, "text": text})
    return segments


def assign_speakers(diar_segs, srt_segs):
    result = []
    for seg in srt_segs:
        mid = (seg["start"] + seg["end"]) / 2
        best_speaker = None
        best_overlap = 0
        for d in diar_segs:
            ov = max(0, min(seg["end"], d["end"]) - max(seg["start"], d["start"]))
            if ov > best_overlap:
                best_overlap = ov
                best_speaker = d["speaker"]
        # Fallback 1: midpoint inside a diarization segment
        if not best_speaker:
            for d in diar_segs:
                if d["start"] <= mid <= d["end"]:
                    best_speaker = d["speaker"]
                    break
        # Fallback 2: nearest diarization segment by time distance.
        # Eliminates "Speaker ?" — pyannote had a small gap but someone WAS talking.
        if not best_speaker and diar_segs:
            nearest = min(diar_segs, key=lambda d: min(abs(d["start"] - mid), abs(d["end"] - mid)))
            best_speaker = nearest["speaker"]
        result.append({"speaker": best_speaker or "Speaker ?", "start": seg["start"], "end": seg["end"], "text": seg["text"]})
    return result


# --- Full processing (transcribe first, then diarize with SRT) ---
def process_full(wav_path, language="auto", do_diarize=False, min_speakers=None, max_speakers=None):
    results = {}

    # Step 1: Transcribe (fast on GPU, ~5s)
    try:
        results["transcribe"] = transcribe(wav_path, language)
    except Exception as e:
        results["transcribe"] = {"error": str(e)}

    # Step 2: Diarize with SRT for speaker-text merge (slower, ~25s on CPU)
    if do_diarize and "error" not in results.get("transcribe", {}):
        try:
            srt_path = results["transcribe"].get("srt_path")
            results["diarize"] = diarize(wav_path, srt_path, min_speakers, max_speakers)
        except Exception as e:
            results["diarize"] = {"error": str(e)}

    return results


# --- Channel-based diarization (the killer feature) ---
# Input is a stereo WAV where L=mic (you) and R=system (other party).
# We split, transcribe each independently, run pyannote ONLY on system
# (your mic is always you = "Me"), then merge timelines and flag overlaps.
#
# PERFORMANCE ARCHITECTURE (optimized):
#
#   split_stereo ──┬──► mic.wav ──► whisper(mic) ──► "Me" segments     ← CPU
#                  │                                                     (sequential,
#                  └──► sys.wav ──► whisper(sys) ──► sys SRT             whisper not
#                         │                            │                 thread-safe)
#                         │                            ▼
#                         └──► pyannote(sys) ─────► assign_speakers     ← GPU
#                              (PARALLEL with           │                (runs at the
#                               whisper above)          ▼                same time as
#                                                  sys segments          whisper!)
#
#   Total time ≈ max(whisper_mic + whisper_sys, pyannote_sys) instead of
#                    whisper_mic + whisper_sys + pyannote_sys
#
#   On a GTX 1650: pyannote ~5s GPU, whisper ~10s CPU × 2 = ~20s
#   Old: 20 + 5 = 25s.  New: max(20, 5) = 20s.  Saves ~5s.
#   On bigger recordings: pyannote scales to 15-25s, savings grow to 10-20s.

def split_stereo(wav_path):
    """Split a stereo WAV into two mono WAVs in ONE ffmpeg call (reads input once).
    Returns (mic_path, sys_path, mic_has_audio, sys_has_audio)."""
    base = wav_path.rsplit(".", 1)[0]
    mic_path = f"{base}-mic.wav"
    sys_path = f"{base}-sys.wav"
    # Single ffmpeg call: split + volumedetect on both channels simultaneously.
    # Reads the input WAV once, writes two outputs + prints volume stats to stderr.
    proc = subprocess.run(
        [
            "ffmpeg", "-y", "-loglevel", "info",
            "-i", wav_path,
            "-filter_complex",
            "[0:a]pan=mono|c0=c0,volumedetect[micout];"
            "[0:a]pan=mono|c0=c1,volumedetect[sysout]",
            "-map", "[micout]", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", mic_path,
            "-map", "[sysout]", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", sys_path,
        ],
        capture_output=True, text=True,
    )
    # Parse per-channel volume from stderr to detect silent channels.
    # CRITICAL: volumedetect prints its summary at filter-CLOSE time, and that order is
    # NOT the filtergraph order (it routinely comes out reversed). So we must NOT assume
    # the first "mean_volume" line is the mic — doing that swapped mic/sys and made heed
    # skip the channel that actually had speech (empty transcripts). Each line is tagged
    # [Parsed_volumedetect_N]; micout is declared before sysout, so it always gets the
    # LOWER N. We map by N, not by print order. (Cross-platform bug — affects Linux too.)
    SILENCE_DB = -50.0
    mic_has = True
    sys_has = True
    measured = {}  # filter_index -> mean dB
    for line in proc.stderr.split("\n"):
        m = re.search(r"Parsed_volumedetect_(\d+).*mean_volume:\s*(-?[\d.]+)", line)
        if m:
            measured[int(m.group(1))] = float(m.group(2))
    if measured:
        order = sorted(measured)  # ascending filter index → [mic_idx, sys_idx]
        mic_has = measured[order[0]] > SILENCE_DB
        if len(order) > 1:
            sys_has = measured[order[1]] > SILENCE_DB

    return mic_path, sys_path, mic_has, sys_has


# process_dual was removed — replaced by _stream_dual in the Handler class
# and /api/finalize in the Bun server. The live transcription pipeline handles
# all dual-channel processing now.


# --- HTTP Server ---
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass  # suppress logs

    def _json(self, data, status=200):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        if self.path == "/health":
            self._json({
                "ready": all(models_ready.values()),
                "warm": models_warm,
                **models_ready,
                "whisper_info": whisper_runtime_info,
                "pyannote_info": pyannote_runtime_info,
                "live_tuning": live_tuning,
                "languages": _language_support(),
                "load_error": load_error,
            })
        elif self.path == "/voices":
            self._json({"voices": list(load_voices().keys())})
        elif self.path == "/hardware":
            self._json(get_hardware_info())
        else:
            self._json({"error": "not found"}, 404)

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length)) if length else {}

        if self.path == "/transcribe":
            if not models_ready["whisper"]:
                self._json({"error": "whisper not loaded"}, 503)
                return
            t = time.time()
            result = transcribe(
                body["wav_path"],
                body.get("language", "auto"),
                body.get("srt_output"),
            )
            result["time_ms"] = int((time.time() - t) * 1000)
            self._json(result)

        elif self.path == "/stream/start":
            # Open/reset the live streaming ASR session for a channel ("mic" | "sys").
            try:
                import engines
                ch = body.get("channel") or "mic"
                ok = engines.get_parakeet().stream_start(body.get("language") or "en", ch) if active_engine == "parakeet" else False
                _last_partial[ch] = ""  # fresh session → no stale gated text
                if ch == "mic":
                    _reset_apm()   # new recording → fresh AEC filter
                    _reset_echo()  # new recording → re-decide whether echo is present
                self._json({"ok": bool(ok)})
            except Exception as e:
                self._json({"ok": False, "error": str(e)[:120]}, 200)

        elif self.path == "/dedup":
            # Layer 3: strip foreign-speaker echo from a mic transcript using the system transcript.
            try:
                self._json({"ok": True, "text": dedup_echo(body.get("mic", ""), body.get("sys", ""))})
            except Exception as e:
                self._json({"ok": True, "text": body.get("mic", ""), "error": str(e)[:120]})

        elif self.path == "/stream/feed":
            # Append NEW audio → growing partial (stable prefix). Also assess audio quality.
            try:
                import engines
                ch = body.get("channel") or "mic"
                wav_path = body["wav_path"]
                ref = body.get("ref_wav_path")
                _aec_tmp = None
                if ch == "mic":
                    raw_rms, _peak = _wav_rms_peak(wav_path)
                    sys_rms = 0.0
                    aec_on = False
                    if ref:
                        sys_rms, _ = _wav_rms_peak(ref)
                        if AEC_MODE == "always":
                            aec_on = True
                        elif AEC_MODE == "adaptive":
                            aec_on = _echo_observe_and_decide(raw_rms, sys_rms)
                    # LAYER 2 — AEC (default off): cancel the system reference out of the mic.
                    if ref and aec_on:
                        cleaned = _aec_clean(wav_path, ref)
                        if cleaned != wav_path:
                            _aec_tmp = cleaned; wav_path = cleaned
                            _rms, _peak = _wav_rms_peak(wav_path)
                        else:
                            _rms = raw_rms
                    else:
                        _rms = raw_rms
                    # RELATIVE ECHO GATE (stable, no lag): gate the mic ONLY when the system is
                    # actively playing AND the mic is echo-level relative to it (mic << system).
                    # This kills the other voice leaking into the mic while you're listening, WITHOUT
                    # cutting your own speech when nothing is playing (the flaw of an absolute gate).
                    # Double-talk (you + them, mic hot) passes through and is cleaned by the stop dedup.
                    relative_echo = (ref and sys_rms > SYS_ACTIVE_RMS and raw_rms < ECHO_GATE_RATIO * sys_rms)
                    absolute_low = (_rms is not None and MIC_GATE_RMS > 0 and _rms < MIC_GATE_RMS)
                    # VOICE-RAG gate: the mic is currently a foreign voice (external TV / another person),
                    # not the owner → don't feed it, so it never enters the owner's transcript. Decided
                    # by /mic/filter (voice identity); default True (owner) so we never gate by mistake.
                    not_owner = (body.get("mic_is_owner", True) is False)
                    if relative_echo or absolute_low or not_owner:
                        partial = _last_partial.get(ch, "")
                    else:
                        partial = engines.get_parakeet().stream_feed(wav_path, ch) if active_engine == "parakeet" else ""
                        _last_partial[ch] = partial
                else:
                    # System channel: always transcribe (that's the other speaker), no AEC/gate.
                    _rms, _peak = _wav_rms_peak(wav_path)
                    partial = engines.get_parakeet().stream_feed(wav_path, ch) if active_engine == "parakeet" else ""
                if _aec_tmp:
                    try: os.remove(_aec_tmp)
                    except Exception: pass
                self._json({"ok": True, "partial": partial,
                            "quality": assess_audio_quality(partial, float(body.get("audio_s", 0) or 0), _peak)})
            except Exception as e:
                self._json({"ok": False, "error": str(e)[:120]}, 200)

        elif self.path == "/stream/finish":
            try:
                import engines
                ch = body.get("channel") or "mic"
                text = engines.get_parakeet().stream_finish(ch) if active_engine == "parakeet" else ""
                self._json({"ok": True, "text": text})
            except Exception as e:
                self._json({"ok": False, "error": str(e)[:120]}, 200)

        elif self.path == "/voices/repair":
            # Fix a corrupted saved voice: {"name": "...", "action": "delete"|"reset"}. delete removes
            # it; reset drops its averaging weight to 1 so the next clean recognition re-shapes it.
            try:
                voices = load_voices(); nm = body.get("name"); act = body.get("action", "reset")
                if nm not in voices:
                    self._json({"ok": False, "error": "no such voice"}, 200)
                elif act == "delete":
                    del voices[nm]; save_voices(voices); self._json({"ok": True, "deleted": nm})
                else:
                    voices[nm]["count"] = 1; save_voices(voices); self._json({"ok": True, "reset": nm})
            except Exception as e:
                self._json({"ok": False, "error": str(e)[:120]}, 200)

        elif self.path == "/voices/learn":
            # Refined auto-learn at STOP: strengthen the owner's voiceprint from clean mic audio
            # (mic voice while the system is silent). Fire-and-forget from server.ts after recording.
            try:
                res = learn_owner_voice(body.get("mic_path"), body.get("sys_path"))
                self._json({"ok": True, **res})
            except Exception as e:
                self._json({"ok": False, "error": str(e)[:120]}, 200)

        elif self.path in ("/diar/start", "/diar/feed", "/diar/finish", "/diar/live", "/mic/filter"):
            # Live diarization for the SYSTEM channel (/diar/live) and the MIC voice filter (/mic/filter,
            # keeps only the owner's voice, suppresses external TV/room audio the mic picks up). Both run
            # on the DEDICATED GPU sidecar so they never block ASR. /diar/feed (Sortformer) = rollback.
            try:
                import engines
                eng = engines.get_parakeet_diar() if active_engine == "parakeet" else None
                if eng is None:
                    self._json({"ok": False, "error": "no diarizer"}, 200)
                elif self.path == "/diar/start":
                    diar_live_reset()          # fresh session registry per recording (sys + mic)
                    self._json({"ok": True})
                elif self.path == "/diar/live":
                    d = eng.diarize(body["wav_path"])  # offline diarize on the window
                    res = _diar_session.feed(d.get("segments", []), d.get("embeddings", {}),
                                             window_s=body.get("window_s"))
                    self._json({"ok": True, **res})
                elif self.path == "/mic/filter":
                    d = eng.diarize(body["wav_path"])  # diarize the MIC window
                    res = _mic_session.classify(d.get("segments", []), d.get("embeddings", {}),
                                                window_s=body.get("window_s"))
                    self._json({"ok": True, **res})
                elif self.path == "/diar/finish":
                    self._json({"ok": True})  # owner learning happens at stop via /voices/learn
                elif self.path == "/diar/feed":
                    raw = eng.diar_feed(body["wav_path"])  # Sortformer streaming (rollback path only)
                    segs = _renumber_speakers(_filter_spurious_speakers([
                        {"start": float(s["start"]), "end": float(s["end"]), "speaker": str(s["speaker"])}
                        for s in raw
                    ]))
                    self._json({"ok": True, "segments": segs})
            except Exception as e:
                self._json({"ok": False, "error": str(e)[:120]}, 200)

        elif self.path == "/transcribe-live":
            # Live transcription using the auto-picked live model (non-parakeet chunk mode only).
            _ensure_whisper_live()  # parakeet boot skips Whisper; load on demand if this path is hit
            if not whisper_model_live:
                self._json({"error": "live whisper not loaded"}, 503)
                return
            # Energy gate: skip the engine only when the audio is silent EVERYWHERE. We scan the
            # WHOLE clip (strided for speed), not just the first 3s — in live "full" mode the window
            # can be long and start with silence (you press record, then speak), and checking only
            # the head wrongly dropped the entire window. Peak-based so a silent intro never hides
            # later speech.
            _peak = None
            try:
                import wave as _wave, struct as _struct
                with _wave.open(body["wav_path"]) as _wf:
                    _frames = _wf.readframes(_wf.getnframes())
                _samples = _struct.unpack('<' + 'h' * (len(_frames) // 2), _frames)
                _step = max(1, len(_samples) // 50000)  # cap work ~50k samples regardless of length
                _peak = max((abs(s) for s in _samples[::_step]), default=0)
                if _peak < 500:  # truly silent everywhere
                    self._json({"text": "", "language": "auto", "time_ms": 0, "skipped": "silence"})
                    return
            except Exception:
                pass  # if check fails, proceed with the engine
            t = time.time()
            lang = body.get("language", "auto")
            lang = None if lang == "auto" else lang
            with whisper_live_lock:
                segments_gen, info = whisper_model_live.transcribe(body["wav_path"], language=lang, **WHISPER_OPTS)
                segments_list = list(segments_gen)
            lines = []
            for seg in segments_list:
                text = seg.text.strip()
                if text and not is_degenerate_repetition(text):
                    lines.append(text)
            process_s = time.time() - t

            # RuntimeGovernor: observe how long THIS chunk took vs its audio length, and
            # self-correct — hot-swap to a lighter live model if we're falling behind under
            # contention, or recover toward the ceiling when there's headroom.
            gov_info = {}
            if live_governor is not None:
                audio_s = float(body.get("audio_s", 3.0)) or 3.0
                dec = live_governor.observe(audio_s, process_s)
                if dec.changed and dec.live_model != whisper_model_live_name:
                    _swap_live_model(dec.live_model)
                gov_info = {"live_model": whisper_model_live_name, "interval_ms": dec.interval_ms,
                            "changed": dec.changed, "reason": dec.reason}

            _live_text = " ".join(lines)
            self._json({
                "text": _live_text,
                "language": info.language if info else "auto",
                "model": whisper_model_live_name,
                "time_ms": int(process_s * 1000),
                "gov": gov_info,
                "quality": assess_audio_quality(_live_text, float(body.get("audio_s", 0) or 0), _peak),
            })

        elif self.path == "/diarize":
            if not models_ready["pyannote"]:
                self._json({"error": "pyannote not loaded"}, 503)
                return
            t = time.time()
            result = diarize(
                body["wav_path"],
                body.get("srt_path"),
                body.get("min_speakers"),
                body.get("max_speakers"),
                bool(body.get("recognize_only", False)),
            )
            result["time_ms"] = int((time.time() - t) * 1000)
            self._json(result)

        elif self.path == "/finalize":
            # Post-stop: full re-transcription with real timestamps + diarization + mic echo removal.
            t = time.time()
            try:
                result = finalize_recording(
                    body["wav_path"],
                    body.get("language", "auto"),
                    bool(body.get("dual", True)),
                )
            except Exception as e:
                self._json({"error": str(e)[:200], "turns": []}, 200)
                return
            result["time_ms"] = int((time.time() - t) * 1000)
            self._json(result)

        elif self.path == "/process-stream":
            # Streaming version: emits SSE events as whisper produces segments.
            # Frontend sees text from second 1 instead of waiting for the full pipeline.
            if not models_ready["whisper"] or not models_ready["pyannote"]:
                self._json({"error": "models not ready"}, 503)
                return

            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Connection", "keep-alive")
            self.end_headers()

            def sse(event, data):
                self.wfile.write(f"event: {event}\ndata: {json.dumps(data)}\n\n".encode())
                self.wfile.flush()

            try:
                t_start = time.time()
                wav_path = body["wav_path"]
                language = body.get("language", "auto")
                is_dual = body.get("dual_channel", False)

                if is_dual:
                    self._stream_dual(sse, wav_path, language, body.get("min_speakers"), body.get("max_speakers"))
                else:
                    # Non-dual: process_full and emit result at end
                    result = process_full(wav_path, language, body.get("diarize", False), body.get("min_speakers"), body.get("max_speakers"))
                    tx = result.get("transcribe", {})
                    diar = result.get("diarize", {})
                    for seg in diar.get("segments", []):
                        sse("segment", seg)
                    sse("speakers", {"speakers": diar.get("speakers", []), "embeddings": diar.get("embeddings", {})})
                    sse("done", {
                        "text": tx.get("text", ""),
                        "language": tx.get("language", language),
                        "model": tx.get("model", whisper_model_name),
                        "srt_path": tx.get("srt_path", ""),
                        "txt_path": tx.get("txt_path", ""),
                    })

                sse("complete", {"total_time_ms": int((time.time() - t_start) * 1000)})
            except Exception as e:
                sse("error", {"message": str(e)})

        elif self.path == "/voices/save":
            # body: { name: "Junior", embedding: [...], backend?: "wespeaker"|"pyannote" }
            name = body.get("name", "").strip()
            emb = body.get("embedding")
            if not name or not emb:
                self._json({"error": "name and embedding required"}, 400)
                return
            # The embedding came from the active diarizer, so tag it with that backend
            # (the client doesn't need to know which embedding space it's in).
            backend = body.get("backend") or current_backend()
            total = save_voice(name, emb, backend)
            self._json({"ok": True, "name": name, "total": total, "backend": backend})

        elif self.path == "/voices/delete":
            name = body.get("name", "").strip()
            voices = load_voices()
            if name in voices:
                del voices[name]
                save_voices(voices)
            self._json({"ok": True})

        else:
            self._json({"error": "not found"}, 404)

    def _stream_dual(self, sse, wav_path, language, min_speakers, max_speakers):
        """Stream dual-channel processing with progressive segment emission."""
        _ensure_whisper()  # file-upload path: load Whisper on demand (parakeet boot skipped it)
        mic_path, sys_path, mic_has, sys_has = split_stereo(wav_path)

        # Launch pyannote on GPU immediately (parallel with whisper)
        pyannote_future = None
        if sys_has:
            pyannote_future = ThreadPoolExecutor(max_workers=1).submit(
                diarize, sys_path, None, min_speakers, max_speakers
            )

        sse("phase", {"phase": "transcribing", "channel": "mic"})

        # Stream mic segments as they come from faster-whisper
        lang = None if language == "auto" else language
        mic_srt_lines = []
        mic_segments_raw = []
        mic_info = None
        if mic_has:
            segments_gen, mic_info = whisper_model.transcribe(mic_path, language=lang, **WHISPER_OPTS)
            for idx, seg in enumerate(segments_gen, 1):
                text = seg.text.strip()
                if not text or is_degenerate_repetition(text):
                    continue
                segment_data = {
                    "speaker": "Me",
                    "start": round(seg.start, 2),
                    "end": round(seg.end, 2),
                    "text": text,
                    "channel": "mic",
                }
                sse("segment", segment_data)
                mic_srt_lines.append(f"{idx}\n{format_ts(seg.start)} --> {format_ts(seg.end)}\n{text}\n")
                mic_segments_raw.append(segment_data)

        sse("phase", {"phase": "transcribing", "channel": "sys"})

        # Stream sys segments (speaker = "???" until pyannote finishes)
        sys_srt_lines = []
        sys_raw_segs = []
        sys_info = None
        if sys_has:
            segments_gen, sys_info = whisper_model.transcribe(sys_path, language=lang, **WHISPER_OPTS)
            for idx, seg in enumerate(segments_gen, 1):
                text = seg.text.strip()
                if not text or is_degenerate_repetition(text):
                    continue
                segment_data = {
                    "speaker": "???",
                    "start": round(seg.start, 2),
                    "end": round(seg.end, 2),
                    "text": text,
                    "channel": "sys",
                }
                sse("segment", segment_data)
                sys_srt_lines.append(f"{idx}\n{format_ts(seg.start)} --> {format_ts(seg.end)}\n{text}\n")
                sys_raw_segs.append({"start": round(seg.start, 2), "end": round(seg.end, 2), "text": text})

        # Write SRT files
        mic_srt_path = mic_path + ".srt"
        with open(mic_srt_path, "w") as f:
            f.write("\n".join(mic_srt_lines))
        sys_srt_path = sys_path + ".srt"
        with open(sys_srt_path, "w") as f:
            f.write("\n".join(sys_srt_lines))

        # Wait for pyannote (been running on GPU this whole time)
        sse("phase", {"phase": "identifying_speakers"})

        speakers_list = []
        embeddings = {}
        final_sys_segments = []
        if pyannote_future:
            try:
                raw_diar = pyannote_future.result(timeout=300)
                diar_segs = raw_diar.get("segments", [])
                speakers_list = raw_diar.get("speakers", [])
                embeddings = raw_diar.get("embeddings", {})
                if sys_raw_segs and diar_segs:
                    merged = assign_speakers(diar_segs, sys_raw_segs)
                    for s in merged:
                        final_sys_segments.append({
                            "speaker": s["speaker"],
                            "start": s["start"],
                            "end": s["end"],
                            "text": s.get("text", ""),
                            "channel": "sys",
                        })
            except Exception as e:
                print(f"[heed] stream diarize failed: {e}", flush=True)

        if sys_has and not final_sys_segments and sys_raw_segs:
            for s in sys_raw_segs:
                final_sys_segments.append({
                    "speaker": "Speaker 1", "start": s["start"],
                    "end": s["end"], "text": s["text"], "channel": "sys",
                })
            speakers_list = ["Speaker 1"]

        all_speakers = []
        if mic_segments_raw:
            all_speakers.append("Me")
        all_speakers.extend(speakers_list)
        seen = set()
        all_speakers = [s for s in all_speakers if not (s in seen or seen.add(s))]
        all_segments = sorted(mic_segments_raw + final_sys_segments, key=lambda s: s["start"])

        sse("speakers", {
            "speakers": all_speakers,
            "segments": all_segments,
            "embeddings": embeddings,
        })

        plain_text = "\n".join(seg["text"] for seg in all_segments if seg.get("text"))
        detected_lang = language
        if mic_has and mic_info:
            detected_lang = mic_info.language
        elif sys_has and sys_info:
            detected_lang = sys_info.language
        sse("done", {
            "text": plain_text,
            "language": detected_lang,
            "model": whisper_model_name,
            "srt_path": sys_srt_path or mic_srt_path,
            "txt_path": "",
            "files": {"wav": wav_path, "srt": sys_srt_path or mic_srt_path, "txt": ""},
        })


def _load_models_guarded():
    """Run load_models but NEVER let the loader thread die silently. On a fatal failure, record an
    actionable reason in `load_error` (exposed by /health) so the UI and `doctor` can guide the user
    instead of leaving them staring at a permanent 'ready:false'."""
    global load_error
    try:
        load_models()
    except Exception as e:
        import traceback
        msg = str(e)
        if any(s in msg for s in ("no whisper model could be loaded", "faster_whisper", "No module named")):
            load_error = ("No transcription engine is available. On Apple Silicon build the Parakeet "
                          "sidecar (needs Xcode: run `xcode-select --install` then `npx create-heed`), "
                          "or install the fallback engine: `npx create-heed fallback`.")
        else:
            load_error = f"Model loading failed: {msg[:200]}"
        print(f"[heed] FATAL load_models: {msg}", flush=True)
        traceback.print_exc()


if __name__ == "__main__":
    # Load models in background
    loader = threading.Thread(target=_load_models_guarded, daemon=True)
    loader.start()

    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"[heed] Transcription server on :{PORT}", flush=True)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.shutdown()
