"""CapabilityProbe — measure what THIS machine can ACTUALLY do, not what specs claim.

Why measure instead of trust specs? Specs lie: thermal throttling, weak drivers, a busy
CPU, or a laptop in low-power mode all make real performance diverge from "8 cores / 16GB".
So besides detecting hardware, we run a tiny REAL benchmark (transcribe a short sample on
the actual engine) and record the measured real-time factor (RTF = audio_seconds /
process_seconds; higher = faster). Everything downstream (ModelPolicy, RuntimeGovernor)
decides from MEASURED capability — that's how heed stays fast and never collapses on any
machine. The result is cached to ~/.heed-app/capabilities.json so we only measure when the
hardware fingerprint changes (or when `heed doctor --recheck` forces it).

This module is intentionally standalone (low coupling): it depends only on `engines` for the
benchmark and on ffmpeg to synthesize the sample. ModelPolicy consumes its output.
"""
import os
import sys
import json
import time
import platform
import subprocess
from dataclasses import dataclass, asdict, field

import engines

CACHE_PATH = os.path.join(os.path.expanduser("~"), ".heed-app", "capabilities.json")
CACHE_VERSION = 3  # v3: torchless Apple Silicon detection (invalidates caches from the torch-gated path)

# The benchmark transcribes with this reference model; other tiers are extrapolated from it.
BENCH_MODEL = "small"
# A bundled ~30s REAL-SPEECH clip (deterministic + representative). Whisper processes audio in
# 30s windows, so the sample must be ~30s of DISTINCT natural speech: a pure tone or a short/
# looped clip makes Whisper hallucinate and mis-measures speed. The bundled clip is a Public
# Domain LibriVox recording (see assets/bench_sample.SOURCE.txt). If it's ever missing we fall
# back to a synthesized tone just to avoid hard-failing (degraded but never crashes).
_DIR = os.path.dirname(os.path.abspath(__file__))
BUNDLED_SAMPLE = os.path.join(_DIR, "assets", "bench_sample.wav")
TONE_SECONDS = 8
BENCH_RUNS = 3  # median of N timed runs to kill cold-start / noise variance

# Relative compute cost per Whisper tier (normalized to `small`), refined from real M5 timings
# (small 914ms, medium 2473ms -> 2.7). Used to ESTIMATE each tier's RTF from the single measured
# reference, fast — the verify-the-pick step then MEASURES the chosen final model to confirm.
TIER_COST = {"tiny": 0.16, "base": 0.30, "small": 1.0, "medium": 2.8}
# large-v3 cost depends on the ENGINE's quantization: MLX ships 4-bit (light, ~3.6x small),
# CTranslate2 ships fp16/int8 (heavier, ~6x). Engine-aware so the estimate is right on BOTH
# Apple Silicon and Linux/CUDA. (Measured 4-bit on M5: 3329ms / 914ms ≈ 3.6.)
LARGE_COST = {"mlx": 3.6, "ctranslate2": 6.0}


@dataclass
class Capabilities:
    os: str                 # "darwin" | "linux" | "win32"
    arch: str               # "arm64" | "x86_64" | ...
    cpu_count: int
    total_ram_mb: int
    accelerator: str        # "apple_gpu" | "cuda" | "cpu"
    gpu_name: str | None
    total_vram_mb: int      # unified RAM on Apple, VRAM on CUDA, 0 on pure CPU
    engine: str             # "mlx" | "ctranslate2"
    bench_model: str        # model used for the measured benchmark
    rtf: float              # MEASURED real-time factor of bench_model (higher = faster)
    bench_ms: int           # how long the measured pass took
    measured: bool          # did the live measurement actually run?
    fingerprint: str        # hardware signature; cache invalidates when this changes
    cache_version: int = CACHE_VERSION

    def estimated_rtf(self, model_name: str) -> float:
        """Estimate a tier's RTF from the measured reference (cost scales ~with params).

        large-v3's cost is engine-aware (4-bit on MLX vs fp16 on CTranslate2) so the estimate
        is right on both Apple Silicon and Linux/CUDA.
        """
        if not self.rtf:
            return 0.0
        # Parakeet runs ONE model (TDT v3) regardless of the requested whisper tier, so its
        # speed doesn't scale with tier — the measured RTF applies to every tier as-is.
        if self.engine == "parakeet":
            return self.rtf
        ref = LARGE_COST.get(self.engine, 6.0) if self.bench_model == "large-v3" else TIER_COST.get(self.bench_model, 1.0)
        tgt = LARGE_COST.get(self.engine, 6.0) if model_name == "large-v3" else TIER_COST.get(model_name, 1.0)
        return self.rtf * (ref / tgt)


# ---- static detection ---------------------------------------------------------------

