# Heed real-time benchmark — live server with two sidecars

Historical upstream measurements on four recordings from Junior, using actual live server endpoints and separate ASR/diarization sidecars to reproduce `processStreamLive`. The evaluation target was accurate, fast, fully local live and post-stop processing.

## Scorecard: four recordings, seven real speakers

```text
recording            scenario        GT  live  phantom under flicker names
1782880963595        4-spk (man+girl)  2    2      0      0      0     Learn
1782873076439        3-spk             2    2      0      0      0     Learn
1782867599480        1-spk (girl)      1    1      0      0      0     Learn
1782864214513        2-spk ECHO        2    1      0      1      0     Learn

DIARIZATION: phantom = 0/7   flicker = 0   naming false positives = 0   under-count = 1
TEXT (feed): p50 = 15 ms    p95 = 18 ms   (while diarization runs in parallel)
DIAR /live:  p50 = 100 ms   p95 = 137 ms  (dedicated GPU sidecar)
```

## Accuracy

- No phantom speakers across seven real speakers in four recordings; the previously split speaker labels no longer flickered.
- No incorrect voice-name assignments. “Learn” was assigned only to the matching voice, at cosine similarity 0.93–0.98.
- The offline diarization engine's reported DER was 10.6%, compared with 31.7% for streaming Sortformer, approximately a threefold difference.
- The echo recording produced no phantom speakers.
- Post-stop processing remained unchanged: `/diarize` processed 54 seconds in 239 ms with the expected speakers.

## Performance

- Live text feed: **15 ms median**, without waiting for concurrent diarization.
- ASR feed measured **27 ms** alone and **29 ms** with full diarization running in parallel: a two-millisecond increase. Previously, diarization blocked the feed for approximately 128 ms every two seconds.
- Live diarization: **100 ms** per window on the GPU, approximately 236× real-time throughput. Speaker labels appeared in approximately one to two seconds.
- GPU diarization measured **127 ms**, compared with **284 ms** on the ANE; embeddings were identical at cosine similarity 1.0.

Both live and post-stop processing were covered. Processing remained local: ANE for transcription, GPU/Metal for diarization, and Metal for Ollama, without CUDA. Avoiding a redundant Whisper load freed approximately 1–3 GB.

## Architecture under evaluation

Two sidecars use separate M5 compute units: transcription on the ANE and diarization on the GPU. Voice RAG supplies conservative naming from saved voices; embedding reconciliation and hysteresis stabilize rolling-window diarization. These measurements describe the tested hardware and recordings, rather than a performance guarantee for every Mac.

## Limitation

The echo recording under-counts a distinct secondary speaker with approximately five seconds of speech. That voice does not match a saved speaker (cosine similarity below 0.1), but has insufficient airtime for its own live label. Increasing sensitivity could reintroduce phantom speakers in the other recordings, so the selected configuration prioritized zero phantom speakers. Enrollment was proposed for known voices.

## Reproduce

```sh
cd eval_diar
../.venv/bin/python3 live_bench.py   # The transcription server must be warm on port 5002.
../.venv/bin/python3 build_cache.py && ../.venv/bin/python3 sweep.py  # Retune the configuration.
```
