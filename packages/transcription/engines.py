"""Transcription engine abstraction — pick the FASTEST backend per hardware/OS.

  Apple Silicon  → Parakeet TDT v3    (FluidAudio, Apple Neural Engine — the fastest, the default)
                   MLX-Whisper is only a FALLBACK when the Parakeet sidecar isn't built.
  NVIDIA (CUDA)  → faster-whisper      (CTranslate2 on CUDA, float16)
  CPU-only       → faster-whisper      (CTranslate2 on CPU, int8)

Every adapter exposes the SAME interface as faster-whisper:
    transcribe(wav_path, language=None, **opts) -> (segments_iterable, info)
where each segment has .start/.end/.text and info has .language. This keeps the
rest of heed (live + final + dual-channel) unchanged — pure low-coupling swap.

Linux/Windows note: mlx is only importable on Apple Silicon, so the MLX path is
never selected elsewhere — the CUDA/CPU path (current behavior) is untouched.
"""
import sys
import platform
import os
import json
import wave
import subprocess
import threading


class _Seg:
    """Lightweight stand-in for faster-whisper's Segment (only fields heed uses)."""
    __slots__ = ("start", "end", "text")

    def __init__(self, start, end, text):
        self.start = start
        self.end = end
        self.text = text


class _Info:
    __slots__ = ("language",)

    def __init__(self, language):
        self.language = language


# Parakeet TDT v3 (FluidAudio) transcribes these 28 European languages and NO others —
# anything else silently falls back to English, so the UI must only offer these on Apple
# Silicon. Mirrors FluidAudio's `enum Language` (Shared/TokenLanguageFilter.swift).
# Parakeet has NO language auto-detection: without an explicit language it assumes English.
PARAKEET_LANGUAGES = [
    "en", "es", "fr", "de", "it", "pt", "ro", "nl", "da", "sv", "fi", "hu", "et", "lv",
    "lt", "mt", "pl", "cs", "sk", "sl", "hr", "bs", "ru", "uk", "be", "bg", "sr", "el",
]


def supported_languages(engine_kind):
    """Return (codes, supports_auto) for the active engine.
    Parakeet → its 28 langs, no auto-detect. Whisper (mlx/ctranslate2) → None (all) + auto."""
    if engine_kind == "parakeet":
        return PARAKEET_LANGUAGES, False
    return None, True  # None = the full Whisper list the client already has


def is_apple_silicon():
    return sys.platform == "darwin" and platform.machine() == "arm64"


def mlx_available():
    """True only on Apple Silicon WITH mlx-whisper installed."""
    if not is_apple_silicon():
        return False
    try:
        import mlx_whisper  # noqa: F401
        return True
    except Exception:
        return False


# Logical model name -> mlx-community HF repo (public, no token).
_MLX_REPOS = {
    "tiny": "mlx-community/whisper-tiny-mlx",
    "base": "mlx-community/whisper-base-mlx",
    "small": "mlx-community/whisper-small-mlx",
    "medium": "mlx-community/whisper-medium-mlx",
    # 4-bit large-v3: measured same accuracy as fp16 but ~1.5x faster and ~1/3 the memory
    # on Apple Silicon — lets more machines afford the most accurate tier.
    "large-v3": "mlx-community/whisper-large-v3-mlx-4bit",
}

# faster-whisper-specific kwargs that mlx_whisper.transcribe does not accept.
_MLX_DROP = {"vad_filter", "vad_parameters", "beam_size", "best_of", "compute_type", "device"}


class CTranslate2Engine:
    """faster-whisper (CTranslate2): excellent on CPU and NVIDIA/CUDA."""

    kind = "ctranslate2"

    def __init__(self, model_name, device="cpu", compute_type="int8"):
        from faster_whisper import WhisperModel
        self.model_name = model_name
        self.device = device
        self.compute_type = compute_type
        self.model = WhisperModel(model_name, device=device, compute_type=compute_type)

    def transcribe(self, wav_path, language=None, **opts):
        # Already returns (generator, info) with .start/.end/.text and info.language.
        return self.model.transcribe(wav_path, language=language, **opts)


class MLXEngine:
    """mlx-whisper: runs Whisper on the Apple GPU (Metal) using unified memory."""

    kind = "mlx"

    def __init__(self, model_name):
        import mlx_whisper
        self._mlx = mlx_whisper
        self.model_name = model_name
        self.repo = _MLX_REPOS.get(model_name, _MLX_REPOS["small"])

    def transcribe(self, wav_path, language=None, **opts):
        kwargs = {k: v for k, v in opts.items() if k not in _MLX_DROP}
        r = self._mlx.transcribe(wav_path, path_or_hf_repo=self.repo, language=language, **kwargs)
        segs = [
            _Seg(s.get("start", 0.0), s.get("end", 0.0), s.get("text", ""))
            for s in r.get("segments", [])
        ]
        return iter(segs), _Info(r.get("language", language))