def _system_ram_mb() -> int:
    try:
        page = os.sysconf("SC_PAGE_SIZE")
        pages = os.sysconf("SC_PHYS_PAGES")
        if page and pages:
            return int((page * pages) // 1024 // 1024)
    except Exception:
        pass
    return 0


def _detect_accelerator():
    """Return (accelerator, gpu_name, total_vram_mb, engine)."""
    # Apple Silicon: detect WITHOUT torch. On Mac the engine is Parakeet on the ANE (Swift sidecar);
    # torch is only a Linux/CPU-fallback dep and a Mac-lite install has NONE. This MUST come before any
    # `import torch` or a torchless Mac misclassifies as plain CPU and picks the wrong engine.
    if engines.is_apple_silicon():
        ram = _system_ram_mb()
        # Engine pick (respects the HEED_ENGINE / overrides.json fallback): Parakeet on the ANE when its
        # sidecar is built, else MLX (Apple GPU), else CTranslate2 (CPU).
        engine = engines.select_engine_kind()
        return "apple_gpu", "Apple Silicon", ram, engine
    # non-Apple (Linux/Windows): torch probes CUDA; torchless → CPU.
    try:
        import torch
        if torch.cuda.is_available():
            _, total = torch.cuda.mem_get_info(0)
            return "cuda", torch.cuda.get_device_name(0), int(total // 1024 // 1024), "ctranslate2"
    except Exception:
        pass
    return "cpu", None, 0, "ctranslate2"


def detect_static() -> dict:
    accelerator, gpu_name, total_vram_mb, engine = _detect_accelerator()
    return {
        "os": sys.platform,
        "arch": platform.machine(),
        "cpu_count": os.cpu_count() or 0,
        "total_ram_mb": _system_ram_mb(),
        "accelerator": accelerator,
        "gpu_name": gpu_name,
        "total_vram_mb": total_vram_mb,
        "engine": engine,
    }


def _fingerprint(static: dict) -> str:
    return f"{static['os']}|{static['arch']}|{static['cpu_count']}|{static['total_ram_mb']}|{static['accelerator']}|{static['engine']}"


# ---- measured benchmark -------------------------------------------------------------

def _duration_s(path: str) -> float:
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
            capture_output=True, text=True,
        ).stdout.strip()
        return float(out) if out else 0.0
    except Exception:
        return 0.0


def _get_sample() -> tuple[str | None, float]:
    """Prefer the bundled real-speech clip; fall back to a synthesized tone so we never hard-fail."""
    if os.path.exists(BUNDLED_SAMPLE) and os.path.getsize(BUNDLED_SAMPLE) > 1000:
        return BUNDLED_SAMPLE, _duration_s(BUNDLED_SAMPLE)
    tone = os.path.join("/tmp", "heed_bench_tone.wav")
    try:
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi",
             "-i", f"sine=frequency=200:duration={TONE_SECONDS}",
             "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", tone],
            check=True,
        )
        return tone, float(TONE_SECONDS)
    except Exception:
        return None, 0.0


def measure_rtf(static: dict, model_name: str = BENCH_MODEL) -> tuple[float, int, bool]:
    """Warm-run, then median of BENCH_RUNS timed runs of `model_name` on the real engine.

    Returns (rtf, ms, ok). Works for any tier — the probe uses BENCH_MODEL (small) as the cheap
    reference; verify-the-pick uses it to MEASURE the chosen final model directly.
    """
    sample, dur = _get_sample()
    if not sample or dur <= 0:
        return 0.0, 0, False
    try:
        device_cfg = {
            "whisper": "cuda" if static["accelerator"] == "cuda" else "cpu",
            "gpu_name": static["gpu_name"] or "",
        }
        engine = engines.make_engine(model_name, device_cfg)
        list(engine.transcribe(sample, language="en")[0])  # warm (load + compile kernels)
        times = []
        for _ in range(BENCH_RUNS):
            t = time.time()
            list(engine.transcribe(sample, language="en")[0])
            times.append(time.time() - t)
        med = sorted(times)[len(times) // 2]  # median = robust to a slow outlier
        if med <= 0:
            return 0.0, 0, False
        return round(dur / med, 1), int(med * 1000), True
    except Exception:
        return 0.0, 0, False


def measure_model_rtf(model_name: str) -> float:
    """Measure the REAL RTF of one specific model on this machine (used by verify-the-pick)."""
    rtf, _, ok = measure_rtf(detect_static(), model_name)
    return rtf if ok else 0.0


# ---- public entry -------------------------------------------------------------------

def probe(use_cache: bool = True, log=print) -> Capabilities:
    """Detect + measure the machine. Cached by hardware fingerprint."""
    static = detect_static()
    fp = _fingerprint(static)

    if use_cache:
        cached = _load_cache()
        if cached and cached.get("fingerprint") == fp and cached.get("cache_version") == CACHE_VERSION:
            log(f"[heed] Capabilities (cached): {cached['accelerator']} {cached['engine']} "
                f"rtf({cached['bench_model']})={cached['rtf']}x")
            cached.pop("estimated_rtf", None)
            return Capabilities(**{k: cached[k] for k in Capabilities.__dataclass_fields__ if k in cached})

    log(f"[heed] Probing hardware: {static['accelerator']} ({static['engine']}), "
        f"{static['cpu_count']} cores, {static['total_ram_mb']}MB RAM — running benchmark...")
    rtf, ms, ok = measure_rtf(static)
    caps = Capabilities(
        **static, bench_model=BENCH_MODEL, rtf=rtf, bench_ms=ms, measured=ok, fingerprint=fp,
    )
    log(f"[heed] Measured: {BENCH_MODEL} runs at {rtf}x real-time ({ms}ms) "
        f"{'✓' if ok else '(benchmark failed — using conservative defaults)'}")
    _save_cache(caps)
    return caps


def _load_cache() -> dict | None:
    try:
        with open(CACHE_PATH) as f:
            return json.load(f)
    except Exception:
        return None


def _save_cache(caps: Capabilities) -> None:
    try:
        os.makedirs(os.path.dirname(CACHE_PATH), exist_ok=True)
        with open(CACHE_PATH, "w") as f:
            json.dump(asdict(caps), f, indent=2)
    except Exception:
        pass


if __name__ == "__main__":
    # Manual run: `python capability.py` (add --recheck to ignore cache).
    caps = probe(use_cache="--recheck" not in sys.argv)
    print(json.dumps(asdict(caps), indent=2))
    print("\nEstimated RTF per tier (audio_s / process_s):")
    for tier in ["tiny", "base", "small", "medium", "large-v3"]:
        print(f"  {tier:10} ~{caps.estimated_rtf(tier):.1f}x")
