"""Characterization tests for the PURE diarization + voice-memory logic (Feathers: pin current
behavior before any future change). Runs headless in ~0.1s — transcription_server.py imports only
stdlib at module level (torch/engines are lazy inside load_models), so we import it directly and
exercise the pure functions. Voice-store IO is redirected to a temp file (no touching ~/.heed-app).

Run: `python3 diarize_voice_test.py` (mirrors the policy.py/governor.py self-test convention).
"""
import importlib.util
import os
import tempfile


def _load():
    spec = importlib.util.spec_from_file_location("ts", os.path.join(os.path.dirname(__file__), "transcription_server.py"))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def run():
    ts = _load()
    passed = 0

    def check(name, cond):
        nonlocal passed
        assert cond, f"FAIL: {name}"
        passed += 1
        print(f"  [OK] {name}")

    # --- cosine_similarity ---
    check("cosine identical = 1", abs(ts.cosine_similarity([1, 0, 0], [1, 0, 0]) - 1.0) < 1e-9)
    check("cosine orthogonal = 0", abs(ts.cosine_similarity([1, 0], [0, 1])) < 1e-9)
    check("cosine zero-vector safe", ts.cosine_similarity([0, 0], [1, 1]) == 0)

    # --- _filter_spurious_speakers: a tiny phantom (<3s and <12%) gets reassigned to a real one ---
    segs = [
        {"start": 0.0, "end": 20.0, "speaker": "A"},
        {"start": 20.0, "end": 40.0, "speaker": "B"},
        {"start": 40.0, "end": 41.0, "speaker": "C"},  # phantom: 1s, ~2.4%
    ]
    out = ts._filter_spurious_speakers([dict(s) for s in segs])
    kept = {s["speaker"] for s in out}
    check("phantom speaker C dropped", "C" not in kept)
    check("real speakers A,B kept", {"A", "B"} <= kept)
    check("no text/segments lost", len(out) == len(segs))

    # single speaker is left untouched
    one = [{"start": 0, "end": 5, "speaker": "A"}]
    check("single speaker untouched", ts._filter_spurious_speakers([dict(s) for s in one]) == one)

    # --- _renumber_speakers: non-contiguous slot ids (0,2) → contiguous Speaker 1/2 in time order ---
    raw = [
        {"start": 0.0, "end": 2.0, "speaker": "2"},
        {"start": 2.0, "end": 4.0, "speaker": "0"},
        {"start": 4.0, "end": 6.0, "speaker": "2"},
    ]
    rn = ts._renumber_speakers(raw)
    labels = [s["speaker"] for s in sorted(rn, key=lambda x: x["start"])]
    check("renumber first-appearance order", labels == ["Speaker 1", "Speaker 2", "Speaker 1"])

    # --- _normalize_voice_entry: legacy bare-list embedding → tagged pyannote entry ---
    legacy = ts._normalize_voice_entry([0.1, 0.2, 0.3])
    check("legacy list → pyannote backend", legacy["backend"] == "pyannote" and legacy["dim"] == 3)
    tagged = {"embedding": [1.0], "backend": "wespeaker", "dim": 1, "count": 1}
    check("already-tagged entry preserved", ts._normalize_voice_entry(tagged) == tagged)

    # --- match_voice + save_voice + update_voice against a temp voices.json (IO redirected) ---
    with tempfile.TemporaryDirectory() as d:
        ts.VOICES_PATH = os.path.join(d, "voices.json")
        # save a wespeaker voice
        ts.save_voice("Carlos", [1.0, 0.0, 0.0], "wespeaker")
        name, score = ts.match_voice([1.0, 0.0, 0.0], "wespeaker")
        check("match_voice finds same voice", name == "Carlos" and score > 0.99)
        # different backend must NOT cross-match (incompatible spaces)
        nmiss, _ = ts.match_voice([1.0, 0.0, 0.0], "pyannote")
        check("match_voice filters by backend", nmiss is None)
        # a clearly different vector below threshold → no match
        nlow, _ = ts.match_voice([0.0, 1.0, 0.0], "wespeaker")
        check("match_voice rejects different voice", nlow is None)
        # averaging bumps count + keeps it normalized
        ts.update_voice("Carlos", [0.0, 1.0, 0.0], "wespeaker")
        entry = ts.load_voices()["Carlos"]
        norm = sum(x * x for x in entry["embedding"]) ** 0.5
        check("update_voice bumps count", entry["count"] == 2)
        check("update_voice keeps unit norm", abs(norm - 1.0) < 1e-6)

    print(f"\n{passed} checks passed — diarization + voice logic pinned.")


if __name__ == "__main__":
    run()