# --- Parakeet / FluidAudio sidecar (Apple Silicon only) ---------------------------------
# A resident Swift process (packages/transcription/native/heed-parakeet) runs Parakeet ASR on
# the Apple Neural Engine — far faster than Whisper. heed talks to it over newline-delimited
# JSON on stdin/stdout. Only used when its binary has been built (Apple Silicon).
_SIDECAR_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "native", "heed-parakeet")
_SIDECAR_BIN = os.path.join(_SIDECAR_DIR, ".build", "release", "heed-parakeet")
_parakeet_singleton = None
_parakeet_diar_singleton = None
_parakeet_lock = threading.Lock()


def parakeet_available():
    """True on Apple Silicon when the sidecar binary has been built."""
    return is_apple_silicon() and os.path.exists(_SIDECAR_BIN)


def _wav_duration(path):
    try:
        with wave.open(path) as w:
            return w.getnframes() / float(w.getframerate() or 16000)
    except Exception:
        return 0.0


class ParakeetEngine:
    """Talks to the resident Swift sidecar. One model for all languages/tiers, so `model_name`
    is ignored. Same interface as the Whisper engines: transcribe() -> (segments_iter, info)."""

    kind = "parakeet"

    def __init__(self, role="all", diar_cu=None):
        # role: "asr" (transcription, ANE) | "diar" (diarization, GPU) | "all" (both, single process).
        # Splitting ASR and diarization into two processes on different compute units lets them run
        # TRULY in parallel — the diarizer never blocks the transcriber (measured: +2ms contention).
        env = dict(os.environ, HEED_ROLE=role)
        if diar_cu:
            env["HEED_DIAR_CU"] = diar_cu
        self.role = role
        self.proc = subprocess.Popen(
            [_SIDECAR_BIN], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, text=True, bufsize=1, env=env,
        )
        self.lock = threading.Lock()
        self.proc.stdout.readline()  # consume the {"ready":...} line

    def _request(self, obj, timeout_lines=200):
        with self.lock:
            self.proc.stdin.write(json.dumps(obj) + "\n")
            self.proc.stdin.flush()
            # CoreML/ANE can print noisy "E5RT ..." lines to STDOUT during model load/inference,
            # polluting the JSON protocol. Be robust: skip non-JSON lines and parse from the first
            # "{" on a line (the E5RT text has no brace and gets prepended to the response line).
            for _ in range(timeout_lines):
                line = self.proc.stdout.readline()
                if not line:
                    return {"ok": False, "error": "sidecar closed"}
                i = line.find("{")
                if i < 0:
                    continue
                try:
                    return json.loads(line[i:])
                except Exception:
                    continue
            return {"ok": False, "error": "bad sidecar response"}

    def transcribe(self, wav_path, language=None, **opts):
        lang = language if language else "auto"
        r = self._request({"cmd": "transcribe", "wav": wav_path, "language": lang})
        text = (r.get("text", "") if r.get("ok") else "").strip()
        segs = [_Seg(0.0, _wav_duration(wav_path), text)] if text else []
        return iter(segs), _Info(language or "auto")

    def transcribe_ts(self, wav_path, language=None):
        """Full transcription WITH per-token timestamps (for post-stop re-transcription). Returns
        {"text": str, "tokens": [{"t","s","e"}, ...]}. Uses the multilingual manager in the sidecar,
        which — unlike the fast English one-shot — exposes Parakeet TDT tokenTimings."""
        lang = language if language else "auto"
        # A long file can emit noisy E5RT lines before the (single) JSON response; give it headroom.
        r = self._request({"cmd": "transcribe-ts", "wav": wav_path, "language": lang}, timeout_lines=2000)
        if not r.get("ok"):
            return {"text": "", "tokens": []}
        return {"text": r.get("text", ""), "tokens": r.get("tokens", [])}

    def diarize(self, wav_path):
        """Speaker segments + per-speaker 256-dim voice embeddings via FluidAudio CoreML
        (no gated token). Apple Silicon only. Returns {"segments": [...], "embeddings": {sid: [...]}}."""
        r = self._request({"cmd": "diarize", "wav": wav_path})
        if not r.get("ok"):
            return {"segments": [], "embeddings": {}}
        return {"segments": r.get("segments", []), "embeddings": r.get("embeddings", {})}

    # --- Live streaming (Nemotron multilingual): real-time commit/partial, per channel ---
    def stream_start(self, language=None, channel="mic"):
        """Open/reset a streaming session for a channel ("mic" | "sys")."""
        return self._request({"cmd": "stream-start", "language": language or "en", "channel": channel}).get("ok", False)

    def stream_feed(self, wav_path, channel="mic"):
        """Append the NEW audio segment; returns the growing partial transcript (stable prefix)."""
        r = self._request({"cmd": "stream-feed", "wav": wav_path, "channel": channel})
        return r.get("partial", "") if r.get("ok") else ""

    def stream_finish(self, channel="mic"):
        """End the stream → final text (== what was on screen)."""
        r = self._request({"cmd": "stream-finish", "channel": channel})
        return r.get("text", "") if r.get("ok") else ""

    # --- Live streaming diarization (Sortformer): speakers in real time ---
    def diar_start(self):
        return self._request({"cmd": "diar-start"}).get("ok", False)

    def diar_feed(self, wav_path):
        """Append NEW audio → current finalized speaker timeline [{speaker,start,end}, ...]."""
        r = self._request({"cmd": "diar-feed", "wav": wav_path})
        return r.get("segments", []) if r.get("ok") else []

    def diar_finish(self):
        r = self._request({"cmd": "diar-finish"})
        return r.get("segments", []) if r.get("ok") else []


