"""ModelPolicy — a PURE function: measured Capabilities -> ModelPlan (which models to run).

This is the brain that makes heed "a marvel on any hardware". It never picks a fixed model;
it picks the LARGEST tier the machine can run while staying fast, leaving headroom so it
never collapses. Two ideas drive it:

  1. RTF targets per role. The FINAL pass runs once when you press stop, so it can be slower
     (target >= 3x real-time). The LIVE preview runs *during* recording, competing with the
     recorder + ffmpeg for CPU/GPU, so we demand a big margin (>= 15x idle) — that way even
     under 2-3x contention it still keeps up. (This is exactly the case that regressed before.)
  2. Memory budget. Use only ~55% of the memory pool minus a reserve for pyannote/Ollama/OS,
     so loading whisper never pushes the machine past ~80% and into swap/throttle.

Being a pure function (Capabilities in, ModelPlan out) makes it trivially testable: CI can feed
it a "weak laptop" or "GPU server" struct and assert the choice, without owning that hardware.
The RuntimeGovernor (separate module) corrects this initial pick live if reality disagrees.
"""
from dataclasses import dataclass

# Memory footprint per tier (MB). large-v3 is the 4-bit build (~1/3 of fp16).
TIER_MEM_MB = {"base": 200, "small": 600, "medium": 1600, "large-v3": 1200}
TIERS = ["base", "small", "medium", "large-v3"]

FINAL_MIN_RTF = 3.0    # final pass: comfortably beat real-time at stop
LIVE_MIN_RTF = 15.0    # live: big idle margin to survive recording-time contention
RESERVE_MB = 1800      # pyannote (~1.5GB) + safety headroom
POOL_FRACTION = 0.55   # never budget more than this share of the memory pool for whisper


@dataclass
class ModelPlan:
    final_model: str
    live_model: str
    engine: str
    reason: str


def _mem_pool_mb(caps) -> int:
    """The memory pool whisper competes in: VRAM on CUDA, unified RAM on Apple, RAM on CPU."""
    if caps.accelerator in ("apple_gpu", "cuda") and caps.total_vram_mb:
        return caps.total_vram_mb
    return caps.total_ram_mb


def _mem_cap(pool_mb: int, dedicated: bool) -> str:
    """Hard cap by memory class so low-mem machines never over-reach, even if RTF allows it.

    Dedicated VRAM (CUDA) is NOT shared with the OS/browser, so the same model fits in a
    smaller card than it would in unified memory — hence the lower, more generous thresholds.
    """
    if dedicated:  # CUDA: VRAM is ours alone
        if pool_mb >= 8000:
            return "large-v3"
        if pool_mb >= 5000:
            return "medium"
        if pool_mb >= 3500:
            return "small"
        return "base"
    # Unified (Apple) / system RAM (CPU): shared with everything, so demand more headroom.
    if pool_mb >= 16000:
        return "large-v3"
    if pool_mb >= 11000:
        return "medium"
    if pool_mb >= 7000:
        return "small"
    return "base"


def plan(caps) -> ModelPlan:
    pool = _mem_pool_mb(caps)
    dedicated = caps.accelerator == "cuda"
    # Dedicated VRAM isn't shared with the OS, so we can use almost all of it (minus the
    # pyannote reserve). Unified/CPU memory is shared, so take only ~55%.
    budget = max(0, (pool - RESERVE_MB) if dedicated else int(pool * POOL_FRACTION) - RESERVE_MB)
    cap_i = TIERS.index(_mem_cap(pool, dedicated))

    def largest(min_rtf: float, ceiling_i: int) -> str:
        chosen = "base"
        for i, tier in enumerate(TIERS):
            if i > ceiling_i:
                break
            fits_mem = TIER_MEM_MB[tier] <= budget if budget else (tier == "base")
            fast_enough = caps.estimated_rtf(tier) >= min_rtf
            # On CPU with no measured benchmark, fall back to base only (safe).
            if fits_mem and fast_enough:
                chosen = tier
        return chosen

    final_model = largest(FINAL_MIN_RTF, cap_i)
    # Live can't be bigger than final; demands a higher RTF margin.
    final_i = TIERS.index(final_model)
    live_model = largest(LIVE_MIN_RTF, final_i)

    reason = (
        f"final={final_model} (rtf~{caps.estimated_rtf(final_model):.1f}x), "
        f"live={live_model} (rtf~{caps.estimated_rtf(live_model):.1f}x) | "
        f"engine={caps.engine}, pool={pool}MB, budget={budget}MB, cap={_mem_cap(pool, dedicated)}"
    )
    return ModelPlan(final_model=final_model, live_model=live_model, engine=caps.engine, reason=reason)


