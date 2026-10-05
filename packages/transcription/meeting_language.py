"""Bounded acoustic English/Portuguese detection, isolated from resident live models.

The worker exits before final ASR begins, releasing its tiny Whisper model and Metal memory.
It samples the beginning, middle and end rather than trusting a silent meeting introduction.
"""
import json
import os
import subprocess
import sys
import wave

MODEL = "mlx-community/whisper-tiny-mlx"


def choose_language(probabilities):
    if not probabilities:
        return {"language": "en", "confidence": 0.0, "samples": 0}
    scores = {language: sum(float(p.get(language, 0)) for p in probabilities)
              for language in ("en", "pt")}
    language = max(scores, key=scores.get)
    total = sum(scores.values())
    return {"language": language, "confidence": scores[language] / total if total else 0.0,
            "samples": len(probabilities)}


def detect_meeting_language(wav_path):
    result = subprocess.run([sys.executable, os.path.abspath(__file__), "detect", wav_path],
                            capture_output=True, text=True, timeout=180, check=True)
    detection = json.loads(result.stdout.strip().splitlines()[-1])
    if detection.get("language") not in ("en", "pt"):
        raise ValueError("Language detector returned an unsupported meeting language")
    return detection


def worker(wav_path=None):
    import numpy as np
    import mlx.core as mx
    from mlx_whisper.load_models import load_model
    from mlx_whisper.audio import log_mel_spectrogram, pad_or_trim
    model = load_model(MODEL, dtype=mx.float16)
    mx.eval(model.parameters())
    if wav_path is None:
        # Download and compile the lightweight live model too, without keeping it resident.
        import mlx_whisper
        clip = os.path.join(os.path.dirname(__file__), "assets", "bench_sample.wav")
        mlx_whisper.transcribe(clip, path_or_hf_repo="mlx-community/whisper-base-mlx", language="en")
        return {"model": MODEL, "live_model": "base", "ready": True}
    with wave.open(wav_path, "rb") as source:
        duration = source.getnframes() / source.getframerate()
        channels = source.getnchannels()
    offsets = sorted(set([0.0, max(0.0, duration / 2 - 15), max(0.0, duration - 30)]))
    probabilities = []
    for offset in offsets:
        # Vote from each capture channel independently: downmixing opposite-phase samples can
        # erase otherwise audible speech. Native recordings contain mic and system channels.
        for channel in range(min(channels, 2)):
            raw = subprocess.run(["ffmpeg", "-v", "error", "-ss", str(offset), "-i", wav_path,
                                  "-t", "30", "-af", f"pan=mono|c0=c{channel}", "-ar", "16000",
                                  "-f", "f32le", "pipe:1"],
                                 capture_output=True, check=True, timeout=45).stdout
            audio = np.frombuffer(raw, dtype=np.float32)
            if audio.size == 0 or float(np.sqrt(np.mean(audio ** 2))) < 0.001:
                continue
            mel = log_mel_spectrogram(pad_or_trim(mx.array(audio)), n_mels=model.dims.n_mels)
            _, probability = model.detect_language(mel)
            probabilities.append(probability)
    return choose_language(probabilities)


if __name__ == "__main__":
    if sys.argv[1:] == ["warmup"]:
        print(json.dumps(worker()))
    elif len(sys.argv) == 3 and sys.argv[1] == "detect":
        print(json.dumps(worker(sys.argv[2])))
    else:
        raise SystemExit("Usage: meeting_language.py warmup | detect AUDIO.wav")