def tokens_to_segments(tokens, max_gap=0.7, max_dur=12.0):
    """Merge Parakeet subword tokens into sentence-ish segments with real timestamps.

    Parakeet TDT emits SentencePiece tokens where a LEADING SPACE marks a word start (e.g. " dé",
    "j", "ame" -> "déjame"). We first stitch tokens into words, then group words into segments,
    breaking on sentence-final punctuation, a pause longer than max_gap, or max_dur seconds.
    Returns [{"start": float, "end": float, "text": str}].
    """
    # 1) tokens -> words
    words = []
    for tk in tokens:
        t = tk.get("t", "")
        s = float(tk.get("s", 0.0))
        e = float(tk.get("e", 0.0))
        if t.startswith(" ") or not words:
            words.append({"start": s, "end": e, "text": t.strip()})
        else:
            words[-1]["text"] += t
            words[-1]["end"] = e
    words = [w for w in words if w["text"]]

    # 2) words -> segments
    segs = []
    cur = None
    for i, w in enumerate(words):
        if cur is None:
            cur = {"start": w["start"], "end": w["end"], "text": w["text"]}
        else:
            cur["text"] += " " + w["text"]
            cur["end"] = w["end"]
        ends_sentence = cur["text"][-1:] in ".?!…"
        too_long = (cur["end"] - cur["start"]) > max_dur
        next_gap = (words[i + 1]["start"] - w["end"]) if i + 1 < len(words) else 1e9
        if ends_sentence or too_long or next_gap > max_gap:
            segs.append(cur)
            cur = None
    if cur:
        segs.append(cur)
    return segs


def get_parakeet():
    """Lazy ASR sidecar (transcription/streaming, on the ANE). Diarization goes to get_parakeet_diar()
    so the two run on separate processes + compute units and never block each other."""
    global _parakeet_singleton
    with _parakeet_lock:
        if _parakeet_singleton is None:
            _parakeet_singleton = ParakeetEngine(role="asr")
        return _parakeet_singleton


def get_parakeet_diar():
    """Lazy DIARIZATION sidecar — a SECOND process pinned to GPU/Metal (HEED_DIAR_CU=gpu) so the
    diarizer runs in parallel with ASR on the ANE. Used for live /diar/live AND post-stop /diarize."""
    global _parakeet_diar_singleton
    with _parakeet_lock:
        if _parakeet_diar_singleton is None:
            _parakeet_diar_singleton = ParakeetEngine(role="diar", diar_cu="gpu")
        return _parakeet_diar_singleton


def _engine_override():
    """Explicit engine pick, precedence env > ~/.heed-app/overrides.json. Used by the fallback flow:
    when Parakeet is broken, `create-heed fallback` writes HEED_ENGINE=mlx so the server stops trying it."""
    val = os.environ.get("HEED_ENGINE")
    if not val:
        try:
            with open(os.path.join(os.path.expanduser("~"), ".heed-app", "overrides.json")) as f:
                val = json.load(f).get("engine")
        except Exception:
            val = None
    return val if val in ("parakeet", "mlx", "ctranslate2") else None


def select_engine_kind(device_cfg=None):
    """Apple Silicon with the Parakeet sidecar built → 'parakeet'; else mlx; else ctranslate2.
    An explicit override (HEED_ENGINE / overrides.json) wins when its engine is actually available."""
    override = _engine_override()
    if override == "parakeet" and parakeet_available():
        return "parakeet"
    if override == "mlx" and mlx_available():
        return "mlx"
    if override == "ctranslate2":
        return "ctranslate2"
    if parakeet_available():
        return "parakeet"
    if mlx_available():
        return "mlx"
    return "ctranslate2"


def make_engine(model_name, device_cfg):
    """Build the fastest engine for this machine running `model_name`."""
    kind = select_engine_kind(device_cfg)
    if kind == "parakeet":
        return get_parakeet()  # shared singleton; model_name ignored (Parakeet is one model)
    if kind == "mlx":
        return MLXEngine(model_name)
    device = device_cfg.get("whisper", "cpu")
    compute_type = "float16" if device == "cuda" else "int8"
    return CTranslate2Engine(model_name, device=device, compute_type=compute_type)
