"""An isolated complete-audio Whisper pass for an explicit manual model choice.

A subprocess prevents MLX's shared model cache from replacing the live preview model, and
releases all selected-model memory when the pass finishes.
"""
import json
import os
import subprocess
import sys

MODELS = ("base", "small", "medium", "large-v3")
LANGUAGES = ("en", "pt")


def transcribe_complete(wav_path, model, language, vocabulary=None):
    from vocabulary import validate_snapshot
    vocabulary = validate_snapshot(vocabulary)
    if model not in MODELS or language not in LANGUAGES:
        raise ValueError("Unsupported manual transcription model or language")
    env = dict(os.environ)
    # A user-selected model may be new to this Mac. Keep downloads in the normal local cache.
    env.pop("HF_HUB_OFFLINE", None)
    env.pop("TRANSFORMERS_OFFLINE", None)
    result = subprocess.run([sys.executable, os.path.abspath(__file__), wav_path, model, language, json.dumps(vocabulary)],
                            env=env, capture_output=True, text=True, timeout=3600, check=True)
    payload = json.loads(result.stdout.strip().splitlines()[-1])
    if not isinstance(payload.get("segments"), list):
        raise ValueError("Manual transcription worker returned invalid segments")
    return payload["segments"]


def worker(wav_path, model, language, vocabulary=None):
    from vocabulary import validate_snapshot, configuration, options
    vocabulary = validate_snapshot(vocabulary)
    import engines
    if model not in MODELS or language not in LANGUAGES:
        raise ValueError("Unsupported manual transcription model or language")
    if engines.is_apple_silicon():
        asr = engines.MLXEngine(model)
    else:
        asr = engines.CTranslate2Engine(model)
    segments, _ = asr.transcribe(wav_path, language=language, temperature=0.0,
                                 condition_on_previous_text=False, **options(configuration(vocabulary, asr.kind, model, language)))
    return {"segments": [{"start": float(s.start), "end": float(s.end), "text": s.text.strip()}
                         for s in segments if s.text.strip()]}


if __name__ == "__main__":
    if len(sys.argv) not in (4, 5):
        raise SystemExit("Usage: manual_transcription.py AUDIO.wav MODEL LANGUAGE")
    print(json.dumps(worker(*sys.argv[1:4], vocabulary=json.loads(sys.argv[4]) if len(sys.argv) == 5 else None)))
