"""Exclusively owned live Whisper process; closing it releases MLX's module model cache.

Use the same bounded transport and entrypoint shutdown registry as native engines.
Final models and native diarization are deliberately outside this process.
"""
import json
import os
import sys
from types import SimpleNamespace
from native_worker import NativeWorker, NATIVE_LIVE_TIMEOUT_SECONDS
from worker_lifecycle import worker_entrypoint


class PreviewWhisper:
    def __init__(self, model, kind, devices):
        self.worker = NativeWorker([sys.executable, "-u", os.path.abspath(__file__),
                                    model, kind, json.dumps(devices)])

    def transcribe(self, wav_path, language=None, **opts):
        result = self.worker.request({"wav_path":wav_path, "language":language, "opts":opts},
                                     timeout=NATIVE_LIVE_TIMEOUT_SECONDS)
        if result.get("ok") is not True:
            raise RuntimeError(result.get("error", "Preview transcription failed"))
        return iter(SimpleNamespace(**segment) for segment in result["segments"]), SimpleNamespace(language=result["language"])

    def close(self):
        self.worker.close()


def serve(model, kind, devices):
    import engines
    engine = engines.MLXEngine(model) if kind in ("mlx", "parakeet") else engines.CTranslate2Engine(
        model, device=devices.get("whisper", "cpu"), compute_type=devices.get("compute_type", "int8"))
    print(json.dumps({"ready":True}), flush=True)
    for line in sys.stdin:
        try:
            request = json.loads(line)
            segments, info = engine.transcribe(request["wav_path"], language=request.get("language"), **request.get("opts", {}))
            result = {"ok":True, "language":info.language,
                      "segments":[{"start":float(s.start), "end":float(s.end), "text":s.text} for s in segments]}
        except Exception as error:
            result = {"ok":False, "error":str(error)[:200]}
        print(json.dumps(result), flush=True)


if __name__ == "__main__":
    with worker_entrypoint():
        serve(sys.argv[1], sys.argv[2], json.loads(sys.argv[3]))
