# Real-time echo tuning — historical upstream report

Evaluation for Junior across all twelve recent recordings. The results changed the original expectation formed from a single sample; the selected configuration was based on aggregate measurements.

## Task 1 — cold start (`d699298`)

**Observed:** transcription was already warm, with first text after approximately 0.8 seconds. Two other effects looked like cold start: recording during background prewarming caused contention, and Sortformer's confirmation delay made diarization take approximately 5.5 seconds on every recording.

**Changes:**

- The sidecar's live diarization feed returns tentative and finalized segments, reducing first-speaker appearance to approximately **3.6 seconds**. `heed-parakeet` was rebuilt; `heed-syscap` and ScreenCaptureKit capture were unchanged.
- Synchronous prewarming and a `warm` flag in `/health` make the live transcription loop wait before feeding audio. The recorder continues capturing during prewarming.
- New measurements: `warm=True` after startup, first text after approximately 0.8 seconds, and diarization after approximately 3.6 seconds.

## Task 2 — adaptive AEC (`caf4cba`, subsequently disabled by default)

Adaptive acoustic echo cancellation runs only when the microphone/system energy ratio indicates actual leakage. Aggregate evaluation showed that it removed too much of the user's voice. The implementation was retained, but disabled by default.

## Task 3 — evaluation harness and text deduplication (`c0edc40`)

The `eval_echo/` harness measures:

- **echo_in_mic:** other participants' words leaking into the microphone transcript; lower is better.
- **junior_kept:** preserved words from the user's voice; higher is better.
- **score:** preserved fraction × (1 − echo fraction).

Average results over eight samples containing echo:

| Configuration | Echo | User voice preserved | Score |
|---|---|---|---|
| Baseline | 0.111 | 0.798 | 0.685 |
| Energy gate, layer 1 | 0.051 | 0.612 | 0.627 |
| Gate plus adaptive AEC, layers 1–2 | 0.057 | 0.522 | 0.607 |
| Gate plus always-on AEC | 0.058 | 0.513 | 0.595 |
| **Text deduplication only, layer 3** | **0.000** | **0.770** | **0.730** |

The gate and AEC appeared useful on one sample, but across the twelve recordings removed more of the user's voice than justified by echo reduction. Text deduplication performed best: the clean system-channel transcript identifies words leaking into the microphone transcript, which can be removed without modifying the recorded audio. Echo approached zero while approximately 97% of the baseline preserved user voice remained.

Qualitative checks removed the other speaker's “Matthew seven seven” while preserving the user's statements about recording, screen brightness, and the mouse. A threshold sweep from 0.50 to 0.80 selected **0.63**.

## Configuration selected at the time

- **Layer 3, text deduplication: enabled.** Applied to live microphone turns against the partial system transcript, and after stopping against the final system transcript, using threshold 0.63.
- **Layer 1, gate, and layer 2, AEC: disabled by default.** Environment settings `HEED_MIC_GATE_RMS` and `HEED_AEC_MODE` remain available for experiments with severe speaker echo.
- Cold-start improvements: synchronous warming and tentative diarization segments.

These are historical evaluation results, not a current guarantee that every recording will produce the same scores.

## Reproduce or retune

```sh
cd eval_echo
python3 build_cache.py                         # Cache ground truth once.
bash restart_and_run.sh 0 off my-config dedup  # Run one configuration across all twelve samples.
python3 sweep_dedup.py                         # Sweep the deduplication threshold.
```

Add recordings to `samples.txt` and rerun to expand the evaluation set.

## Remaining limitation

The best aggregate score was **0.73**, with zero measured echo and 0.77 preservation. Two outliers reduce average preservation; the configuration was not tuned specifically to those samples. In recordings without other participants' voices, deduplication left the transcript unchanged, with preservation scores of 0.83–0.97. Physical live tests are still needed to confirm both echo removal and preservation of the user's voice in a given setup.
