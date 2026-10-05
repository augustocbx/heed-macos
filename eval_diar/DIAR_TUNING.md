# Live diarization with the offline engine — tuning on three recordings

Historical upstream evaluation of the following hypothesis: running the offline `performCompleteDiarization` engine over a rolling window, with embedding reconciliation and conservative naming, can provide post-stop quality during live capture. The offline engine's reported DER was 10.6%. Evaluation used three recent recordings from Junior, with the actual full post-stop result as ground truth, including the spurious-speaker filter of at least three seconds and 12% of speech.

## Selected configuration and results

```text
W=30 STEP=2 MERGE=0.55 RECON=0.55 CONSOLIDATE=0.5
NAME(thr=0.62 margin=0.08 mindur=4) filter(3s,12%)

recording (system)         GT  live  phantom  churn   naming
342s (3→2 after filtering)  2    2      0      2/85   Learn 0.925 (others generic)
86s  (1 speaker)           1    1      0      0/19   Learn 0.957
53s  (2 speakers)          2    1      0      0/27   Learn 0.968 (misses one 5s speaker)

TOTAL phantom: 0   (target: 0)
```

## Improvements over the observed speaker-label bug

- **Phantom speakers:** zero across the three recordings, avoiding one speaker being split into multiple labels.
- **Incorrect name assignment:** raising the threshold from 0.5 to 0.62, requiring a top-one/top-two margin of 0.08, and requiring four seconds of speech prevented the incorrect assignment of “Learn” to another speaker whose similarity was approximately 0.52. In the 342-second recording, only the matching voice received that name; other voices remained `Speaker N`.
- **Label churn:** zero to two changes across 19–85 evaluation ticks.

## Design

1. **Windowed offline engine:** global clustering over a 30-second window avoids the over-splitting observed with streaming Sortformer.
2. **Embedding reconciliation:** sidecar speaker IDs can change between runs. A session registry instead compares 256-dimensional voiceprints by cosine similarity; the measured same-voice similarity was approximately 0.7 or higher, versus approximately zero for different voices.
3. **Registry consolidation and real airtime:** merge accidental splits, accumulate speech time only for active ticks, and apply the same three-second/12% spurious-speaker filter used after stopping.
4. **Conservative naming:** apply threshold, margin, and minimum duration to each speaker's accumulated embedding.

## Limitation

The 53-second recording loses a secondary speaker with approximately five seconds of speech, representing 14.8% of speech time. A cosine similarity of 0.051 indicates a distinct voice. The rolling window has less context than full-file processing and absorbs that speaker into another cluster. The configuration was not adjusted specifically for this outlier, since doing so could reintroduce phantom speakers in the other recordings. Enrollment and hardware-specific window/cadence tuning were proposed follow-up work.

## Production integration recorded at the time

`transcription_server.py` used the `/diar/live` endpoint and session registry with `eval_diar/reconcile.py`:

```text
merge_within_window(0.55)
Registry(recon=0.55).update
consolidate(0.5)
name_speakers(thr=0.62, margin=0.08, mindur=4)
```

The configuration used real airtime, the three-second/12% filter, a 30-second window, and a two-second cadence, with cadence intended to be adjustable by hardware.

## Reproduce

```sh
cd eval_diar
python3 exp_window.py <rec.wav> 30 3  # Check window over-splitting.
python3 simulate.py --all           # Evaluate all three; configure W, STEP, RECON, etc. through the environment.
```
