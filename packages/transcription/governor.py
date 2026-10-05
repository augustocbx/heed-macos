"""RuntimeGovernor — closed-loop watchdog that keeps the LIVE preview responsive under REAL load.

ModelPolicy picks an initial live model from measured capability, but real recording-time
contention (the recorder + ffmpeg + the OS all competing) can make that pick too slow — exactly
the 8-15s-per-chunk regression we hit. The estimate can't see contention; only the running system
can. So the governor watches the ACTUAL per-chunk processing time and self-corrects:

  - falling behind (process time approaches the chunk length)  -> DOWNGRADE (smaller model;
    once at the floor, lengthen the interval to give it breathing room)
  - steady headroom (processing far faster than real-time)     -> UPGRADE back toward the ceiling

Hysteresis (require a sustained window of samples before acting) prevents thrashing on a single
slow blip. Pure + stateful and engine-agnostic: feed it (audio_s, process_s) per chunk, it returns
a Decision; the server wires the timings in and applies the recommended model/interval. This is the
"never collapses, self-heals" guarantee — independent of which model the policy picked.
"""
from collections import deque
from dataclasses import dataclass

# Ascending compute order. The governor moves within [floor, ceiling].
TIERS = ["tiny", "base", "small", "medium", "large-v3"]


@dataclass
class Decision:
    live_model: str
    interval_ms: int
    changed: bool
    reason: str


class RuntimeGovernor:
    def __init__(self, start_model="small", ceiling=None, floor="base",
                 base_interval_ms=2000, max_interval_ms=8000,
                 healthy_ratio=0.40, slow_ratio=0.80, window=3):
        # ratio = process_s / audio_s of a chunk. <healthy = lots of headroom; >slow = behind.
        self.model = start_model if start_model in TIERS else "small"
        self.ceiling = ceiling if (ceiling in TIERS) else self.model
        self.floor = floor if floor in TIERS else "base"
        self.base_interval_ms = base_interval_ms
        self.interval_ms = base_interval_ms
        self.max_interval_ms = max_interval_ms
        self.healthy_ratio = healthy_ratio
        self.slow_ratio = slow_ratio
        self.window = window
        self.samples = deque(maxlen=window)

    def observe(self, audio_s: float, process_s: float) -> Decision:
        ratio = process_s / max(audio_s, 0.01)
        self.samples.append(ratio)
        changed = False
        reason = f"ratio={ratio:.2f} (model={self.model})"

        if len(self.samples) >= self.window:
            avg = sum(self.samples) / len(self.samples)
            if avg > self.slow_ratio:
                changed = self._downgrade()
                reason = f"sustained SLOW (avg {avg:.2f} > {self.slow_ratio}) -> model={self.model}, interval={self.interval_ms}ms"
                self.samples.clear()
            elif avg < self.healthy_ratio:
                changed = self._recover()
                if changed:
                    reason = f"sustained HEADROOM (avg {avg:.2f} < {self.healthy_ratio}) -> model={self.model}, interval={self.interval_ms}ms"
                    self.samples.clear()

        return Decision(self.model, self.interval_ms, changed, reason)

    def _downgrade(self) -> bool:
        i, floor_i = TIERS.index(self.model), TIERS.index(self.floor)
        if i > floor_i:
            self.model = TIERS[i - 1]
            return True
        # Already at the floor model — buy time by lengthening the interval instead.
        if self.interval_ms < self.max_interval_ms:
            self.interval_ms = min(self.interval_ms + 1000, self.max_interval_ms)
            return True
        return False

    def _recover(self) -> bool:
        # First give back any extra interval, THEN step the model up — but never past the ceiling.
        if self.interval_ms > self.base_interval_ms:
            self.interval_ms = max(self.interval_ms - 1000, self.base_interval_ms)
            return True
        i, ceil_i = TIERS.index(self.model), TIERS.index(self.ceiling)
        if i < ceil_i:
            self.model = TIERS[i + 1]
            return True
        return False


if __name__ == "__main__":
    # Self-test: simulate a 3s-chunk live stream and watch the governor self-correct.
    def run(label, gov, ratios):
        print(f"\n=== {label} (start={gov.model}, ceiling={gov.ceiling}) ===")
        for r in ratios:
            d = gov.observe(3.0, 3.0 * r)  # audio 3s, process = ratio*3s
            flag = "  <-- CHANGED" if d.changed else ""
            print(f"  chunk ratio={r:.2f} -> model={d.live_model}, interval={d.interval_ms}ms{flag}")

    # 1) contention hits (the 8-15s regression): ratios spike -> should downgrade small->base
    g = RuntimeGovernor(start_model="small", ceiling="small")
    run("contention spike", g, [0.1, 0.1, 2.8, 2.8, 2.8, 2.8, 2.8, 2.8])

    # 2) recovery: after downgrading, load clears -> ratios drop -> step back up to ceiling
    run("then recovery", g, [0.1, 0.1, 0.1, 0.1, 0.1, 0.1])