def verify(plan: ModelPlan, caps, measured_final_rtf: float) -> ModelPlan:
    """Verify-the-pick: if MEASURING the chosen final model shows it can't keep up (the estimate
    was too optimistic), step the final down one tier so the user never gets a sluggish machine.
    Pure function — caller supplies the measured RTF. The estimate narrows; the measurement confirms.
    """
    if measured_final_rtf <= 0 or measured_final_rtf >= FINAL_MIN_RTF:
        return plan  # measurement failed (keep estimate) or the pick holds up
    fi = TIERS.index(plan.final_model)
    if fi == 0:
        return plan  # already the smallest; nothing safer to drop to
    new_final = TIERS[fi - 1]
    new_live = plan.live_model if TIERS.index(plan.live_model) <= fi - 1 else new_final
    reason = (f"{plan.reason} | VERIFIED: {plan.final_model} measured {measured_final_rtf:.1f}x "
              f"< {FINAL_MIN_RTF}x target -> stepped down to {new_final}")
    return ModelPlan(final_model=new_final, live_model=new_live, engine=plan.engine, reason=reason)


def decide(caps, measure_final_rtf=None) -> ModelPlan:
    """Full decision: estimate-based plan, then (optionally) verify the final pick by measuring it.

    `measure_final_rtf` is a callback (model_name -> rtf) so policy stays decoupled from how the
    measurement is done (capability.measure_model_rtf supplies it). Keeps this module pure/testable.
    """
    p = plan(caps)
    if measure_final_rtf is not None:
        p = verify(p, caps, measure_final_rtf(p.final_model))
    return p


if __name__ == "__main__":
    # Self-test across SIMULATED hardware — proves the policy adapts without owning the machines.
    from capability import Capabilities

    def make(name, **kw):
        base = dict(
            os="linux", arch="x86_64", cpu_count=8, total_ram_mb=16000,
            accelerator="cpu", gpu_name=None, total_vram_mb=0, engine="ctranslate2",
            bench_model="small", rtf=5.0, bench_ms=1000, measured=True, fingerprint="x",
        )
        base.update(kw)
        return name, Capabilities(**base)

    profiles = [
        make("M5 Air (this machine)", os="darwin", arch="arm64", cpu_count=10, total_ram_mb=16384,
             accelerator="apple_gpu", gpu_name="Apple Silicon (MPS)", total_vram_mb=16384,
             engine="mlx", rtf=32.8),
        make("Weak laptop (4c/8GB, CPU)", cpu_count=4, total_ram_mb=8000, rtf=2.0),
        make("Old laptop (2c/4GB, CPU)", cpu_count=2, total_ram_mb=4000, rtf=0.8),
        make("Linux + RTX 4090 (24GB)", accelerator="cuda", gpu_name="RTX 4090",
             total_vram_mb=24000, engine="ctranslate2", rtf=60.0),
        make("Linux + RTX 2080 (8GB, yours)", accelerator="cuda", gpu_name="RTX 2080",
             total_vram_mb=8000, engine="ctranslate2", rtf=35.0),
        make("Linux + GTX 1650 (4GB)", accelerator="cuda", gpu_name="GTX 1650",
             total_vram_mb=4000, engine="ctranslate2", rtf=12.0),
    ]
    print(f"{'profile':28} {'final':10} {'live':8} reason")
    for name, caps in profiles:
        p = plan(caps)
        print(f"{name:28} {p.final_model:10} {p.live_model:8} {p.reason}")
